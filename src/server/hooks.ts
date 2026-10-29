/**
 * Lifecycle hooks on the server, declared in the plugin's options (or a module it loads):
 *
 *   islx({
 *     hooks: {
 *       server: {
 *         async action({ request, name }, run) {
 *           console.log("action", name);
 *           return run();
 *         },
 *       },
 *     },
 *   })
 *
 * `handleAction` uses them without being told: options passed to it directly come first.
 */
import type { ActionErrorOutcome } from "./handle";

export interface ActionInfo {
  request: Request;
  /** The action's id. */
  id: string;
  /** Its export name, or the inline function's name. */
  name: string;
  /** Its module, from the app root. */
  module: string;
}

export interface ServerHooks {
  /**
   * Wraps every action: check the caller, rate-limit, log, time. Call `run` to run the action,
   * and return what it returns; throw to refuse (`actionError` maps the error to a response).
   */
  action?(info: ActionInfo, run: () => Promise<unknown>): Promise<unknown>;
  /** Maps an error an action threw to a redirect or a status: a framework's `redirect()`. */
  actionError?(error: unknown, info: ActionInfo): ActionErrorOutcome | undefined;
  /** Reports an action that failed with an error nothing mapped. */
  error?(error: unknown, info: ActionInfo): void;
}

const HOOKS_KEY = Symbol.for("islx.server.hooks");

/** Types an app's server hooks. */
export function defineServerHooks(hooks: ServerHooks): ServerHooks {
  return hooks;
}

/** Installs the app's hooks; the plugin's server runtime calls it. */
export function setServerHooks(hooks: ServerHooks | undefined): void {
  (globalThis as typeof globalThis & Record<symbol, ServerHooks | undefined>)[HOOKS_KEY] = hooks;
}

export function getServerHooks(): ServerHooks {
  return (
    (globalThis as typeof globalThis & Record<symbol, ServerHooks | undefined>)[HOOKS_KEY] ?? {}
  );
}

/** Splits a registry label, `save (src/actions.ts)`, into name and module. */
export function describeAction(id: string, label: string | undefined): Omit<ActionInfo, "request"> {
  const match = /^(.*) \((.*)\)$/.exec(label ?? "");
  return match ? { id, name: match[1]!, module: match[2]! } : { id, name: label ?? id, module: "" };
}
