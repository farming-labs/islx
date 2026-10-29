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
import {
  ACTION_HEADER,
  ACTION_STALE_HEADER,
  ACTION_TAG,
  BLOB_TAG,
  BOUND_FIELD,
  CALL_FIELD,
  FORM_DATA_TAG,
  attachmentField,
  TAG,
  TAG_BOUND,
  TAG_VALUE,
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
}

const STATE_KEY = Symbol.for("islx.actions.client");

interface ClientState {
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

/** Returned by a call whose action this deploy no longer knows: the page reloads. */
const STALE: unique symbol = Symbol("islx.action.stale");

async function call(reference: ClientReference, args: unknown[]): Promise<unknown> {
  const all = [...reference.bound, ...args];
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
      a: encode(all, { encodeFunction, encodeObject }),
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
  const payload = (await response.json()) as { result?: unknown; redirect?: string };
  const navigator = state().navigator;
  if (typeof payload.redirect === "string") {
    if (navigator.navigate) await navigator.navigate(payload.redirect);
    else location.assign(payload.redirect);
    return undefined;
  }
  const result = decode(payload.result, { decodeReference: decodeActionReference });
  // The caller's pending state (`useFormStatus`, `useActionState`) lasts until the page shows
  // what the action changed.
  if (navigator.refresh) await navigator.refresh();
  return result;
}

function createReference(reference: ClientReference): AnyFunction {
  const client = state();
  const fn = (...args: unknown[]) => {
    const result = client.queue.then(() => call(reference, args));
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

/** The function that calls a server action; one per id and sealed values, so props keep identity. */
export function createServerReference(id: string, token?: string): AnyFunction {
  const key = token === undefined ? id : `${id}\0${token}`;
  const references = state().references;
  let reference = references.get(key);
  if (!reference) {
    reference = createReference({ id, token, bound: [] });
    references.set(key, reference);
  }
  return reference;
}
