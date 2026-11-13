/**
 * Reads an action's result sent as lines of JSON (see `RESULT_STREAM_TYPE`): the result first,
 * whose promises and streams then settle as their lines arrive.
 */
import { decode } from "../protocol/codec";
import { fromStreamSteps, type StreamStep } from "../protocol/stream";
import { PROMISE_TAG, STREAM_KIND_FIELD, STREAM_TAG, TAG_VALUE, getTag } from "../protocol/wire";

interface Deferred {
  promise: Promise<unknown>;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

function defer(): Deferred {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  // A step nobody reads must not report an unhandled rejection; a reader still sees it.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export interface StreamedResult {
  /** The first line: `{"result":…}`, or a redirect. */
  payload: { result?: unknown; redirect?: string };
  /** The promise or stream a `T` or `W` tag in the result names, or undefined for other tags. */
  reference(object: Record<string, unknown>): unknown;
}

/**
 * The result's first line, once it arrives; the rest keeps arriving. `decodeReference` decodes
 * the runtime's other tags in settled values (actions), and `reviveElements` rebuilds the elements
 * in a settled value first.
 */
export async function readStreamedResult(
  response: Response,
  decodeReference: (object: Record<string, unknown>) => unknown,
  reviveElements: (value: unknown) => Promise<Map<object, unknown>>,
): Promise<StreamedResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const nextLine = async (): Promise<string | null> => {
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        return line;
      }
      const read = await reader.read();
      if (read.done) {
        const rest = buffer + decoder.decode();
        buffer = "";
        return rest || null;
      }
      buffer += decoder.decode(read.value, { stream: true });
    }
  };

  const entries = new Map<string, Deferred>();
  let ended: Error | null = null;
  const entry = (name: string): Deferred => {
    let found = entries.get(name);
    if (!found) {
      found = defer();
      entries.set(name, found);
      if (ended) found.reject(ended);
    }
    return found;
  };
  const reference = (object: Record<string, unknown>): unknown => {
    const tag = getTag(object);
    const name = object[TAG_VALUE];
    if (typeof name !== "string") return undefined;
    if (tag === PROMISE_TAG) return entry(name).promise;
    if (tag === STREAM_TAG) {
      const kind = object[STREAM_KIND_FIELD];
      if (kind !== "r" && kind !== "i" && kind !== "t")
        throw new TypeError("malformed islx stream");
      return fromStreamSteps(entry(name).promise as Promise<StreamStep>, kind);
    }
    return undefined;
  };
  const decodeSettled = async (value: unknown) => {
    const elements = await reviveElements(value);
    return decode(value, {
      decodeReference: (object) =>
        elements.get(object) ?? reference(object) ?? decodeReference(object),
    });
  };

  const first = await nextLine();
  const payload = JSON.parse(first ?? "{}") as StreamedResult["payload"];
  void (async () => {
    try {
      for (let line = await nextLine(); line !== null; line = await nextLine()) {
        if (!line) continue;
        const message = JSON.parse(line) as { p?: unknown; v?: unknown; e?: unknown };
        if (typeof message.p !== "string") throw new TypeError("malformed islx result line");
        const settling = entry(message.p);
        if (message.e) {
          settling.reject(new Error("islx: the promise rejected on the server"));
          continue;
        }
        try {
          // In order: a stream's next step settles after the chunk before it.
          settling.resolve(((await decodeSettled(message.v)) as { v: unknown }).v);
        } catch (error) {
          settling.reject(error);
        }
      }
      ended = new Error("islx: the response ended before the promise settled");
    } catch (error) {
      ended = error instanceof Error ? error : new Error(String(error));
    }
    // Whatever is still waiting never settles now. A settled promise ignores this.
    for (const waiting of entries.values()) waiting.reject(ended);
  })();
  return { payload, reference };
}
