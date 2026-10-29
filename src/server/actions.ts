/**
 * Server actions: functions the browser can call. Each has an id; the compiler registers every
 * export of a `"use server"` module, and hoists each inline `"use server"` function out of the
 * component it is written in, with the variables it reads passed back to it.
 *
 * A reference is what the browser holds: an id, and the action's bound values (the variables an
 * inline action captured, and arguments added with `.bind`) sealed so only the server reads them.
 *
 * Reference functions carry React's progressive-enhancement hooks, so `<form action={fn}>` works
 * before JavaScript loads, and `useActionState` keeps its state across a form post.
 */
import {
  ACTION_TAG,
  FORM_REF_PREFIX,
  TAG,
  TAG_BOUND,
  TAG_VALUE,
  formFieldName,
} from "../protocol/wire";
import { getBuildDefaults } from "./build";
import {
  type ActionKeys,
  SealError,
  createActionKeys,
  generateActionKey,
  sealBound,
  unsealBound,
} from "./seal";

type AnyFunction = (...args: any[]) => any;

interface ActionEntry {
  /** The function that runs: an export, or a hoisted inline action taking its captured values first. */
  fn: AnyFunction;
  /**
   * How many leading sealed values are an inline action's captured variables, passed to it as
   * one array before its arguments; 0 for an export, which takes its bound arguments directly.
   * An inline action that captured nothing still takes the (empty) array.
   */
  captured: number;
  /** Names the action in errors: `rename (src/page.tsx)`. */
  label: string;
}

/** A thenable whose result can be read synchronously once it settles, as React expects. */
interface Settled<T> extends Promise<T> {
  status?: "pending" | "fulfilled" | "rejected";
  value?: T;
  reason?: unknown;
}

interface ReferenceState {
  id: string;
  /** The inline action's captured variables, read when first needed (see `bindInlineAction`). */
  captured: (() => unknown[]) | null;
  capturedValues?: unknown[];
  names: readonly string[];
  /** Arguments added with `.bind`, in order. */
  bound: unknown[];
  /** The sealed values, once sealing started; `null` when there is nothing to seal. */
  sealed?: Settled<string> | null;
  /** A reference decoded from a sealed value, still sealed: the browser passed it back. */
  token?: string;
}

const REGISTRY_KEY = Symbol.for("islx.actions.registry");
const REFERENCES_KEY = Symbol.for("islx.actions.references");
const KEYS_KEY = Symbol.for("islx.actions.keys");

type Scope = typeof globalThis & Record<symbol, any>;

function registry(): Map<string, ActionEntry> {
  return ((globalThis as Scope)[REGISTRY_KEY] ??= new Map());
}
function references(): WeakMap<object, ReferenceState> {
  return ((globalThis as Scope)[REFERENCES_KEY] ??= new WeakMap());
}

// --- Keys ------------------------------------------------------------------------------------

let warnedGeneratedKey = false;

/**
 * Sets the keys bound values are sealed with: `key` seals, `previousKeys` still open values
 * sealed before a rotation. Without it, `ISLX_ACTIONS_KEY` and `ISLX_ACTIONS_PREVIOUS_KEYS`
 * (comma-separated) are read from the environment; failing those, the key the bundler plugin
 * made for this build; failing that, a key generated for this process: fine for one long-lived
 * server, wrong for several instances or serverless, where every server must hold the same key.
 */
export function configureActionKeys(options: {
  key: string;
  previousKeys?: readonly string[];
}): void {
  (globalThis as Scope)[KEYS_KEY] = createActionKeys(options.key, options.previousKeys);
}

function actionKeys(): Promise<ActionKeys> {
  const scope = globalThis as Scope;
  if (scope[KEYS_KEY]) return scope[KEYS_KEY];
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const key = env?.ISLX_ACTIONS_KEY;
  if (key) {
    const previous = (env?.ISLX_ACTIONS_PREVIOUS_KEYS ?? "").split(",").filter(Boolean);
    return (scope[KEYS_KEY] = createActionKeys(key, previous));
  }
  // A key the bundler plugin made for this build: shared by every instance of the build.
  const buildKey = getBuildDefaults().key;
  if (buildKey) return (scope[KEYS_KEY] = createActionKeys(buildKey));
  if (!warnedGeneratedKey && env?.NODE_ENV === "production") {
    warnedGeneratedKey = true;
    console.warn(
      "[islx] ISLX_ACTIONS_KEY is not set: server actions use a key generated for this process. " +
        "Pages rendered by another instance or before a restart cannot run actions that captured " +
        "values. Set ISLX_ACTIONS_KEY on every instance (generateActionKey() makes one).",
    );
  }
  return (scope[KEYS_KEY] = createActionKeys(generateActionKey()));
}

// --- References ------------------------------------------------------------------------------

function settle<T>(promise: Promise<T>): Settled<T> {
  const settled = promise as Settled<T>;
  settled.status = "pending";
  settled.then(
    (value) => {
      settled.status = "fulfilled";
      settled.value = value;
    },
    (reason) => {
      settled.status = "rejected";
      settled.reason = reason;
    },
  );
  // A rejection is reported where the value is read; never as an unhandled rejection.
  settled.catch(() => {});
  return settled;
}

