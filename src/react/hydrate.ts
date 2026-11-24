/**
 * @farm.js/islx/react/client: hydrating a page's islands. Each island is its own React root,
 * started when its strategy says. A root that fails restores the island's server HTML, so a broken
 * component never blanks the page.
 */
import * as React from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { setActionElementReviver } from "../client/element-reviver";
import { emit } from "../client/hooks";
import type { IslandStrategy, scheduleHydration } from "../client/schedule";
import type { ValueStore } from "../client/value-store";
import {
  ID_POSITION_ATTRIBUTE,
  HYDRATED_ATTRIBUTE,
  FORM_STATE_SCRIPT_TYPE,
  ISLAND_ELEMENT,
  PROPS_SCRIPT_TYPE,
  TAG,
} from "../protocol/wire";
import { getContexts } from "./contexts";
import { atIdPosition, parseIdPosition, type IdPosition } from "./ids";
import type { Reviver } from "./revive";
import { captureSlots } from "./slots";
import { updateServerTrees } from "./tree-updates";

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
  /** Where the server rendered the island, kept so every render builds the same tree. */
  position: IdPosition | null;
  root: Root;
  Component: React.ComponentType<any>;
  src: string;
  exportName: string;
  props: Record<string, unknown>;
  /** The props as the server sent them, to find the same island in a later render. */
  wire: string;
  serverHTML: string;
  /** The latest carry-over still waiting for server trees: an older one does not render. */
  carry?: symbol;
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

