/**
 * @farm.js/islx/react/client: hydrating a page's islands. Each island is its own React root,
 * started when its strategy says. A root that fails restores the island's server HTML, so a broken
 * component never blanks the page.
 */
import * as React from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { createServerReference } from "../client/actions";
import { emit } from "../client/hooks";
import type { IslandStrategy, scheduleHydration } from "../client/schedule";
import { getValueStore, type ValueStore } from "../client/value-store";
import { NOT_A_VALUE, decode, decodeTagged, setOwn } from "../protocol/codec";
import {
  ACTION_TAG,
  HYDRATED_ATTRIBUTE,
  FORM_STATE_SCRIPT_TYPE,
  ISLAND_ELEMENT,
  PROMISE_SCRIPT_TYPE,
  PROMISE_TAG,
  PROPS_SCRIPT_TYPE,
  REFERENCE_TAG,
  SLOT_ELEMENT,
  SLOT_TAG,
  TAG,
  TAG_BOUND,
  TAG_VALUE,
  getTag,
} from "../protocol/wire";
import { getContexts } from "./island";
import { updateServerTrees } from "./tree";

const ISLAND_SELECTOR = `${ISLAND_ELEMENT}[src]`;

export interface HydrationOptions {
  /** Imports an island's module: `(src) => import(src)` with the bundler's URL. */
  load(src: string): Promise<Record<string, unknown>>;
  /** Wraps each island's element, as for providers every island needs. */
  wrap?(element: React.ReactElement): React.ReactNode;
  /** Reports an island that failed. Default `console.error`. */
  report?(message: string, error?: unknown): void;
  /** The value store. Default: the page's. */
  values?: ValueStore;
  /**
   * When each island hydrates: `scheduleHydration` (its strategy), or the framework's own. Required,
   * so a framework with its own scheduler ships none of islx's.
   */
  schedule: typeof scheduleHydration;
}

interface RootRecord {
  root: Root;
  Component: React.ComponentType<any>;
  src: string;
  exportName: string;
  props: Record<string, unknown>;
  serverHTML: string;
  restore(error: unknown): void;
  dispose(): void;
}

function isEarlyUpdate(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith("This root received an early update") ||
      error.message.startsWith("Minified React error #424;"))
  );
}

function findPropsScript(container: Element, id: string): HTMLScriptElement | null {
  const sibling = container.nextElementSibling;
  if (
    sibling instanceof HTMLScriptElement &&
    sibling.type === PROPS_SCRIPT_TYPE &&
    sibling.getAttribute("for") === id
  ) {
    return sibling;
  }
  for (const script of container.ownerDocument.querySelectorAll<HTMLScriptElement>(
    `script[type="${PROPS_SCRIPT_TYPE}"]`,
  )) {
    if (script.getAttribute("for") === id) return script;
  }
  return null;
}

/** React's form state after a `useActionState` form post, if the page carries one. */
function readFormState(document: Document): unknown {
  const script = document.querySelector(`script[type="${FORM_STATE_SCRIPT_TYPE}"]`);
  if (!script) return undefined;
  try {
    return decode(JSON.parse(script.textContent || "null"));
  } catch {
    return undefined;
  }
}

/**
 * Revived values, by the object the value store resolved. Islands that share a value (one sent
 * once for several islands) then share the revived object instead of walking it again. A value
 * with a slot is not kept: a slot's HTML belongs to one island.
 */
const revivedValues = new WeakMap<object, unknown>();
let slotsRevived = 0;

/** Turns travelled props back into values: slots keep their server HTML, actions become callable. */
function revive(value: unknown, container: Element, values: ValueStore): unknown {
  if (value && typeof value === "object") {
    const cached = revivedValues.get(value);
    if (cached !== undefined) return cached;
    const slotsBefore = slotsRevived;
    const revived = reviveUncached(value, container, values);
    if (slotsRevived === slotsBefore) revivedValues.set(value, revived);
    return revived;
  }
  return value;
}