function capturedValues(state: ReferenceState): unknown[] {
  if (!state.captured) return [];
  return (state.capturedValues ??= state.captured());
}

/** The values a reference seals, captured variables first. */
function boundValues(state: ReferenceState): unknown[] {
  return [...capturedValues(state), ...state.bound];
}

/** The nested references inside `values` whose own values are still sealing. */
function pendingNested(values: unknown[]): Settled<string>[] {
  const pending: Settled<string>[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    if (typeof value === "function") {
      const nested = references().get(value);
      const sealed = nested && startSeal(nested);
      if (sealed && sealed.status === "pending") pending.push(sealed);
      return;
    }
    if (typeof value !== "object") return;
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        visit(key);
        visit(entry);
      }
    } else if (value instanceof Set) for (const entry of value) visit(entry);
    else for (const entry of Object.values(value)) visit(entry);
  };
  values.forEach(visit);
  return pending;
}

/**
 * Starts sealing a reference's bound values, if it has any. A captured value that is itself an
 * action reference is sealed first, so the outer seal carries it sealed.
 */
function startSeal(state: ReferenceState): Settled<string> | null {
  if (state.sealed !== undefined) return state.sealed;
  if (state.token !== undefined) {
    state.sealed = settle(Promise.resolve(state.token));
    state.sealed.status = "fulfilled";
    state.sealed.value = state.token;
    return state.sealed;
  }
  const values = boundValues(state);
  if (values.length === 0) return (state.sealed = null);
  const label = registry().get(state.id)?.label;
  const names = [...state.names, ...state.bound.map((_, index) => `bound argument ${index + 1}`)];
  // Marked pending first: a reference that captures itself must not recurse.
  state.sealed = settle(
    (async () => {
      const keys = await actionKeys();
      for (
        let pending = pendingNested(values);
        pending.length > 0;
        pending = pendingNested(values)
      ) {
        await Promise.all(pending);
      }
      return sealBound(keys, state.id, values, {
        names,
        label,
        encodeFunction: (fn) => {
          const nested = references().get(fn);
          if (!nested) return undefined;
          if (nested === state) throw new TypeError("a server action cannot capture itself");
          return referenceJson(nested.id, readSealed(nested));
        },
      });
    })(),
  );
  return state.sealed;
}

function referenceJson(id: string, sealed: string | undefined): Record<string, unknown> {
  return sealed === undefined
    ? { [TAG]: ACTION_TAG, [TAG_VALUE]: id }
    : { [TAG]: ACTION_TAG, [TAG_VALUE]: id, [TAG_BOUND]: sealed };
}

/**
 * The sealed values of a reference, synchronously: React reads them while it renders. While
 * they are still sealing this throws the pending promise, which React waits for (the part of the
 * page being rendered suspends, then renders again).
 */
function readSealed(state: ReferenceState): string | undefined {
  const sealed = startSeal(state);
  if (!sealed) return undefined;
  if (sealed.status === "fulfilled") return sealed.value;
  if (sealed.status === "rejected") throw sealed.reason;
  throw sealed;
}

async function invoke(state: ReferenceState, args: unknown[]): Promise<unknown> {
  const entry = registry().get(state.id);
  if (!entry) throw new Error(`server action ${state.id} is not registered`);
  const values =
    state.token !== undefined ? await openToken(state.id, state.token) : boundValues(state);
  return runEntry(entry, values, args);
}

function runEntry(entry: ActionEntry, values: unknown[], args: unknown[]): unknown {
  if (entry.captured === 0) return entry.fn(...values, ...args);
  return entry.fn(values.slice(0, entry.captured), ...values.slice(entry.captured), ...args);
}

/** A reference function: calling it runs the action, on the server too. */
function createReference(state: ReferenceState, base?: AnyFunction): AnyFunction {
  const reference = base ?? ((...args: unknown[]) => invoke(state, args));
  references().set(reference, state);
  attachHooks(reference, state);
  return reference;
}

function attachHooks(reference: AnyFunction, state: ReferenceState): void {
  const define = (name: string, value: unknown) =>
    Object.defineProperty(reference, name, { value, configurable: true });
  // `<form action={fn}>` and `<button formAction={fn}>` without JavaScript. React writes `name`
  // as a hidden input (a form) or the button's name, then the data fields.
  define("$$FORM_ACTION", (prefix: string) => {
    const sealed = readSealed(state);
    const data = new FormData();
    data.append(formFieldName(prefix, "A"), state.id);
    if (sealed !== undefined) data.append(formFieldName(prefix, "B"), sealed);
    return {
      name: `${FORM_REF_PREFIX}${prefix}`,
      action: "",
      method: "POST",
      encType: "multipart/form-data",
      data,
    };
  });
  // `useActionState` keeps a form post's result when the posted action is this one.
  define("$$IS_SIGNATURE_EQUAL", (id: string, boundCount: number) => {
    return id === state.id && boundCount === state.bound.length;
  });
  define("bind", function (this: unknown, _thisArg: unknown, ...args: unknown[]) {
    if (state.token !== undefined) {
      throw new TypeError("a server action received from the browser cannot be bound again");
    }
    return createReference({
      id: state.id,
      captured: state.captured,
      capturedValues: state.capturedValues,
      names: state.names,
      bound: [...state.bound, ...args],
    });
  });
}

