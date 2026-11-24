import * as React from "react";
import type { IslandRenderState } from "./island";

// One per React copy on the page, shared by every copy of this module.
const CONTEXTS = Symbol.for("islx.react.contexts");
type Contexts = {
  graph: React.Context<boolean>;
  render: React.Context<IslandRenderState | null>;
  /** The element an island hydrated into, in the browser. */
  container: React.Context<Element | null>;
};

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
      container: React.createContext<Element | null>(null),
    };
    all.set(React.createElement, contexts);
  }
  return contexts;
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
