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

interface Entry extends Deferred {
  /** The containers above the promise, which its settled value continues. */
  ancestors?: readonly unknown[];
  /** Whether it is a stream's step, whose next step continues the stream's ancestors. */
  step?: boolean;
  /** The stream a `W` tag naming it stands for, made once. */
  stream?: unknown;
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
  /**
   * The promise or stream a `T` or `W` tag in the result names, or undefined for other tags.
   * `ancestors` are the containers above it, as `decode` passes them.
   */
  reference(object: Record<string, unknown>, ancestors: () => readonly unknown[]): unknown;
  /** Starts settling promises; call it once the result is decoded, as their values continue it. */
  start(): void;
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

  const entries = new Map<string, Entry>();
  let ended: Error | null = null;
  const entry = (name: string): Entry => {
    let found = entries.get(name);
    if (!found) {
      found = defer();
      entries.set(name, found);
      if (ended) found.reject(ended);
    }
    return found;
  };
  // The tags that name a step's next step, which continue the stream's ancestors.
  const nextSteps = new WeakMap<object, readonly unknown[]>();
  const reference = (
    object: Record<string, unknown>,
    ancestors: () => readonly unknown[],
  ): unknown => {
    const tag = getTag(object);
    const name = object[TAG_VALUE];
    if (typeof name !== "string") return undefined;
    if (tag !== PROMISE_TAG && tag !== STREAM_TAG) return undefined;
    const found = entry(name);
    // The first tag naming a promise places it, as the server names it where it first meets it.
    if (!found.ancestors) {
      const next = nextSteps.get(object);
      found.ancestors = next ?? ancestors();
      found.step = tag === STREAM_TAG || !!next;
    }
    if (tag === PROMISE_TAG) return found.promise;
    if (found.stream === undefined) {
      const kind = object[STREAM_KIND_FIELD];
      if (kind !== "r" && kind !== "i" && kind !== "t")
        throw new TypeError("malformed islx stream");
      found.stream = fromStreamSteps(found.promise as Promise<StreamStep>, kind);
    }
    return found.stream;
  };
  const decodeSettled = async (value: unknown, settling: Entry) => {
    const elements = await reviveElements(value);
    if (settling.step) {
      const next = (value as { v?: { n?: unknown } } | null)?.v?.n;
      if (next && typeof next === "object") nextSteps.set(next, settling.ancestors!);
    }
    return decode(value, {
      ancestors: settling.ancestors,
      decodeReference: (object, ancestors) =>
        elements.get(object) ?? reference(object, ancestors) ?? decodeReference(object),
    });
  };

  const first = await nextLine();
  const payload = JSON.parse(first ?? "{}") as StreamedResult["payload"];
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    void settle();
  };
  const settle = async () => {
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
          // A promise no decoded value names cannot be placed: the result failed to decode.
          if (!settling.ancestors) throw new TypeError("malformed islx result line");
          // In order: a stream's next step settles after the chunk before it.
          settling.resolve(((await decodeSettled(message.v, settling)) as { v: unknown }).v);
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
  };
  return { payload, reference, start };
}
