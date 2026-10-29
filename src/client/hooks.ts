/**
 * Lifecycle hooks in the browser. An app declares them in one module, which the bundler plugin
 * loads (`islx({ hooks: { client: "./src/islx.client.ts" } })`):
 *
 *   export default defineClientHooks({
 *     navigate(event) { if (unsaved()) event.preventDefault(); },
 *     navigated({ url, duration }) { analytics.page(url); },
 *     islandError({ src, error }) { report(error, src); },
 *   });
 *
 * Every hook also fires as a DOM event on `document` (`f:navigate`, `f:hydrate`, …), for scripts
 * that do not import the app: `document.addEventListener("f:navigated", …)`.
 */
import type { IslandStrategy } from "./schedule";

export interface ClientHookEvents {
  /** Before the next page is fetched. `preventDefault()` stays on this page. */
  navigate: { url: URL; from: URL; kind: "link" | "history" | "code" };
  /** The next page is in place. */
  navigated: { url: URL; duration: number };
  /** A navigation fell back to loading the page the ordinary way. */
  navigateError: { url: URL; reason: string };
  /** An island became interactive: `duration` runs from scheduling to React's first commit. */
  hydrate: {
    element: Element;
    src: string;
    export: string;
    strategy: IslandStrategy;
    duration: number;
  };
  /** An island failed; its server HTML was restored. */
  islandError: { element: Element; src: string; export: string; error: unknown };
  /** A server action call starts. `name` is the export (or inline function) name when known. */
  action: { id: string; name?: string };
  /** A server action call finished. */
  actionEnd: {
    id: string;
    name?: string;
    ok: boolean;
    duration: number;
    redirect?: string;
    error?: unknown;
  };
}

export type ClientHookEvent<Name extends keyof ClientHookEvents> = ClientHookEvents[Name] & {
  /** Only `navigate` can be cancelled. */
  preventDefault(): void;
  readonly defaultPrevented: boolean;
};

export type ClientHooks = {
  [Name in keyof ClientHookEvents]?: (event: ClientHookEvent<Name>) => void;
};

const HOOKS_KEY = Symbol.for("islx.client.hooks");
const CANCELABLE = new Set<keyof ClientHookEvents>(["navigate"]);

/** Types an app's hooks module. */
export function defineClientHooks(hooks: ClientHooks): ClientHooks {
  return hooks;
}

/** Installs the app's hooks; the plugin's browser entry calls it. */
export function setClientHooks(hooks: ClientHooks | undefined): void {
  (globalThis as typeof globalThis & Record<symbol, ClientHooks | undefined>)[HOOKS_KEY] = hooks;
}

/** The DOM event name of a hook: `navigateError` → `f:navigate-error`. */
export function hookEventName(name: keyof ClientHookEvents): string {
  return `f:${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/**
 * Runs a hook and dispatches its DOM event. Returns false when it was cancelled. A hook that
 * throws is reported, never allowed to break navigation or hydration.
 */
export function emit<Name extends keyof ClientHookEvents>(
  name: Name,
  detail: ClientHookEvents[Name],
): boolean {
  const cancelable = CANCELABLE.has(name);
  let prevented = false;
  const event = {
    ...detail,
    preventDefault() {
      if (cancelable) prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
  } as ClientHookEvent<Name>;
  const hook = (globalThis as typeof globalThis & Record<symbol, ClientHooks | undefined>)[
    HOOKS_KEY
  ]?.[name];
  if (hook) {
    try {
      (hook as (event: ClientHookEvent<Name>) => void)(event);
    } catch (error) {
      console.error(`[islx] The ${name} hook failed:`, error);
    }
  }
  if (typeof document !== "undefined" && typeof CustomEvent === "function") {
    const dom = new CustomEvent(hookEventName(name), { detail, cancelable });
    if (!document.dispatchEvent(dom)) prevented = cancelable;
  }
  return !prevented;
}
