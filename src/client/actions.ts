/**
 * The browser side of server actions. A client module's import of a `"use server"` module
 * becomes references made here, and an action passed as a prop arrives as one.
 *
 * Calls run one at a time, in order, as React expects of actions. After each, the page refreshes
 * (through the framework's router) so it shows what the action changed; a redirect from the
 * action navigates instead. An action this server no longer knows, as after a deploy, reloads the
 * page.
 */
import { decode, encode } from "../protocol/codec";
import { emit } from "./hooks";
import { readStreamedResult } from "./result-stream";
import {
  ACTION_HEADER,
  ACTION_STALE_HEADER,
  ACTION_TAG,
  BLOB_TAG,
  BOUND_FIELD,
  CALL_FIELD,
  ELEMENT_TAG,
  FORM_DATA_TAG,
  RESULT_STREAM_TYPE,
  attachmentField,
  TAG,
  TAG_BOUND,
  TAG_VALUE,
  TEMPORARY_TAG,
  getTag,
} from "../protocol/wire";

type AnyFunction = (...args: any[]) => any;

/** How actions reach the framework's router. */
export interface ActionNavigator {
  /** Renders the current page again from the server, keeping client state and scroll. */
  refresh?(): Promise<void> | void;
  /** A client navigation to `href`, as the action's redirect. */
  navigate?(href: string): Promise<void> | void;
}

interface ClientReference {
  id: string;
  token?: string;
  bound: unknown[];
  /** The action's name, for hooks: the export name of an imported action. */
  name?: string;
  /** Set by a call answered with a redirect, for the `actionEnd` hook. */
  redirect?: string;
}

const STATE_KEY = Symbol.for("islx.actions.client");

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

interface ClientState {
  interceptor?: ActionInterceptor;
  navigator: ActionNavigator;
  queue: Promise<unknown>;
  references: Map<string, AnyFunction>;
  info: WeakMap<object, ClientReference>;
}

