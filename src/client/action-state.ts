/**
 * What a framework installs for server actions when its page starts: the router actions refresh
 * and navigate through, and the interceptor every call goes through. Kept apart from the call
 * path (`./actions`), so a page that installs them loads that path only when it calls an action.
 */

type AnyFunction = (...args: any[]) => any;

/** How actions reach the framework's router. */
export interface ActionNavigator {
  /** Renders the current page again from the server, keeping client state and scroll. */
  refresh?(): Promise<void> | void;
  /** A client navigation to `href`, as the action's redirect. */
  navigate?(href: string): Promise<void> | void;
}

/** A call of a server action, as an interceptor sees it. */
export interface ActionCall {
  id: string;
  /** The export (or inline function) name, when known. */
  name?: string;
  /** The arguments, after any bound with `.bind`. */
  args: readonly unknown[];
}

/**
 * Wraps every server action call: call `next` to make the request, and return what the caller
 * gets. A framework uses it to unwrap what its own server side adds to a result (cache
 * invalidations, a query's cache entry) or to turn a returned error back into one it throws.
 */
export type ActionInterceptor = (
  call: ActionCall,
  next: () => Promise<unknown>,
) => Promise<unknown>;

/** @internal A reference's id, sealed values, bound arguments and name. */
export interface ClientReference {
  id: string;
  token?: string;
  bound: unknown[];
  /** The action's name, for hooks: the export name of an imported action. */
  name?: string;
  /** Set by a call answered with a redirect, for the `actionEnd` hook. */
  redirect?: string;
}

/** @internal The page's action state, shared by every copy of this module. */
export interface ClientState {
  interceptor?: ActionInterceptor;
  navigator: ActionNavigator;
  queue: Promise<unknown>;
  references: Map<string, AnyFunction>;
  info: WeakMap<object, ClientReference>;
}

const STATE_KEY = Symbol.for("islx.actions.client");

/** @internal */
export function state(): ClientState {
  const scope = globalThis as typeof globalThis & Record<symbol, ClientState | undefined>;
  return (scope[STATE_KEY] ??= {
    navigator: {},
    queue: Promise.resolve(),
    references: new Map(),
    info: new WeakMap(),
  });
}

/** Connects actions to the framework's router. */
export function setActionNavigator(navigator: ActionNavigator): void {
  state().navigator = navigator;
}

/** Installs the framework's interceptor for server action calls (one; a later call replaces it). */
export function setActionInterceptor(interceptor: ActionInterceptor | undefined): void {
  state().interceptor = interceptor;
}
