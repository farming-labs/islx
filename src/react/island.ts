/**
 * A client component, as the server renders it: its HTML inside `<f-island>`, and its props in
 * a script after it. Shared by the server and the browser: inside a hydrating island, a nested
 * client component is part of that island's React tree, not an island of its own.
 *
 * The compiler wraps every export of a `"use client"` module with `createIsland` in the server
 * build. The browser build keeps the module as it is.
 */
import * as React from "react";
// A namespace import: React 18's react-dom has no preloadModule, and a named import would fail
// to link in an app that only loads this module.
import * as ReactDOM from "react-dom";
import type { IslandStrategy } from "../client/schedule";
import { getBuildDefaults } from "../server/build";
import {
  ISLAND_ELEMENT,
  PROPS_SCRIPT_TYPE,
  SLOT_ELEMENT,
  SLOT_TAG,
  TAG,
  TAG_VALUE,
  VALUE_SCRIPT_TYPE,
} from "../protocol/wire";

/** What `@farmjs/islx/react/server` installs: encoding props needs server code. */
export interface IslandServerHook {
  /** Props as JSON with large values addressed, and the value scripts to send first. */
  encode(
    props: Record<string, unknown>,
    skip: ReadonlySet<string> | null,
  ): { json: string; values: Array<{ key: string; json: string }> };
  /** A value's JSON, safe in a script element. */
  escape(json: string): string;
  /** JSON that already carries its tags (a server tree's payload), with large values addressed. */
  address(
    payload: Record<string, unknown>,
    skip: ReadonlySet<string> | null,
  ): { json: string; values: Array<{ key: string; json: string }> };
  /** `{"$":"a","v":id,"b"?}` for a server action, or undefined for any other function. */
  action(value: Function): Record<string, unknown> | undefined;
}

// A client component the server renders: which module export it is, for server trees.
const CLIENT_REFERENCE = Symbol.for("islx.react.client-reference");

export interface ClientReference {
  src: string;
  exportName: string;
  Component: React.ComponentType<any>;
}

/** The module export an island component renders, or undefined for any other type. */
export function getClientReference(type: unknown): ClientReference | undefined {
  if (!type || (typeof type !== "function" && typeof type !== "object")) return undefined;
  return (type as Record<symbol, ClientReference | undefined>)[CLIENT_REFERENCE];
}

/**
 * Makes `element`'s client components part of the React root around it (a layout that hydrates
 * as one root), instead of islands of their own.
 */
export function withinClientRoot(element: React.ReactNode): React.ReactElement {
  return React.createElement(getContexts().graph.Provider, { value: true }, element);
}

/**
 * Starts islands again below a `withinClientRoot`: the page a hydrating layout keeps as server
 * HTML renders its client components as islands of their own.
 */
export function isolateIslands(element: React.ReactNode): React.ReactElement {
  return React.createElement(getContexts().graph.Provider, { value: false }, element);
}

const RENDER_STATE_RESOLVER = Symbol.for("islx.react.render-state");

/**
 * For a framework that knows the request being rendered without React context (a request store):
 * returns the render's settings when no `IslandsProvider` or `renderToStream` gave them. Keep the
 * same `sent` set for the whole response.
 */
export function setRenderStateResolver(
  resolve: (() => IslandRenderState | null) | undefined,
): void {
  (globalThis as typeof globalThis & Record<symbol, unknown>)[RENDER_STATE_RESOLVER] = resolve;
}

function resolveRenderState(): IslandRenderState | null {
  const resolve = (
    globalThis as typeof globalThis & Record<symbol, (() => IslandRenderState | null) | undefined>
  )[RENDER_STATE_RESOLVER];
  return resolve ? resolve() : null;
}

/**
 * Gives islands a render's settings when the framework renders the page itself (not through
 * `renderToStream`): which values the browser holds, and which this render already wrote.
 */
export function IslandsProvider({
  held = null,
  children,
}: {
  held?: ReadonlySet<string> | null;
  children?: React.ReactNode;
}): React.ReactElement {
  const state = React.useMemo<IslandRenderState>(
    () => ({ held: held && held.size > 0 ? held : null, sent: new Set() }),
    [held],
  );
  return React.createElement(getContexts().render.Provider, { value: state }, children);
}

const SERVER_HOOK = Symbol.for("islx.react.server");

/** @internal */
export function getIslandServerHook(): IslandServerHook | undefined {
  return (globalThis as typeof globalThis & Record<symbol, IslandServerHook | undefined>)[
    SERVER_HOOK
  ];
}

/** @internal */
export function setIslandServerHook(hook: IslandServerHook): void {
  (globalThis as typeof globalThis & Record<symbol, IslandServerHook | undefined>)[SERVER_HOOK] =
    hook;
}

/** The render's settings, from `renderToStream`. */
export interface IslandRenderState {
  /** Value keys the browser holds; null sends every value (a cacheable response). */
  held: ReadonlySet<string> | null;
  /**
   * Value keys this render already wrote. Every value script lands in the document before the
   * runtime runs, so an island later in the render, or in a boundary that streams later, finds it.
   */
  sent: Set<string>;
}

/** Tagged objects the runtime made (slots), as opposed to app data with a "$" key. */
export const runtimeTagged = new WeakSet<object>();

