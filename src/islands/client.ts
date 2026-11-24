/**
 * @farm.js/islx/islands/client: hydrating islands with any renderer. Each island is its own root,
 * started when its strategy says, through the one function a renderer gives: `hydrate`. A root
 * that throws restores the island's server HTML, so a broken component never blanks the page.
 *
 * The wire format is the one `@farm.js/islx/react` uses. What React's runtime adds on top (slots,
 * promise props, server trees, form state) is not part of it yet.
 */
import { emit } from "../client/hooks";
import type { IslandStrategy, scheduleHydration } from "../client/schedule";
import { getValueStore, type ValueStore } from "../client/value-store";
import { decode } from "../protocol/codec";
import {
  ACTION_TAG,
  HYDRATED_ATTRIBUTE,
  ISLAND_ELEMENT,
  PROPS_SCRIPT_TYPE,
  REFERENCE_TAG,
  TAG,
} from "../protocol/wire";

export { scheduleHydration, type IslandStrategy } from "../client/schedule";

const ISLAND_SELECTOR = `${ISLAND_ELEMENT}[src]`;

/** What an island root returns, so the runtime can take it down again. */
export interface IslandRoot {
  unmount(): void;
}

/** The island being hydrated, as its `<f-island>` names it. */
export interface IslandContext {
  /**
   * The island's id, unique within the response. A renderer whose hydration keys are page-wide
   * (Solid's `renderId`) namespaces them with it, on the server and here.
   */
  id: string;
  src: string;
  export: string;
  strategy: IslandStrategy;
}

/**
 * A renderer's side of the protocol. `hydrate` attaches `component`, rendered with `props`, to the
 * HTML the server wrote for it inside `container`, keeping that DOM. It throws when it cannot.
 */
export interface IslandRenderer {
  hydrate(
    container: Element,
    component: unknown,
    props: Record<string, unknown>,
    island: IslandContext,
  ): IslandRoot | void;
}

/** Declares a renderer's side of the protocol, typed. */
export function defineIslandRenderer<const T extends IslandRenderer>(renderer: T): T {
  return renderer;
}

export interface IslandRuntimeOptions {
  renderer: IslandRenderer;
  /** Imports an island's module: `(src) => import(src)` with the bundler's URL. */
  load(src: string): Promise<Record<string, unknown>>;
  /**
   * When each island hydrates: `scheduleHydration` (its strategy), or the framework's own. Required,
   * so a framework with its own scheduler ships none of islx's.
   */
  schedule: typeof scheduleHydration;
  /** The value store. Default: the page's. */
  values?: ValueStore;
  /** Reports an island that failed. Default `console.error`. */
  report?(message: string, error?: unknown): void;
}

export interface IslandRuntime {
  /** Hydrates the islands under `scope` that are not hydrated or scheduled yet. */
  hydrate(scope?: ParentNode): Promise<void>;
  /**
   * Unmounts the islands under `scope` (default: every island) and drops the ones under it still
   * waiting for their strategy. A framework that swaps part of the page disposes that part, and
   * the islands outside it keep running. Islands already removed from the document go too.
   */
  dispose(scope?: ParentNode): void;
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

/** Whether `container` sits inside another island below `scope`: that island owns it. */
function insideAnotherIsland(container: Element, scope: ParentNode): boolean {
  for (let node = container.parentElement; node && node !== scope; node = node.parentElement) {
    if (node.matches(ISLAND_SELECTOR)) return true;
  }
  return false;
}

/** While the document streams, an island whose props script has not arrived waits for it. */
function awaitsProps(container: Element): boolean {
  if (container.ownerDocument.readyState !== "loading") return false;
  const id = container.getAttribute("props");
  return !!id && !findPropsScript(container, id);
}

async function readProps(
  container: Element,
  id: string,
  values: ValueStore,
): Promise<Record<string, unknown>> {
  const script = findPropsScript(container, id);
  if (!script) throw new Error(`the island's props script (for="${id}") is missing`);
  const text = script.textContent || "{}";
  let parsed: unknown = JSON.parse(text);
  if (text.includes(`"${TAG}":"${REFERENCE_TAG}"`)) {
    values.ingest(container.ownerDocument);
    parsed = values.resolve(parsed);
  }
  // The action client loads only for islands whose props carry an action.
  const actions = text.includes(`"${TAG}":"${ACTION_TAG}"`)
    ? await import("../client/actions")
    : undefined;
  const props = decode(parsed, {
    decodeReference: (object) => actions?.decodeActionReference(object),
  });
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    throw new Error("the island's props are not an object");
  }
  return props as Record<string, unknown>;
}

