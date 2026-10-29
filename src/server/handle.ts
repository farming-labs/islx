/**
 * Handling a posted server action: one function on a Web `Request`, so any server mounts it.
 * It returns `null` for a request that is not an action, which the app then handles as usual.
 *
 * Calls from JavaScript (`F-Action` header) answer JSON. Forms posted without JavaScript run the
 * action and answer `303 See Other` back to the page, or render the page with a
 * `useActionState` result when the app gives `renderFormState`.
 */
import { decode, encode } from "../protocol/codec";
import {
  ACTION_HEADER,
  ACTION_KEY_FIELD,
  ACTION_STALE_HEADER,
  BLOB_TAG,
  BOUND_FIELD,
  CALL_FIELD,
  FORM_DATA_TAG,
  FORM_REF_PREFIX,
  REFERENCE_TAG,
  SLOT_TAG,
  TAG,
  TAG_VALUE,
  attachmentField,
  readPostedAction,
  stripRuntimeFields,
} from "../protocol/wire";
import { decodeActionReference, encodeActionReference, resolveAction } from "./actions";
import { BodyTooLargeError, parseForm, readBody } from "./body";
import { isSameOriginRequest, normalizeAllowedOrigin } from "./origin";

/** React's form state: the result, the hook it belongs to, the action id, its bound count. */
export type ReactFormState = [state: unknown, key: string, referenceId: string, boundCount: number];

export interface ActionErrorOutcome {
  /** Send the browser here: a 303 for forms, `{"redirect"}` for calls. */
  redirect?: string;
  /** Answer with this status (and no details). */
  status?: number;
}

export interface HandleActionOptions {
  /** Origins or hosts, besides the request's own, that may post actions: `*.example.com`. */
  allowedOrigins?: readonly string[];
  /** The largest body accepted, in bytes. Default 1 MB. */
  bodySizeLimit?: number;
  /**
   * Runs the action, so the framework can give it the request's context (cookies, headers,
   * an abort signal).
   */
  run?<T>(request: Request, action: () => Promise<T>): Promise<T>;
  /**
   * Maps an error the action threw to a redirect or a status: the framework's `redirect()` and
   * `notFound()`. Anything unmapped is a 500, logged with `onError`.
   */
  mapError?(error: unknown): ActionErrorOutcome | undefined;
  /**
   * Renders the page after a form posted from a `useActionState` hook, with the action's result
   * as React's `formState` (`renderToReadableStream(…, { formState })`, and the same to
   * `hydrateRoot`). Without it, the form redirects back and the result is not shown.
   */
  renderFormState?(formState: ReactFormState, request: Request): Response | Promise<Response>;
  /** Reports an action that failed. Default `console.error`. */
  onError?(error: unknown): void;
}

const DEFAULT_BODY_SIZE_LIMIT = 1_000_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,1000000}$/;

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "cache-control": "no-store", "content-type": "application/json", ...headers },
  });
}

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { "cache-control": "no-store", location } });
}

const STALE = { [ACTION_STALE_HEADER]: "1" };

/** A reference from the browser: only actions, and only ids this server registered. */
function decodeArgumentReference(object: Record<string, unknown>): unknown {
  if (object[TAG] === REFERENCE_TAG || object[TAG] === SLOT_TAG) return undefined;
  return decodeActionReference(object);
}

function looksLikeActionForm(head: Uint8Array): boolean {
  const start = new TextDecoder().decode(head);
  return start.includes(FORM_REF_PREFIX) || start.includes(`%24F_REF_`);
}