// One per React copy on the page, shared by every copy of this module.
const CONTEXTS = Symbol.for("islx.react.contexts");
type Contexts = { graph: React.Context<boolean>; render: React.Context<IslandRenderState | null> };

/** @internal */
export function getContexts(): Contexts {
  const scope = globalThis as typeof globalThis &
    Record<symbol, WeakMap<object, Contexts> | undefined>;
  const all = (scope[CONTEXTS] ??= new WeakMap());
  let contexts = all.get(React.createElement);
  if (!contexts) {
    contexts = {
      graph: React.createContext(false),
      render: React.createContext<IslandRenderState | null>(null),
    };
    all.set(React.createElement, contexts);
  }
  return contexts;
}

function isElement(value: unknown): value is React.ReactElement {
  const type = (value as { $$typeof?: symbol } | null)?.$$typeof;
  return type === Symbol.for("react.transitional.element") || type === Symbol.for("react.element");
}

const slotStyle = { display: "contents" } as const;

/**
 * Splits props into what renders on the server and what travels: server output passed to an
 * island (`children`, or any element prop) renders once inside `<f-slot>`, and travels as a
 * reference to it, so the browser reads its HTML from the page instead of receiving it twice.
 */
function splitSlots(
  value: unknown,
  prefix: string,
  counter: { next: number },
): { render: unknown; wire: unknown } {
  if (isElement(value)) {
    const name = `${prefix}${counter.next++}`;
    const reference = { [TAG]: SLOT_TAG, [TAG_VALUE]: name };
    runtimeTagged.add(reference);
    return {
      render: React.createElement(
        SLOT_ELEMENT,
        { key: value.key ?? name, name, style: slotStyle },
        value,
      ),
      wire: reference,
    };
  }
  if (Array.isArray(value)) {
    const parts = value.map((entry) => splitSlots(entry, prefix, counter));
    return { render: parts.map((part) => part.render), wire: parts.map((part) => part.wire) };
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { render: value, wire: value };
    const render: Record<string, unknown> = {};
    const wire: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const part = splitSlots(entry, prefix, counter);
      render[key] = part.render;
      wire[key] = part.wire;
    }
    return { render, wire };
  }
  return { render: value, wire: value };
}

const warned = new Set<string>();

function isThenable(value: unknown): boolean {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Wraps a client component so the server renders it as an island. `src` is the module the browser
 * imports, `exportName` the component's export there.
 */
export function createIsland<P extends object>(
  Component: React.ComponentType<P>,
  src: string,
  exportName: string,
  strategy: IslandStrategy = "load",
): React.ComponentType<P> {
  function Island(props: P) {
    const { graph, render } = getContexts();
    const insideIsland = React.useContext(graph);
    const state = React.useContext(render) ?? resolveRenderState();
    const id = React.useId();
    if (insideIsland) return React.createElement(Component, props);
    const hook = getIslandServerHook();
    if (!hook) {
      throw new Error(
        "islx: an island rendered on a server that did not import @farmjs/islx/react/server",
      );
    }

    let encoded: ReturnType<IslandServerHook["encode"]>;
    let renderProps: unknown;
    try {
      const { render: rendered, wire } = splitSlots(props, `${id}s`, { next: 0 });
      renderProps = rendered;
      const skip = state ? new Set([...(state.held ?? []), ...state.sent]) : null;
      encoded = hook.encode(wire as Record<string, unknown>, skip);
      for (const value of encoded.values) state?.sent.add(value.key);
    } catch (error) {
      // An action's sealed values still sealing: React renders this part again once ready.
      if (isThenable(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const key = `${src}#${exportName}:${message}`;
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(
          `[islx] ${exportName} (${src}) was rendered without hydration: its props cannot be sent to the browser. ${message}`,
        );
      }
      return React.createElement(Component, props);
    }

    // The island's code starts loading with the page, not after the entry runs. React writes the
    // links into the head, once each. Deferred islands keep their code for later.
    if (strategy === "load") {
      for (const href of getBuildDefaults().modules?.[src] ?? [])
        ReactDOM.preloadModule?.(href, { as: "script" });
    }

    return React.createElement(
      React.Fragment,
      null,
      ...encoded.values.map((value) =>
        React.createElement("script", {
          key: value.key,
          type: VALUE_SCRIPT_TYPE,
          name: value.key,
          dangerouslySetInnerHTML: { __html: hook.escape(value.json) },
        }),
      ),
      React.createElement(
        ISLAND_ELEMENT,
        { key: "island", src, export: exportName, props: id, strategy, style: slotStyle },
        React.createElement(
          graph.Provider,
          { value: true },
          React.createElement(Component, renderProps as P),
        ),
      ),
      React.createElement("script", {
        key: "props",
        type: PROPS_SCRIPT_TYPE,
        htmlFor: id,
        dangerouslySetInnerHTML: { __html: hook.escape(encoded.json) },
      }),
    );
  }
  Island.displayName = `Island(${Component.displayName || Component.name || exportName})`;
  Object.defineProperty(Island, CLIENT_REFERENCE, { value: { src, exportName, Component } });
  return Island as React.ComponentType<P>;
}