/** Whether `container` sits inside another island below `scope`. */
function insideAnotherIsland(container: Element, scope: ParentNode): boolean {
  for (let node = container.parentElement; node && node !== scope; node = node.parentElement) {
    if (node.matches(ISLAND_SELECTOR)) return true;
  }
  return false;
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
/**
 * True while the document still streams and the island's props, which the server writes after
 * it, have not arrived: the island waits for them. Hydrating now fails, and restoring its server
 * HTML is a change the stream watcher answers with another pass, which fails again.
 */
function awaitsProps(container: Element): boolean {
  if (container.ownerDocument.readyState !== "loading") return false;
  const id = container.getAttribute("props");
  return !!id && !findPropsScript(container, id);
}

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
  const schedule = options.schedule;
  const report =
    options.report ??
    ((message: string, error?: unknown) => console.error(`[islx] ${message}`, error));
  let formState: unknown;
  let formStateRead = false;
  let formStateLoad: Promise<void> | undefined;

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
    container: Element,
    Component: React.ComponentType<any>,
    props: Record<string, unknown>,
    restore: (error: unknown) => void,
    position: IdPosition | null,
    onCommit?: () => void,
  ) => {
    const { graph, container: containerContext } = getContexts();
    const component = React.createElement(Component, props);
    const inner = (position && atIdPosition(position, component)) || component;
    return React.createElement(
      graph.Provider,
      { value: true },
      React.createElement(
        containerContext.Provider,
        { value: container },
        React.createElement(
          Boundary,
          { onError: restore },
          React.createElement(Committed, {
            onCommit,
            children: options.wrap ? options.wrap(inner) : inner,
          }),
        ),
      ),
    );
  };

  // Renders the server HTML parts of slot trees, and hydrates the islands inside them.
  const ServerHtml = createServerHtml({ hydrate, dispose });

  // Tagged props (slots, actions, promises, dates), a page's form state and elements an action
  // returns need the reviver. It loads with the first of them, so a page of plain props never does.
  let reviver: Reviver | undefined;
  let reviverLoad: Promise<Reviver> | undefined;
  const loadReviver = () =>
    (reviverLoad ??= import("./revive").then(
      ({ createReviver }) =>
        (reviver = createReviver({ load: options.load, ServerHtml, values: options.values })),
      (error: unknown) => {
        // A chunk that failed to load can load on a later call.
        reviverLoad = undefined;
        throw error;
      },
    ));
  setActionElementReviver(async (payload) => (await loadReviver()).reviveElements(payload));

  /** An island's props as the server sent them, parsed. */
  function parseProps(
    container: Element,
    id: string,
  ): { text: string; parsed: Record<string, unknown> } {
    const script = findPropsScript(container, id);
    if (!script) throw new Error(`props ${id} were not found`);
    const text = script.textContent || "{}";
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("props must be an object");
    return { text, parsed: parsed as Record<string, unknown> };
  }

  /** Whether props need the reviver: without a tag anywhere they are plain JSON. */
  const isTagged = (text: string) => text.includes(`"${TAG}"`);

  const topLevel = (scope: ParentNode) =>
    Array.from(scope.querySelectorAll<Element>(ISLAND_SELECTOR)).filter(
      (container) => !container.parentElement?.closest(ISLAND_SELECTOR),
    );
  /**
   * An island's props as the server sent them, without its own id: the names of its slots start
   * with that id, which follows the island's position, so the same item moved keeps the same text.
   */
  const wireOf = (container: Element, id: string) =>
    (findPropsScript(container, id)?.textContent ?? "").split(id).join("");
  const keyOf = (container: Element) =>
    `${container.getAttribute("src")}#${container.getAttribute("export") || "default"}`;

  /** Hydrates the islands under `scope` that are not hydrated or scheduled yet. */
  async function hydrate(scope: ParentNode = document, signal?: AbortSignal): Promise<void> {
    if (!formStateRead) {
      formStateRead = true;
      const page =
        scope instanceof Document ? scope : ((scope as Element).ownerDocument ?? document);
      // Only a page after a form post carries one; reading it needs the reviver.
      if (page.querySelector(`script[type="${FORM_STATE_SCRIPT_TYPE}"]`)) {
        formStateLoad = loadReviver().then(
          (loaded) => {
            formState = loaded.readFormState(page);
          },
          (error) => report("Could not read the form state of the page.", error),
        );
      }
    }
    if (scope instanceof Document) watchStream(scope);
    const candidates = Array.from(scope.querySelectorAll<Element>(ISLAND_SELECTOR));
    if (scope instanceof Element && scope.matches(ISLAND_SELECTOR)) candidates.unshift(scope);
    const islands = candidates.filter(
      (container) =>
        !roots.has(container) &&
        !pending.has(container) &&
        !insideAnotherIsland(container, scope) &&
        !container.closest(STREAM_STAGING) &&
        !awaitsStreamedContent(container) &&
        !awaitsProps(container),
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
                // Props that need the reviver load it beside the island's module, not after it.
                const reviving = isTagged(findPropsScript(container, id)?.textContent ?? "")
                  ? loadReviver()
                  : undefined;
                reviving?.catch(() => {});
                const module = await options.load(src);
                if (controller.signal.aborted || !container.isConnected) return;
                const Component = module[exportName];
                if (
                  typeof Component !== "function" &&
                  (typeof Component !== "object" || Component === null)
                ) {
                  throw new Error(`${src} has no export ${exportName}`);
                }
                const { text, parsed } = parseProps(container, id);
                let props = parsed;
                if (isTagged(text)) {
                  const loaded = await (reviving ?? loadReviver());
                  const resolved = loaded.resolve(text, parsed, [container.ownerDocument]);
                  await loaded.prepare(container, resolved, text);
                  if (controller.signal.aborted || !container.isConnected) return;
                  props = loaded.revive(resolved, container);
                }
                if (formStateLoad) {
                  await formStateLoad;
                  if (controller.signal.aborted || !container.isConnected) return;
                }
                const position = parseIdPosition(
                  findPropsScript(container, id)?.getAttribute(ID_POSITION_ATTRIBUTE),
                );
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
                  element(
                    container,
                    Component as React.ComponentType<any>,
                    props,
                    restore,
                    position,
                    onCommit,
                  ),
                  {
                    formState: formState as never,
                    ...(position ? { identifierPrefix: position.prefix } : {}),
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
                  position,
                  root,
                  Component: Component as React.ComponentType<any>,
                  src,
                  exportName,
                  props,
                  wire: wireOf(container, id),
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
   * a refresh): each island of `next` takes over a live root of the same component with its new
   * props, so its state survives. React keeps state by key, which the browser never sees: an
   * island whose props are unchanged takes the live island with those props first (an item that
   * stays in a list while others are removed or move), and the rest pair up in document order.
   * Call it before replacing `current`; islands it does not carry over hydrate from `next` as usual.
   */
  function carryOver(current: ParentNode, next: ParentNode): number {
    const live = new Map<string, Element[]>();
    for (const container of topLevel(current)) {
      if (!roots.has(container)) continue;
      const key = keyOf(container);
      live.set(key, [...(live.get(key) ?? []), container]);
    }
    const incoming = topLevel(next).map((container) => {
      const id = container.getAttribute("props");
      return { container, id, wire: id ? wireOf(container, id) : "" };
    });
    const pairs = new Map<Element, Element>();
    const take = (key: string, matches: (previous: Element) => boolean) => {
      const candidates = live.get(key);
      const index = candidates ? candidates.findIndex(matches) : -1;
      return index < 0 ? undefined : candidates!.splice(index, 1)[0];
    };
    for (const { container, wire } of incoming) {
      const previous = take(keyOf(container), (candidate) => roots.get(candidate)?.wire === wire);
      if (previous) pairs.set(container, previous);
    }
    for (const { container } of incoming) {
      if (pairs.has(container)) continue;
      const previous = take(keyOf(container), () => true);
      if (previous) pairs.set(container, previous);
    }
    let carried = 0;
    for (const { container, id, wire } of incoming) {
      const previous = pairs.get(container);
      const record = previous && roots.get(previous);
      if (!previous || !record || !id) continue;
      const failed = (error: unknown) =>
        report(`Could not keep ${keyOf(container)} across the refresh.`, error);
      const show = (props: Record<string, unknown>) => {
        record.root.render(
          element(previous, record.Component, props, record.restore, record.position),
        );
        record.props = props;
        record.wire = wire;
      };
      try {
        const { text, parsed } = parseProps(container, id);
        const props = carriedProps(container, text, parsed, previous);
        if (!(props instanceof Promise)) {
          record.carry = undefined;
          show(props);
          container.replaceWith(previous);
          carried++;
          continue;
        }
        // The reviver loads, or server trees in the props rebuild (their client modules load): the
        // live island keeps its place now and takes its new props once they are ready. Its slots
        // are found before it leaves the page it came in.
        captureSlots(container);
        const turn = Symbol("carry");
        record.carry = turn;
        container.replaceWith(previous);
        carried++;
        props.then((ready) => {
          if (record.carry !== turn || roots.get(previous) !== record) return;
          show(ready);
        }, failed);
      } catch (error) {
        failed(error);
      }
    }
    return carried;
  }

  /**
   * An island's new props for a carry-over: at once when nothing in them waits (plain props, or
   * tagged ones without server trees once the reviver has loaded), else once the reviver has
   * loaded and their server trees are rebuilt. Their values are on the page they came in, or on
   * this one once that page's content has replaced it.
   */
  function carriedProps(
    container: Element,
    text: string,
    parsed: Record<string, unknown>,
    previous: Element,
  ): Record<string, unknown> | Promise<Record<string, unknown>> {
    if (!isTagged(text)) return parsed;
    const finish = (loaded: Reviver) => {
      const resolved = loaded.resolve(text, parsed, [
        container.ownerDocument,
        previous.ownerDocument,
      ]);
      const preparing = loaded.prepare(container, resolved);
      const revived = () => loaded.revive(resolved, container);
      return preparing ? preparing.then(revived) : revived();
    };
    return reviver ? finish(reviver) : loadReviver().then(finish);
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
      record.root.render(
        element(container, record.Component, record.props, record.restore, record.position),
      );
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
    if (watching || typeof MutationObserver !== "function") return;
    // React batches reveals, so staged content can still wait once the document is parsed.
    if (document.readyState !== "loading" && !document.querySelector(STREAM_STAGING)) return;
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
    reviver?.release(scope);
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
