/**
 * Temporary references: values the browser sent to a server action that the codec cannot carry
 * (`TEMPORARY_TAG`). The action receives a stand-in it cannot read, only return: the browser then
 * gets its own value back, as React Server Components send a temporary reference.
 */
import { TAG, TAG_VALUE, TEMPORARY_TAG } from "../protocol/wire";

// A symbol, not a `WeakMap`: the React adapter may load another copy of this module.
const TEMPORARY = Symbol.for("islx.server.temporary-reference");

interface Temporary {
  index: number;
  /** The call that received it: a stand-in only goes back to its own browser. */
  call: object;
}

/** The temporary reference behind `value`, or undefined for any other value. */
function readTemporary(value: unknown): Temporary | undefined {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  return (value as Record<symbol, Temporary | undefined>)[TEMPORARY];
}

/** Whether `value` is a stand-in for a value a browser sent to a server action. */
export function isTemporaryReference(value: unknown): boolean {
  return readTemporary(value) !== undefined;
}

/** A stand-in's class, so code that copies or walks values leaves it whole. */
class TemporaryReference {}

// The keys runtimes read to tell what a value is (a promise, an element, a stream, JSON): each
// reads as absent, as on any object that is none of those.
const PROBED = new Set(["then", "$$typeof", "toJSON", "next", "getReader", "constructor"]);

function createStandIn(temporary: Temporary): object {
  const target = Object.freeze(new TemporaryReference());
  return new Proxy(target, {
    get(_target, key) {
      if (key === TEMPORARY) return temporary;
      if (typeof key === "symbol" || PROBED.has(key)) return undefined;
      throw new TypeError(
        `Cannot read "${key}" of a value the browser sent to a server action: the server can only return it to the browser.`,
      );
    },
    has: (_target, key) => key === TEMPORARY,
    set() {
      throw new TypeError(
        "Cannot change a value the browser sent to a server action: the server can only return it to the browser.",
      );
    },
    defineProperty() {
      throw new TypeError(
        "Cannot change a value the browser sent to a server action: the server can only return it to the browser.",
      );
    },
  });
}

/** One call's temporary references: decoding its arguments, and encoding its result. */
export function createTemporaryReferences() {
  const call = {};
  const standIns = new Map<number, object>();
  return {
    /** The stand-in for argument value `index`: the same one each time it is named. */
    decode(index: unknown): object | undefined {
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return undefined;
      let standIn = standIns.get(index);
      if (!standIn) {
        standIn = createStandIn({ index, call });
        standIns.set(index, standIn);
      }
      return standIn;
    },
    /** `{"$":"t","v":n}` for one of this call's stand-ins; throws for another call's. */
    encode(value: unknown): Record<string, unknown> | undefined {
      const temporary = readTemporary(value);
      if (!temporary) return undefined;
      if (temporary.call !== call) {
        throw new TypeError(
          "a value the browser sent to another server action call can only be returned by that call",
        );
      }
      return { [TAG]: TEMPORARY_TAG, [TAG_VALUE]: temporary.index };
    },
  };
}