function reviveUncached(value: object, container: Element, values: ValueStore): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const revived = value.map((entry) => {
      const next = revive(entry, container, values);
      if (next !== entry) changed = true;
      return next;
    });
    return changed ? revived : value;
  }
  const object = value as Record<string, unknown>;
  const tag = getTag(object);
  if (tag === ACTION_TAG && typeof object[TAG_VALUE] === "string") {
    const token = object[TAG_BOUND];
    return createServerReference(object[TAG_VALUE], typeof token === "string" ? token : undefined);
  }
  if (tag === SLOT_TAG && typeof object[TAG_VALUE] === "string") {
    slotsRevived++;
    const name = object[TAG_VALUE];
    let html = "";
    for (const slot of container.querySelectorAll(SLOT_ELEMENT)) {
      if (slot.getAttribute("name") === name) {
        html = slot.innerHTML;
        break;
      }
    }
    return React.createElement(SLOT_ELEMENT, {
      key: name,
      name,
      style: { display: "contents" },
      suppressHydrationWarning: true,
      dangerouslySetInnerHTML: { __html: html },
    });
  }
  if (tag === PROMISE_TAG && typeof object[TAG_VALUE] === "string") {
    return islandPromise(object[TAG_VALUE], container, values);
  }
  if (tag === REFERENCE_TAG)
    throw new Error(`islx value ${String(object[TAG_VALUE])} was not resolved`);
  if (tag !== undefined) {
    const decoded = decodeTagged(object, (child) => revive(child, container, values));
    if (decoded !== NOT_A_VALUE) return decoded;
  }
  let changed = false;
  const revived: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object)) {
    const next = revive(entry, container, values);
    setOwn(revived, key, next);
    if (next !== entry) changed = true;
  }
  return changed ? revived : value;
}

type IslandThenable = Promise<unknown> & {
  status?: "pending" | "fulfilled" | "rejected";
  value?: unknown;
  reason?: unknown;
};

// Promises whose outcome has not arrived, by name; one observer watches the page for them.
const pendingPromises = new Map<
  string,
  {
    thenable: IslandThenable;
    container: Element;
    values: ValueStore;
    settle(script: Element): void;
  }
>();
let promiseObserver: MutationObserver | null = null;

function findPromiseScript(document: Document, name: string): Element | null {
  for (const script of document.querySelectorAll(`script[type="${PROMISE_SCRIPT_TYPE}"]`)) {
    if (script.getAttribute("name") === name) return script;
  }
  return null;
}

function readOutcome(
  script: Element,
  container: Element,
  values: ValueStore,
): { ok: true; value: unknown } | { ok: false; reason: unknown } {
  try {
    const text = script.textContent || "{}";
    let parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !("v" in parsed)) {
      return { ok: false, reason: new Error("islx: the promise rejected on the server") };
    }
    if (text.includes(`"${TAG}":"${REFERENCE_TAG}"`)) {
      values.ingest(container.ownerDocument);
      parsed = values.resolve(parsed);
    }
    return { ok: true, value: (revive(parsed, container, values) as { v: unknown }).v };
  } catch (reason) {
    return { ok: false, reason };
  }
}

/**
 * The promise an island received, as a thenable React's `use` reads: settled already when its
 * outcome is on the page, so hydration does not suspend, and settled when the outcome streams in
 * otherwise.
 */
function islandPromise(name: string, container: Element, values: ValueStore): IslandThenable {
  const pending = pendingPromises.get(name);
  if (pending) return pending.thenable;
  const document = container.ownerDocument;
  const script = findPromiseScript(document, name);
  if (script) {
    const outcome = readOutcome(script, container, values);
    const thenable: IslandThenable = outcome.ok
      ? Promise.resolve(outcome.value)
      : Promise.reject(outcome.reason);
    if (outcome.ok) Object.assign(thenable, { status: "fulfilled", value: outcome.value });
    else {
      thenable.catch(() => {});
      Object.assign(thenable, { status: "rejected", reason: outcome.reason });
    }
    return thenable;
  }
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const thenable: IslandThenable = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  thenable.catch(() => {});
  thenable.status = "pending";
  pendingPromises.set(name, {
    thenable,
    container,
    values,
    settle(found) {
      pendingPromises.delete(name);
      const outcome = readOutcome(found, container, values);
      if (outcome.ok) {
        Object.assign(thenable, { status: "fulfilled", value: outcome.value });
        resolve(outcome.value);
      } else {
        Object.assign(thenable, { status: "rejected", reason: outcome.reason });
        reject(outcome.reason);
      }
    },
  });
  if (!promiseObserver && typeof MutationObserver === "function") {
    promiseObserver = new MutationObserver(() => {
      for (const [pendingName, entry] of pendingPromises) {
        const found = findPromiseScript(entry.container.ownerDocument, pendingName);
        if (found) entry.settle(found);
      }
      if (pendingPromises.size === 0) {
        promiseObserver?.disconnect();
        promiseObserver = null;
      }
    });
    promiseObserver.observe(document, { childList: true, subtree: true });
  }
  return thenable;
}

/**
 * React streams Suspense content that resolves late into a hidden `<div id="S:n">`, then moves it
 * into place. Its islands hydrate once moved, not while staged.
 */
const STREAM_STAGING = 'div[hidden][id^="S:"]';

