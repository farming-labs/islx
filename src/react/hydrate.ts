/**
 * @farmjs/islx/react/client: hydrating a page's islands. Each island is its own React root,
 * started when its strategy says. A root that fails restores the island's server HTML, so a broken
 * component never blanks the page.
 */
import * as React from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { createServerReference } from "../client/actions";
import { emit } from "../client/hooks";
import type { IslandStrategy, scheduleHydration } from "../client/schedule";
import { getValueStore, type ValueStore } from "../client/value-store";
import { NOT_A_VALUE, decode, decodeTagged } from "../protocol/codec";
import {
  ACTION_TAG,
  HYDRATED_ATTRIBUTE,
  FORM_STATE_SCRIPT_TYPE,
  ISLAND_ELEMENT,
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
   * Schedules hydration. Default: `scheduleHydration`, loaded on first use, so a framework that
   * passes its own scheduler ships none of it.
   */
  schedule?: typeof scheduleHydration;
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

/** Turns travelled props back into values: slots keep their server HTML, actions become callable. */
function revive(value: unknown, container: Element): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const revived = value.map((entry) => {
      const next = revive(entry, container);
      if (next !== entry) changed = true;
      return next;
    });
    return changed ? revived : value;
  }
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const tag = getTag(object);
  if (tag === ACTION_TAG && typeof object[TAG_VALUE] === "string") {
    const token = object[TAG_BOUND];
    return createServerReference(object[TAG_VALUE], typeof token === "string" ? token : undefined);
  }
  if (tag === SLOT_TAG && typeof object[TAG_VALUE] === "string") {
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
  if (tag === REFERENCE_TAG)
    throw new Error(`islx value ${String(object[TAG_VALUE])} was not resolved`);
  if (tag !== undefined) {
    const decoded = decodeTagged(object, (child) => revive(child, container));
    if (decoded !== NOT_A_VALUE) return decoded;
  }
  let changed = false;
  const revived: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object)) {
    const next = revive(entry, container);
    // defineProperty: a "__proto__" key stays an ordinary property.
    Object.defineProperty(revived, key, {
      value: next,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    if (next !== entry) changed = true;
  }
  return changed ? revived : value;
}

/** The hydration runtime for one page. */
export function createHydrationRuntime(options: HydrationOptions) {
  const roots = new Map<Element, RootRecord>();
  const pending = new Map<Element, AbortController>();
  const values = options.values ?? getValueStore();
  const schedule: typeof scheduleHydration =
    options.schedule ??
    ((scheduleOptions) =>
      import("../client/schedule").then((module) => module.scheduleHydration(scheduleOptions)));
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
    if (text.includes(`"${TAG}":"${REFERENCE_TAG}"`)) {
      values.ingest(container.ownerDocument);
      parsed = values.resolve(parsed);
    }
    return revive(parsed, container) as Record<string, unknown>;
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
    const candidates = Array.from(scope.querySelectorAll<Element>(ISLAND_SELECTOR));
    if (scope instanceof Element && scope.matches(ISLAND_SELECTOR)) candidates.unshift(scope);
    const islands = candidates.filter(
      (container) =>
        !roots.has(container) &&
        !pending.has(container) &&
        !container.parentElement?.closest(ISLAND_SELECTOR),
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
  function dispose(scope: Node): void {
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