/** Starts the islands of a page with `renderer`. Call `hydrate()` once the document has loaded. */
export function createIslandRuntime(options: IslandRuntimeOptions): IslandRuntime {
  const roots = new Map<Element, IslandRoot | undefined>();
  const pending = new Map<Element, AbortController>();
  const report =
    options.report ??
    ((message: string, error?: unknown) => console.error(`[islx] ${message}`, error));

  const unmount = (container: Element) => {
    const root = roots.get(container);
    roots.delete(container);
    try {
      root?.unmount();
    } catch {
      // A root that failed while hydrating may already be gone.
    }
  };

  const fail = (
    container: Element,
    src: string,
    exportName: string,
    serverHTML: string,
    error: unknown,
  ) => {
    report(`Could not hydrate ${exportName} (${src}). Its server HTML was restored.`, error);
    emit("islandError", { element: container, src, export: exportName, error });
    unmount(container);
    container.removeAttribute(HYDRATED_ATTRIBUTE);
    container.innerHTML = serverHTML;
  };

  async function hydrate(scope: ParentNode = document): Promise<void> {
    const candidates = Array.from(scope.querySelectorAll<Element>(ISLAND_SELECTOR));
    if (scope instanceof Element && scope.matches(ISLAND_SELECTOR)) candidates.unshift(scope);
    const islands = candidates.filter(
      (container) =>
        !roots.has(container) &&
        !pending.has(container) &&
        !insideAnotherIsland(container, scope) &&
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
        const scheduledAt = performance.now();
        let failed = false;
        try {
          await options.schedule({
            container,
            strategy,
            signal: controller.signal,
            hydrate: async () => {
              if (controller.signal.aborted || !container.isConnected) return;
              const serverHTML = container.innerHTML;
              try {
                const module = await options.load(src);
                if (controller.signal.aborted || !container.isConnected) return;
                const component = module[exportName];
                if (
                  typeof component !== "function" &&
                  (typeof component !== "object" || component === null)
                ) {
                  throw new Error(`${src} has no export ${exportName}`);
                }
                const props = await readProps(container, id, options.values ?? getValueStore());
                if (controller.signal.aborted || !container.isConnected) return;
                roots.set(
                  container,
                  options.renderer.hydrate(container, component, props, {
                    id,
                    src,
                    export: exportName,
                    strategy,
                  }) ?? undefined,
                );
                emit("hydrate", {
                  element: container,
                  src,
                  export: exportName,
                  strategy,
                  duration: performance.now() - scheduledAt,
                });
              } catch (error) {
                fail(container, src, exportName, serverHTML, error);
                failed = true;
                // Rethrown, so the scheduler neither marks the island hydrated nor replays the
                // clicks it held onto markup that has no handlers.
                throw error;
              }
            },
          });
        } catch (error) {
          if (!failed) report(`Could not schedule ${exportName} (${src}).`, error);
        } finally {
          if (pending.get(container) === controller) pending.delete(container);
        }
      }),
    );
  }

  return {
    hydrate,
    dispose(scope?: ParentNode) {
      const within = (container: Element) =>
        !scope || !container.isConnected || scope === container || scope.contains(container);
      for (const [container, controller] of pending) {
        if (!within(container)) continue;
        controller.abort();
        pending.delete(container);
      }
      for (const container of Array.from(roots.keys())) {
        if (within(container)) unmount(container);
      }
    },
  };
}
