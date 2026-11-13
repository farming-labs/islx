/**
 * An action's result with promises or streams in it, sent as lines of JSON: the result first,
 * then each promise as it settles (see `RESULT_STREAM_TYPE`). A stream travels as the promise of
 * its first step, as it does in an island's props.
 */
import { encode } from "../protocol/codec";
import { getStreamKind, toStreamSteps } from "../protocol/stream";
import { PROMISE_TAG, STREAM_KIND_FIELD, STREAM_TAG, TAG, TAG_VALUE } from "../protocol/wire";
import { encodeActionReference } from "./actions";

interface Pending {
  name: string;
  promise: PromiseLike<unknown>;
}

function isThenable(value: object): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown }).then === "function";
}

/** Encodes results, naming their promises and streams, which `stream` then sends as they settle. */
export function createResultEncoder(encodeObject: (value: object) => unknown) {
  let count = 0;
  const queued: Pending[] = [];
  let watch: ((pending: Pending) => void) | null = null;
  const add = (promise: PromiseLike<unknown>): string => {
    const pending = { name: (count++).toString(36), promise };
    if (watch) watch(pending);
    else queued.push(pending);
    return pending.name;
  };
  const encodeValue = (value: unknown): unknown =>
    encode(value, {
      encodeFunction: encodeActionReference,
      encodeObject: (object) => {
        const special = encodeObject(object);
        if (special !== undefined) return special;
        const kind = getStreamKind(object);
        if (kind) {
          return {
            [TAG]: STREAM_TAG,
            [TAG_VALUE]: add(toStreamSteps(object, kind)),
            [STREAM_KIND_FIELD]: kind,
          };
        }
        if (isThenable(object)) return { [TAG]: PROMISE_TAG, [TAG_VALUE]: add(object) };
        return undefined;
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
          watch = ({ name, promise }) => {
            open++;
            Promise.resolve(promise)
              .then(
                (value) => {
                  let line: unknown;
                  try {
                    line = { p: name, v: encodeValue({ v: value }) };
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
