/**
 * An action's result with promises or streams in it, sent as lines of JSON: the result first,
 * then each promise as it settles (see `RESULT_STREAM_TYPE`). A stream travels as the promise of
 * its first step, as it does in an island's props.
 */
import { encode } from "../protocol/codec";
import { getStreamKind, toStreamSteps } from "../protocol/stream";
import { PROMISE_TAG, STREAM_KIND_FIELD, STREAM_TAG, TAG, TAG_VALUE } from "../protocol/wire";
import { encodeActionReference, prepareSeals } from "./actions";
import { encodeSentObject, prepareBlobs } from "./blobs";

interface Pending {
  name: string;
  promise: PromiseLike<unknown>;
  /** The containers above the promise, which its settled value continues. */
  ancestors: readonly object[];
  /** Whether it is a stream's step, whose next step continues the stream's ancestors. */
  step: boolean;
}

function isThenable(value: object): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown }).then === "function";
}

/** Encodes results, naming their promises and streams, which `stream` then sends as they settle. */
export function createResultEncoder(encodeObject: (value: object) => unknown) {
  let count = 0;
  const queued: Pending[] = [];
  let watch: ((pending: Pending) => void) | null = null;
  // A promise or stream met again keeps its name, as React Server Components send it once: a
  // promise that settles to the object holding it would otherwise send itself without end.
  const named = new WeakMap<object, unknown>();
  // A step's next step, which continues the stream's ancestors rather than the step's, so a long
  // stream does not keep every chunk.
  const nextSteps = new WeakMap<object, readonly object[]>();
  const add = (promise: PromiseLike<unknown>, ancestors: readonly object[], step: boolean) => {
    const pending = { name: (count++).toString(36), promise, ancestors, step };
    if (watch) watch(pending);
    else queued.push(pending);
    return pending.name;
  };
  const encodeValue = (value: unknown, ancestors?: readonly object[]): unknown =>
    encode(value, {
      ancestors,
      encodeFunction: encodeActionReference,
      encodeObject: (object, above) => {
        const special = encodeObject(object) ?? encodeSentObject(object);
        if (special !== undefined) return special;
        const known = named.get(object);
        if (known !== undefined) return known;
        let encoded: unknown;
        const kind = getStreamKind(object);
        if (kind) {
          encoded = {
            [TAG]: STREAM_TAG,
            [TAG_VALUE]: add(toStreamSteps(object, kind), above(), true),
            [STREAM_KIND_FIELD]: kind,
          };
        } else if (isThenable(object)) {
          const next = nextSteps.get(object);
          encoded = { [TAG]: PROMISE_TAG, [TAG_VALUE]: add(object, next ?? above(), !!next) };
        }
        if (encoded !== undefined) named.set(object, encoded);
        return encoded;
      },
    });
  return {
    encode: encodeValue,
    /** Whether the results encoded so far hold a promise or a stream. */
    get streams(): boolean {
      return count > 0;
    },
    /** The response body: `first`, then a line for each promise as it settles. */
    stream(first: unknown, onError: (reason: unknown) => void): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      let open = 0;
      let closed = false;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (line: unknown) => {
            if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          };
          const settled = () => {
            if (--open === 0 && !closed) {
              closed = true;
              controller.close();
            }
          };
          watch = ({ name, promise, ancestors, step }) => {
            open++;
            Promise.resolve(promise)
              .then(async (value) => {
                await prepareBlobs(value);
                await prepareSeals(value);
                return value;
              })
              .then(
                (value) => {
                  const next = step ? (value as { n?: unknown } | null)?.n : undefined;
                  if (next && typeof next === "object") nextSteps.set(next, ancestors);
                  let line: unknown;
                  try {
                    line = { p: name, v: encodeValue({ v: value }, ancestors) };
                  } catch (error) {
                    onError(error);
                    line = { p: name, e: 1 };
                  }
                  emit(line);
                },
                (reason: unknown) => {
                  onError(reason);
                  emit({ p: name, e: 1 });
                },
              )
              .finally(settled);
          };
          emit(first);
          for (const pending of queued.splice(0)) watch(pending);
        },
        cancel() {
          // The browser went away: what settles later has nowhere to go.
          closed = true;
        },
      });
    },
  };
}