const PENDING_BOUNDARY = "$?";

/**
 * Whether React still streams Suspense content into `container`. React waits for such a boundary
 * only while the document loads; later (a navigation that streams) it would render it again in
 * the browser, so the island hydrates once React has revealed it.
 */
function awaitsStreamedContent(container: Element): boolean {
  const document = container.ownerDocument;
  if (document.readyState === "loading") return false;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_COMMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node as Comment).data === PENDING_BOUNDARY) return true;
  }
  return false;
}

/**
 * Marks the Suspense boundaries under `root` that still wait once their stream has ended (the
 * connection dropped) as rendered in the browser, as React does when it finds one: the next
 * `hydrate()` pass starts their islands. Call it when a stream that filled `root` ends.
 */
export function endStreamedContent(root: ParentNode): void {
  // A document from another window is not `instanceof Document` here.
  const node = root as Node;
  const document = node.nodeType === 9 ? (node as Document) : node.ownerDocument!;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_COMMENT);
  for (let comment = walker.nextNode(); comment; comment = walker.nextNode()) {
    if ((comment as Comment).data === PENDING_BOUNDARY) (comment as Comment).data = "$!";
  }
}

/** The hydration runtime for one page. */
export function createHydrationRuntime(options: HydrationOptions) {
  const roots = new Map<Element, RootRecord>();
  const pending = new Map<Element, AbortController>();
  const values = options.values ?? getValueStore();
  const schedule = options.schedule;
  const report =
    options.report ??
    ((message: string, error?: unknown) => console.error(`[islx] ${message}`, error));
  let formState: unknown;
  let formStateRead = false;

  const fail = (
    container: Element,
    src: string,
    exportName: string,
    serverHTML: string,
    error: unknown,
  ) => {
    report(`Could not hydrate ${exportName} (${src}). Its server HTML was restored.`, error);
    emit("islandError", { element: container, src, export: exportName, error });
    queueMicrotask(() => {
      try {
        roots.get(container)?.root.unmount();
      } catch {
        // React may have detached a root that failed while hydrating.
      }
      roots.delete(container);
      container.removeAttribute(HYDRATED_ATTRIBUTE);
      container.innerHTML = serverHTML;
    });
  };

  class Boundary extends React.Component<
    { children?: React.ReactNode; onError(error: unknown): void },
    { failed: boolean }
  > {
    state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    componentDidCatch(error: unknown) {
      this.props.onError(error);
    }
    render() {
      return this.state.failed ? null : this.props.children;
    }
  }

  /** Calls `onCommit` once, when React first commits the island: it is interactive then. */
  function Committed({ onCommit, children }: { onCommit?: () => void; children: React.ReactNode }) {
    const called = React.useRef(false);
    React.useLayoutEffect(() => {
      if (called.current || !onCommit) return;
      called.current = true;
      onCommit();
    }, [onCommit]);
    return children as React.ReactElement;
  }

  const element = (
    Component: React.ComponentType<any>,
    props: Record<string, unknown>,
    restore: (error: unknown) => void,
    onCommit?: () => void,
  ) => {
    const { graph } = getContexts();
    const inner = React.createElement(Component, props);
    return React.createElement(
      graph.Provider,
      { value: true },
      React.createElement(
        Boundary,
        { onError: restore },
        React.createElement(Committed, {
          onCommit,
          children: options.wrap ? options.wrap(inner) : inner,
        }),
      ),
    );
  };

  /** An island's props, with values, slots and actions revived. */
  function readProps(container: Element, id: string): Record<string, unknown> {
    const script = findPropsScript(container, id);
    if (!script) throw new Error(`props ${id} were not found`);
    const text = script.textContent || "{}";
    let parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("props must be an object");
    // No tag anywhere: plain JSON, nothing to resolve or revive.
    if (!text.includes(`"${TAG}"`)) return parsed as Record<string, unknown>;
    if (text.includes(`"${TAG}":"${REFERENCE_TAG}"`)) {
      values.ingest(container.ownerDocument);
      parsed = values.resolve(parsed);
    }
    return revive(parsed, container, values) as Record<string, unknown>;
  }

  const topLevel = (scope: ParentNode) =>
    Array.from(scope.querySelectorAll<Element>(ISLAND_SELECTOR)).filter(
      (container) => !container.parentElement?.closest(ISLAND_SELECTOR),
    );
  const keyOf = (container: Element) =>
    `${container.getAttribute("src")}#${container.getAttribute("export") || "default"}`;

  /** Hydrates the islands under `scope` that are not hydrated or scheduled yet. */
  async function hydrate(scope: ParentNode = document, signal?: AbortSignal): Promise<void> {
    if (!formStateRead) {
      formStateRead = true;
      formState = readFormState(
        scope instanceof Document ? scope : ((scope as Element).ownerDocument ?? document),
      );
    }
    if (scope instanceof Document) watchStream(scope);
    const candidates = Array.from(scope.querySelectorAll<Element>(ISLAND_SELECTOR));
    if (scope instanceof Element && scope.matches(ISLAND_SELECTOR)) candidates.unshift(scope);
    const islands = candidates.filter(
      (container) =>
        !roots.has(container) &&
        !pending.has(container) &&
        !container.parentElement?.closest(ISLAND_SELECTOR) &&
        !container.closest(STREAM_STAGING) &&
        !awaitsStreamedContent(container),
    );

    await Promise.all(
      islands.map(async (container) => {
        const src = container.getAttribute("src");
        const id = container.getAttribute("props");
        const exportName = container.getAttribute("export") || "default";
        const strategy = (container.getAttribute("strategy") as IslandStrategy | null) ?? "load";
        if (!src || !id) {
          report("An island is missing its src or props id.");
          return;
        }
        const controller = new AbortController();
        pending.set(container, controller);
        const release = () => {
          if (pending.get(container) === controller) pending.delete(container);
        };
        // An aborted pass never hydrates this island: stop reserving it as soon as it aborts.
        controller.signal.addEventListener("abort", release, { once: true });
        const abort = () => controller.abort();
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
        const cleanup = () => {
          signal?.removeEventListener("abort", abort);
          release();
        };

        let scheduled: Promise<unknown>;
        try {
          const scheduledAt = performance.now();
          scheduled = schedule({
            container,
            strategy,
            signal: controller.signal,
            hydrate: async () => {
              if (controller.signal.aborted || !container.isConnected) return;
              const serverHTML = container.innerHTML;
              try {
                const module = await options.load(src);
                if (controller.signal.aborted || !container.isConnected) return;
                const Component = module[exportName];
                if (
                  typeof Component !== "function" &&
                  (typeof Component !== "object" || Component === null)
                ) {
                  throw new Error(`${src} has no export ${exportName}`);
                }
                const props = readProps(container, id);
                let failure: unknown;
                const restore = (error: unknown) => {
                  if (failure !== undefined) return;
                  failure = error;
                  fail(container, src, exportName, serverHTML, error);
                  controller.abort();
                };
                let disposing = false;
                const onCommit = () =>
                  emit("hydrate", {
                    element: container,
                    src,
                    export: exportName,
                    strategy,
                    duration: performance.now() - scheduledAt,
                  });
                const root = hydrateRoot(
                  container,
                  element(Component as React.ComponentType<any>, props, restore, onCommit),
                  {
                    formState: formState as never,
                    onUncaughtError: restore,
                    onRecoverableError(error) {
                      // Unmounting a root before its first commit reports an early update.
                      if (disposing && isEarlyUpdate(error)) return;
                      if (typeof globalThis.reportError === "function")
                        globalThis.reportError(error);
                      else console.error(error);
                    },
                  },
                );
                roots.set(container, {
                  root,
                  Component: Component as React.ComponentType<any>,
                  src,
                  exportName,
                  props,
                  serverHTML,
                  restore,
                  dispose() {
                    disposing = true;
                    try {
                      root.unmount();
                    } finally {
                      disposing = false;
                    }
                  },
                });
              } catch (error) {
                if (controller.signal.aborted) return;
                fail(container, src, exportName, serverHTML, error);
                controller.abort();
              }
            },
          });
        } catch (error) {
          fail(container, src, exportName, container.innerHTML, error);
          controller.abort();
          cleanup();
          return;
        }
        const tracked = Promise.resolve(scheduled)
          .catch((error) => {
            if (!controller.signal.aborted) {
              fail(container, src, exportName, container.innerHTML, error);
              controller.abort();
            }
          })
          .finally(cleanup);
        if (strategy === "load") await tracked;
        else void tracked;
      }),
    );
  }

  /**
   * Keeps the live islands of `current` when the same page renders again (after an action, or
   * a refresh): each island of `next` that renders the same component at the same position takes
   * over the live root with its new props, so its state survives. Call it before replacing
   * `current`; islands it does not carry over hydrate from `next` as usual.
   */
  function carryOver(current: ParentNode, next: ParentNode): number {
    const live = new Map<string, Element[]>();
    for (const container of topLevel(current)) {
      if (!roots.has(container)) continue;
      const key = keyOf(container);
      live.set(key, [...(live.get(key) ?? []), container]);
    }
    let carried = 0;
    for (const container of topLevel(next)) {
      const previous = live.get(keyOf(container))?.shift();
      const record = previous && roots.get(previous);
      const id = container.getAttribute("props");
      if (!previous || !record || !id) continue;
      try {
        const props = readProps(container, id);
        record.root.render(element(record.Component, props, record.restore));
        record.props = props;
        container.replaceWith(previous);
        carried++;
      } catch (error) {
        report(`Could not keep ${keyOf(container)} across the refresh.`, error);
      }
    }
    return carried;
  }

  /** Re-renders the islands and server trees of a module that changed (hot module replacement). */
  function update(src: string, module: Record<string, unknown>): number {
    let updated = updateServerTrees(src, module);
    for (const [container, record] of roots) {
      if (record.src !== src) continue;
      const Component = module[record.exportName];
      if (
        typeof Component !== "function" &&
        (typeof Component !== "object" || Component === null)
      ) {
        fail(
          container,
          record.src,
          record.exportName,
          record.serverHTML,
          new Error("the updated module lost the export"),
        );
        continue;
      }
      record.Component = Component as React.ComponentType<any>;
      record.root.render(element(record.Component, record.props, record.restore));
      updated++;
    }
    return updated;
  }

  /** Unmounts the islands inside `scope`, and stops scheduled ones. */
  /**
   * A page still streaming: islands in Suspense content that arrives later hydrate as React puts it
   * in place, and islands React removes (a replaced fallback) are released. Ends once the document
   * is parsed and React has revealed every staged boundary (it may batch reveals past parsing).
   */
  let watching = false;
  function watchStream(document: Document): void {
    if (watching || document.readyState !== "loading" || typeof MutationObserver !== "function") {
      return;
    }
    watching = true;
    const removed = new Set<Node>();
    let queued = false;
    const run = () => {
      queued = false;
      for (const node of removed) if (!node.isConnected) dispose(node);
      removed.clear();
      if (document.readyState !== "loading" && !document.querySelector(STREAM_STAGING)) {
        observer.disconnect();
        watching = false;
        endStreamedContent(document);
      }
      hydrate(document).catch((error) => report("Hydrating streamed islands failed.", error));
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.removedNodes) removed.add(node);
      if (queued) return;
      queued = true;
      queueMicrotask(run);
    });
    observer.observe(document, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", run, { once: true });
  }

  function dispose(scope: Node): void {
    // A promise of an island that left the page no longer waits for its outcome.
    for (const [name, entry] of pendingPromises) {
      if (scope.contains(entry.container)) pendingPromises.delete(name);
    }
    if (pendingPromises.size === 0) {
      promiseObserver?.disconnect();
      promiseObserver = null;
    }
    for (const [container, controller] of pending) {
      if (container === scope || scope.contains(container)) {
        controller.abort();
        pending.delete(container);
      }
    }
    for (const [container, record] of roots) {
      if (container === scope || scope.contains(container)) {
        try {
          record.dispose();
        } catch {
          // The DOM owner may already have removed a failed root.
        }
        roots.delete(container);
        container.removeAttribute(HYDRATED_ATTRIBUTE);
      }
    }
  }

  return { hydrate, carryOver, update, dispose, rootCount: () => roots.size };
}