/**
 * Registers an export of a `"use server"` module. The export itself stays the function it was;
 * it gains the hooks forms need and an id props can name.
 */
export function registerServerReference<T>(action: T, id: string, label = id): T {
  if (typeof action !== "function") {
    throw new TypeError(
      `${label} is exported from a "use server" module but is not a function. ` +
        'A "use server" module may export only async functions.',
    );
  }
  registry().set(id, { fn: action as AnyFunction, captured: 0, label });
  if (!references().has(action as object)) {
    createReference({ id, captured: null, names: [], bound: [] }, action as AnyFunction);
  }
  return action;
}

/**
 * Registers an inline action the compiler hoisted to module scope. It takes the `captured`
 * variables it read as one array, then its own arguments.
 */
export function registerInlineAction(
  hoisted: AnyFunction,
  id: string,
  captured: number,
  label = id,
): void {
  // An inline action that captured nothing still receives an (empty) array first.
  const fn = captured === 0 ? (...args: unknown[]) => hoisted([], ...args) : hoisted;
  registry().set(id, { fn, captured, label });
}

/**
 * The function an inline action stands for where it was written: calling it runs the hoisted
 * action with the captured variables, and passing it to a form or a client component sends them
 * sealed. `capture` is read when first needed, after the component has assigned them.
 */
export function bindInlineAction(
  id: string,
  capture: () => unknown[],
  names: readonly string[],
): AnyFunction {
  return createReference({ id, captured: names.length > 0 ? capture : null, names, bound: [] });
}

/** What a reference travels as: `{"$":"a","v":id}` plus `"b"` when it has sealed values. */
export interface ActionReference {
  id: string;
  /** The sealed values, or undefined. Throws a pending promise while they are sealing. */
  sealed(): string | undefined;
  /** Resolves once the sealed values are ready. */
  ready(): Promise<void>;
}

/** The reference a function stands for, if it is a server action. */
export function getActionReference(value: unknown): ActionReference | undefined {
  if (typeof value !== "function") return undefined;
  const state = references().get(value);
  if (!state) return undefined;
  return {
    id: state.id,
    sealed: () => readSealed(state),
    ready: async () => {
      await startSeal(state);
    },
  };
}

/** Encodes a server action for JSON (`encode`'s `encodeFunction`), or undefined for any other function. */
export function encodeActionReference(value: Function): Record<string, unknown> | undefined {
  const reference = getActionReference(value);
  return reference && referenceJson(reference.id, reference.sealed());
}

async function openToken(id: string, token: string): Promise<unknown[]> {
  return unsealBound(await actionKeys(), id, token, {
    decodeReference: decodeNestedReference,
  });
}

/** A reference inside sealed values: it stays sealed until it runs. */
function decodeNestedReference(object: Record<string, unknown>): unknown {
  if (object[TAG] !== ACTION_TAG || typeof object[TAG_VALUE] !== "string") return undefined;
  const id = object[TAG_VALUE];
  const token = object[TAG_BOUND];
  if (token !== undefined && typeof token !== "string") return undefined;
  return createReference({ id, captured: null, names: [], bound: [], token });
}

/**
 * Decodes an action reference the browser sent back (an argument): an id this server registered,
 * whose sealed values open when it runs. Unknown ids are refused.
 */
export function decodeActionReference(object: Record<string, unknown>): AnyFunction | undefined {
  if (object[TAG] !== ACTION_TAG || typeof object[TAG_VALUE] !== "string") return undefined;
  if (!registry().has(object[TAG_VALUE])) return undefined;
  return decodeNestedReference(object) as AnyFunction | undefined;
}

// --- Running ---------------------------------------------------------------------------------

/** The outcome of resolving a posted action. */
export type ResolvedAction =
  | { ok: true; run(args: unknown[]): Promise<unknown>; boundCount: number; label: string }
  | { ok: false; reason: "unknown" | "stale" | "invalid" };

/** Finds the action an id names, and opens its sealed values. */
export async function resolveAction(
  id: string,
  token: string | undefined,
): Promise<ResolvedAction> {
  const entry = registry().get(id);
  if (!entry) return { ok: false, reason: "unknown" };
  let values: unknown[] = [];
  if (token !== undefined) {
    try {
      values = await openToken(id, token);
    } catch (error) {
      if (error instanceof SealError) return { ok: false, reason: error.reason };
      throw error;
    }
  }
  if (values.length < entry.captured) return { ok: false, reason: "invalid" };
  return {
    ok: true,
    boundCount: values.length - entry.captured,
    label: entry.label,
    run: async (args) => runEntry(entry, values, args),
  };
}