/** Runs the server action a request posts, or returns null when it posts none. */
export async function handleAction(
  request: Request,
  options: HandleActionOptions = {},
): Promise<Response | null> {
  if (request.method.toUpperCase() !== "POST") return null;
  const allowedOrigins = (options.allowedOrigins ?? []).map(normalizeAllowedOrigin);
  const limit = options.bodySizeLimit ?? DEFAULT_BODY_SIZE_LIMIT;
  const run = options.run ?? (<T>(_request: Request, action: () => Promise<T>) => action());
  const report =
    options.onError ?? ((error: unknown) => console.error("[islx] Server action failed:", error));
  const id = request.headers.get(ACTION_HEADER);
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();

  if (id !== null) {
    // A call from JavaScript.
    if (!isSameOriginRequest(request, allowedOrigins)) return text(403, "Forbidden");
    if (!ID_PATTERN.test(id)) return text(400, "Bad Request");
    let body: Uint8Array;
    try {
      body = await readBody(request, limit);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return text(413, "Payload Too Large");
      throw error;
    }
    let args: unknown[];
    let token: string | undefined;
    try {
      const form = contentType.startsWith("multipart/form-data")
        ? await parseForm(request, body)
        : null;
      const call = form?.get(CALL_FIELD);
      if (form && typeof call !== "string") {
        // One FormData argument, as a form posts it.
        const bound = form.get(BOUND_FIELD);
        token = typeof bound === "string" ? bound : undefined;
        form.delete(BOUND_FIELD);
        args = [form];
      } else if (form) {
        // JSON arguments whose form data and files travel as fields.
        const payload = JSON.parse(call as string) as { a?: unknown; b?: unknown };
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
          throw new TypeError();
        const decodeReference = (object: Record<string, unknown>) => {
          const index = object[TAG_VALUE];
          if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return undefined;
          if (object[TAG] === BLOB_TAG) {
            const file = form.get(attachmentField(index));
            return typeof file === "string" || file === null ? undefined : file;
          }
          if (object[TAG] === FORM_DATA_TAG) {
            const prefix = attachmentField(index, "");
            const data = new FormData();
            for (const [key, value] of form) {
              if (key.startsWith(prefix)) data.append(key.slice(prefix.length), value);
            }
            return data;
          }
          return decodeArgumentReference(object);
        };
        const decoded = decode(payload.a ?? [], { decodeReference });
        if (!Array.isArray(decoded)) throw new TypeError("arguments must be an array");
        if (payload.b !== undefined && typeof payload.b !== "string") throw new TypeError();
        args = decoded;
        token = payload.b as string | undefined;
      } else {
        const payload = JSON.parse(new TextDecoder().decode(body) || "{}") as {
          a?: unknown;
          b?: unknown;
        };
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
          throw new TypeError();
        const decoded = decode(payload.a ?? [], { decodeReference: decodeArgumentReference });
        if (!Array.isArray(decoded)) throw new TypeError("arguments must be an array");
        if (payload.b !== undefined && typeof payload.b !== "string") throw new TypeError();
        args = decoded;
        token = payload.b as string | undefined;
      }
      if (token !== undefined && !TOKEN_PATTERN.test(token)) throw new TypeError();
    } catch {
      return text(400, "Bad Request");
    }
    const resolved = await resolveAction(id, token);
    if (!resolved.ok) {
      return resolved.reason === "invalid"
        ? text(400, "Bad Request")
        : text(resolved.reason === "unknown" ? 404 : 409, "Stale Action", STALE);
    }
    let result: unknown;
    try {
      result = await run(request, () => resolved.run(args));
    } catch (error) {
      const outcome = options.mapError?.(error);
      if (outcome?.redirect) return json({ redirect: outcome.redirect });
      if (outcome?.status) return text(outcome.status, "Server action failed");
      report(error);
      return text(500, "Server action failed");
    }
    try {
      return json({ result: encode(result, { encodeFunction: encodeActionReference }) });
    } catch (error) {
      report(
        new TypeError(
          `the server action's result is not serializable: ${(error as Error).message}`,
        ),
      );
      return text(500, "Server action failed");
    }
  }

  // A form posted without JavaScript, or any other POST.
  if (
    !contentType.startsWith("multipart/form-data") &&
    !contentType.startsWith("application/x-www-form-urlencoded")
  ) {
    return null;
  }
  let body: Uint8Array;
  try {
    // A clone: a POST that is not an action keeps its body for the app.
    body = await readBody(request.clone(), limit);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return looksLikeActionForm(error.head) ? text(413, "Payload Too Large") : null;
    }
    throw error;
  }
  let form: FormData;
  try {
    form = await parseForm(request, body);
  } catch {
    return null;
  }
  const posted = readPostedAction(form);
  if (!posted) return null;
  if (!isSameOriginRequest(request, allowedOrigins)) return text(403, "Forbidden");
  if (
    !ID_PATTERN.test(posted.id) ||
    (posted.token !== undefined && !TOKEN_PATTERN.test(posted.token))
  ) {
    return text(400, "Bad Request");
  }
  const actionKey = form.get(ACTION_KEY_FIELD);
  stripRuntimeFields(form);
  const page = new URL(request.url);
  const back = page.pathname + page.search;
  const resolved = await resolveAction(posted.id, posted.token);
  if (!resolved.ok) {
    // Rendered by another deploy: load the page again, as it is now.
    return resolved.reason === "invalid" ? text(400, "Bad Request") : seeOther(back);
  }
  let result: unknown;
  try {
    result = await run(request, () => resolved.run([form]));
  } catch (error) {
    const outcome = options.mapError?.(error);
    if (outcome?.redirect) return seeOther(outcome.redirect);
    if (outcome?.status) return text(outcome.status, "Server action failed");
    report(error);
    return text(500, "Server action failed");
  }
  if (typeof actionKey === "string" && options.renderFormState) {
    // The hook bound its previous state as the last argument; React compares the action
    // without it, as Flight does.
    const boundCount = Math.max(resolved.boundCount - 1, 0);
    return options.renderFormState([result, actionKey, posted.id, boundCount], request);
  }
  // Post/redirect/get: the browser loads the page again and sees what the action changed.
  return seeOther(back);
}