export type HydrationRuntime = ReturnType<typeof createHydrationRuntime>;

/**
 * A page a hydrating layout keeps as server HTML (and a server tree's `<f-html>` part). React owns
 * only the wrapper, so the islands inside start after React commits that HTML and stop when it is
 * replaced or the layout unmounts. The islands are captured when they start, because React has
 * already swapped the HTML by the time the cleanup runs.
 */
export function createServerHtml(
  runtime: Pick<HydrationRuntime, "hydrate" | "dispose">,
): React.ComponentType<
  Record<string, unknown> & { as?: string; dangerouslySetInnerHTML: { __html: string } }
> {
  return function ServerHtml({ as = "div", ...props }) {
    const ref = React.useRef<HTMLElement>(null);
    const html = props.dangerouslySetInnerHTML.__html;
    React.useLayoutEffect(() => {
      const page = ref.current;
      if (!page) return;
      const islands = Array.from(page.querySelectorAll(ISLAND_SELECTOR));
      if (islands.length === 0) return;
      const controller = new AbortController();
      runtime.hydrate(page, controller.signal).catch((error) => {
        console.error("[islx] Could not hydrate the islands in this part of the page:", error);
      });
      return () => {
        controller.abort();
        // Unmounting another root while this commit runs is not allowed: release them after it.
        queueMicrotask(() => {
          for (const island of islands) runtime.dispose(island);
        });
      };
    }, [html]);
    return React.createElement(as, { ...props, ref });
  };
}