function state(): ClientState {
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

/** Encodes an action passed back to the server as an argument. */
function encodeFunction(value: Function): unknown {
  const reference = state().info.get(value);
  if (!reference) return undefined;
  if (reference.bound.length > 0) {
    throw new TypeError("an action bound in the browser cannot be sent to the server");
  }
  return reference.token === undefined
    ? { [TAG]: ACTION_TAG, [TAG_VALUE]: reference.id }
    : { [TAG]: ACTION_TAG, [TAG_VALUE]: reference.id, [TAG_BOUND]: reference.token };
}

/** Decodes an action in a result or props: `{"$":"a","v":id,"b"?:sealed}`. */
export function decodeActionReference(object: Record<string, unknown>): AnyFunction | undefined {
  if (object[TAG] !== ACTION_TAG || typeof object[TAG_VALUE] !== "string") return undefined;
  const token = object[TAG_BOUND];
  if (token !== undefined && typeof token !== "string") return undefined;
  return createServerReference(object[TAG_VALUE], token);
}

/** Elements an action returned, as the server rendered them (`ELEMENT_TAG`). */
export interface RenderedElementsPayload {
  /** The scope of their server tree. */
  s: string;
  /** Their server HTML, with the tree. */
  h: string;
}

const ELEMENT_REVIVER = Symbol.for("islx.client.element-reviver");

/**
 * @internal Rebuilds the elements an action returned. The React hydration runtime installs it,
 * with the module loader it hydrates islands with.
 */
export function setActionElementReviver(
  revive: (payload: RenderedElementsPayload) => Promise<unknown>,
): void {
  (globalThis as Record<symbol, unknown>)[ELEMENT_REVIVER] = revive;
}

/** The elements in a result, rebuilt, by the payload object that carried them. */
async function reviveElements(value: unknown): Promise<Map<object, unknown>> {
  const found: Record<string, unknown>[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (getTag(node) === ELEMENT_TAG) {
      found.push(node as Record<string, unknown>);
      return;
    }
    for (const entry of Array.isArray(node) ? node : Object.values(node)) walk(entry);
  };
  walk(value);
  const revived = new Map<object, unknown>();
  if (found.length === 0) return revived;
  const revive = (globalThis as Record<symbol, unknown>)[ELEMENT_REVIVER] as
    | ((payload: RenderedElementsPayload) => Promise<unknown>)
    | undefined;
  if (!revive) throw new Error("the action returned elements, which need islx's React runtime");
  await Promise.all(
    found.map(async (object) => {
      const payload = object[TAG_VALUE] as RenderedElementsPayload;
      if (!payload || typeof payload.s !== "string" || typeof payload.h !== "string") {
        throw new TypeError("malformed elements in the action's result");
      }
      revived.set(object, await revive(payload));
    }),
  );
  return revived;
}

/** Returned by a call whose action this deploy no longer knows: the page reloads. */
const STALE: unique symbol = Symbol("islx.action.stale");

/** Whether a value is one a call sends as a temporary reference, as React's `encodeReply` does. */
function isTemporaryValue(value: unknown): boolean {
  if (typeof value === "symbol") return Symbol.keyFor(value) === undefined;
  return typeof value === "function" || (!!value && typeof value === "object");
}

async function call(reference: ClientReference, args: unknown[]): Promise<unknown> {
  const all = [...reference.bound, ...args];
  // Values the codec cannot carry go as their index: the action may only return them, and the
  // result names them by index again.
  const temporaries: unknown[] = [];
  const temporaryIndex = new Map<unknown, number>();
  const encodeTemporary = (value: unknown) => {
    if (!isTemporaryValue(value)) return undefined;
    let index = temporaryIndex.get(value);
    if (index === undefined) {
      index = temporaries.push(value) - 1;
      temporaryIndex.set(value, index);
    }
    return { [TAG]: TEMPORARY_TAG, [TAG_VALUE]: index };
  };
  const decodeTemporary = (object: Record<string, unknown>) => {
    if (object[TAG] !== TEMPORARY_TAG) return undefined;
    const index = object[TAG_VALUE];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return undefined;
    if (index >= temporaries.length) return undefined;
    return temporaries[index];
  };
  const single = all.length === 1 && all[0] instanceof FormData ? all[0] : null;
  let body: BodyInit;
  const headers: Record<string, string> = { [ACTION_HEADER]: reference.id };
  if (single) {
    // A form's fields travel as the form does; the sealed values ride along in one field.
    const form = new FormData();
    for (const [key, value] of single) form.append(key, value);
    if (reference.token !== undefined) form.append(BOUND_FIELD, reference.token);
    body = form;
  } else {
    // Form data and files travel as multipart fields; the JSON names them by index.
    const attachments: Array<FormData | Blob> = [];
    const encodeObject = (value: object) => {
      if (value instanceof FormData || value instanceof Blob) {
        attachments.push(value);
        return {
          [TAG]: value instanceof FormData ? FORM_DATA_TAG : BLOB_TAG,
          [TAG_VALUE]: attachments.length - 1,
        };
      }
      return undefined;
    };
    const json = JSON.stringify({
      a: encode(all, { encodeFunction, encodeObject, encodeTemporary }),
      b: reference.token,
    });
    if (attachments.length === 0) {
      headers["content-type"] = "text/plain;charset=UTF-8";
      body = json;
    } else {
      const form = new FormData();
      form.append(CALL_FIELD, json);
      attachments.forEach((attachment, index) => {
        if (attachment instanceof FormData) {
          for (const [key, value] of attachment) form.append(attachmentField(index, key), value);
        } else {
          form.append(attachmentField(index), attachment);
        }
      });
      body = form;
    }
  }
  const response = await fetch(location.href, {
    method: "POST",
    headers,
    body,
    credentials: "same-origin",
  });
  if (response.headers.get(ACTION_STALE_HEADER)) {
    location.reload();
    return STALE;
  }
  if (!response.ok) throw new Error(`Server action failed: ${response.status}`);
  // A result with promises or streams in it streams: its first line is the result.
  const streamed = (response.headers.get("content-type") ?? "").startsWith(RESULT_STREAM_TYPE)
    ? await readStreamedResult(
        response,
        (object) => decodeTemporary(object) ?? decodeActionReference(object),
        reviveElements,
      )
    : null;
  const payload =
    streamed?.payload ?? ((await response.json()) as { result?: unknown; redirect?: string });
  const navigator = state().navigator;
  if (typeof payload.redirect === "string") {
    streamed?.start();
    reference.redirect = payload.redirect;
    if (navigator.navigate) await navigator.navigate(payload.redirect);
    else location.assign(payload.redirect);
    return undefined;
  }
  let result: unknown;
  try {
    const elements = await reviveElements(payload.result);
    result = decode(payload.result, {
      decodeReference: (object, ancestors) =>
        elements.has(object)
          ? elements.get(object)
          : (streamed?.reference(object, ancestors) ??
            decodeTemporary(object) ??
            decodeActionReference(object)),
    });
  } finally {
    // Promises settle into what the result holds, so they start once it is decoded.
    streamed?.start();
  }
  // The caller's pending state (`useFormStatus`, `useActionState`) lasts until the page shows
  // what the action changed.
  if (navigator.refresh) await navigator.refresh();
  return result;
}

function createReference(reference: ClientReference): AnyFunction {
  const client = state();
  const fn = (...args: unknown[]) => {
    const { id, name } = reference;
    let startedAt = 0;
    const run = async () => {
      emit("action", { id, name });
      startedAt = performance.now();
      reference.redirect = undefined;
      return call(reference, args);
    };
    // The calls before this one, as they stand now: `next` may run after this call has queued.
    const previous = client.queue;
    const queued = () => previous.then(run);
    // The interceptor sees the call when it is made (a framework may read what it was doing then),
    // and `next` sends it in turn.
    const interceptor = client.interceptor;
    let sent: Promise<unknown>;
    if (!interceptor) {
      sent = queued();
    } else {
      let stale = false;
      const next = () =>
        queued().then((value) => {
          if (value === STALE) stale = true;
          return value;
        });
      try {
        sent = Promise.resolve(
          interceptor({ id, name, args: [...reference.bound, ...args] }, next),
        ).then((value) => (stale ? STALE : value));
      } catch (error) {
        sent = Promise.reject(error);
      }
    }
    const result = sent.then(
      (value) => {
        if (value !== STALE) {
          const { redirect } = reference;
          emit("actionEnd", {
            id,
            name,
            ok: true,
            duration: performance.now() - startedAt,
            redirect,
          });
        }
        return value;
      },
      (error: unknown) => {
        emit("actionEnd", { id, name, ok: false, duration: performance.now() - startedAt, error });
        throw error;
      },
    );
    // The next call waits for this one, whether it succeeds or not.
    client.queue = result.then(
      () => {},
      () => {},
    );
    // The page is reloading: nothing waiting on this call should continue.
    return result.then((value) => (value === STALE ? new Promise<never>(() => {}) : value));
  };
  client.info.set(fn, reference);
  Object.defineProperty(fn, "bind", {
    configurable: true,
    value: (_thisArg: unknown, ...args: unknown[]) =>
      createReference({ ...reference, bound: [...reference.bound, ...args] }),
  });
  return fn;
}

/** How many references are kept for identity; older ones a page stopped using are dropped. */
const MAX_REFERENCES = 1000;

/** The function that calls a server action; one per id and sealed values, so props keep identity. */
export function createServerReference(id: string, token?: string, name?: string): AnyFunction {
  const key = token === undefined ? id : `${id}\0${token}`;
  const references = state().references;
  let reference = references.get(key);
  if (reference) {
    // Most recently used last, so the oldest is the one a page stopped using.
    references.delete(key);
  } else {
    reference = createReference({ id, token, bound: [], name });
    if (references.size >= MAX_REFERENCES) {
      references.delete(references.keys().next().value!);
    }
  }
  references.set(key, reference);
  return reference;
}
