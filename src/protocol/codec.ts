/**
 * Values JSON cannot hold. Each travels as a tagged object: the reserved key `$` holds a short tag
 * and `v` holds the data.
 *
 *   undefined                 {"$":"u"}
 *   NaN, ±Infinity, -0        {"$":"n","v":"NaN"}
 *   12345678901234567890n     {"$":"B","v":"12345678901234567890"}
 *   new Date(…)               {"$":"D","v":"2026-10-28T09:00:00.000Z"}   (null for an invalid date)
 *   new Map([[k, v]])         {"$":"M","v":[[k, v]]}                      (keys and values tagged)
 *   new Set([v])              {"$":"S","v":[v]}
 *   new URL(…)                {"$":"U","v":"https://example.com/"}
 *   /ab+c/gi                  {"$":"R","v":["ab+c","gi"]}
 *   Uint8Array, ArrayBuffer…  {"$":"Y","v":["Uint8Array","base64…"]}
 *   app data with a "$" key   {"$":"o","v":{…}}                          (never read as a tag)
 *
 * Decoding accepts input from the browser (server action arguments): it builds plain objects
 * without assigning `__proto__`, and rejects unknown or malformed tags.
 */
import {
  ACTION_TAG,
  BLOB_TAG,
  FORM_DATA_TAG,
  OBJECT_TAG,
  REFERENCE_TAG,
  SLOT_TAG,
  TAG,
  TAG_VALUE,
  getTag,
} from "./wire";

const TYPED_ARRAYS = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
} as const;

/** Standard base64 of bytes. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Bytes of standard base64. Throws on anything else. */
export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** A tagged object. */
export function tagged(tag: string, value?: unknown): Record<string, unknown> {
  return value === undefined ? { [TAG]: tag } : { [TAG]: tag, [TAG_VALUE]: value };
}

/** Whether a plain object must travel wrapped as `o`, because its own keys include `$`. */
export function needsObjectTag(object: object): boolean {
  return Object.prototype.hasOwnProperty.call(object, TAG);
}

/**
 * The tag for a value JSON cannot hold and that has no children (everything above but `M`, `S`
 * and `o`), or undefined when the value needs none.
 */
export function encodeLeaf(value: unknown): Record<string, unknown> | undefined {
  switch (typeof value) {
    case "undefined":
      return tagged("u");
    case "bigint":
      return tagged("B", value.toString());
    case "number":
      if (Number.isNaN(value)) return tagged("n", "NaN");
      if (value === Infinity) return tagged("n", "Infinity");
      if (value === -Infinity) return tagged("n", "-Infinity");
      if (Object.is(value, -0)) return tagged("n", "-0");
      return undefined;
    case "object":
      break;
    default:
      return undefined;
  }
  if (value === null) return undefined;
  if (value instanceof Date) {
    return tagged("D", Number.isNaN(value.getTime()) ? null : value.toISOString());
  }
  if (typeof URL === "function" && value instanceof URL) return tagged("U", value.href);
  if (value instanceof RegExp) return tagged("R", [value.source, value.flags]);
  if (value instanceof ArrayBuffer) {
    return tagged("Y", ["ArrayBuffer", toBase64(new Uint8Array(value))]);
  }
  if (ArrayBuffer.isView(value)) {
    const name = value instanceof DataView ? "DataView" : value.constructor.name;
    if (name !== "DataView" && !(name in TYPED_ARRAYS)) return undefined;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return tagged("Y", [name, toBase64(bytes)]);
  }
  return undefined;
}

/** Returned by `decodeTagged` for the runtime's reference tags (`r`, `s`, `a`). */
export const NOT_A_VALUE: unique symbol = Symbol.for("islx.codec.not-a-value");

/** A plain object from entries; `defineProperty`, so a "__proto__" key stays an ordinary key. */
export function plainObject(entries: Iterable<[string, unknown]>): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    Object.defineProperty(object, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return object;
}

/**
 * The value a tagged object stands for, decoding children (a `Map`'s or `Set`'s entries, an `o`
 * object's properties) with `decodeChild`. Returns `NOT_A_VALUE` for the runtime's reference tags,
 * and throws for an unknown or malformed tag.
 */
export function decodeTagged(
  object: Record<string, unknown>,
  decodeChild: (value: unknown) => unknown,
): unknown {
  const tag = object[TAG] as string;
  const data = object[TAG_VALUE];
  switch (tag) {
    case REFERENCE_TAG:
    case SLOT_TAG:
    case ACTION_TAG:
    case FORM_DATA_TAG:
    case BLOB_TAG:
      return NOT_A_VALUE;
    case OBJECT_TAG:
      if (data && typeof data === "object" && !Array.isArray(data)) {
        return plainObject(
          Object.entries(data).map(([key, value]): [string, unknown] => [key, decodeChild(value)]),
        );
      }
      break;
    case "u":
      return undefined;
    case "n":
      if (data === "NaN") return Number.NaN;
      if (data === "Infinity") return Infinity;
      if (data === "-Infinity") return -Infinity;
      if (data === "-0") return -0;
      break;
    case "B":
      if (typeof data === "string" && /^-?\d+$/.test(data)) return BigInt(data);
      break;
    case "D":
      if (data === null) return new Date(Number.NaN);
      if (typeof data === "string") return new Date(data);
      break;
    case "U":
      if (typeof data === "string") return new URL(data);
      break;
    case "R":
      if (Array.isArray(data) && typeof data[0] === "string" && typeof data[1] === "string") {
        return new RegExp(data[0], data[1]);
      }
      break;
    case "Y": {
      if (!Array.isArray(data) || typeof data[0] !== "string" || typeof data[1] !== "string") break;
      const bytes = fromBase64(data[1]);
      if (data[0] === "ArrayBuffer") return bytes.buffer;
      if (data[0] === "DataView") return new DataView(bytes.buffer as ArrayBuffer);
      const TypedArray = Object.prototype.hasOwnProperty.call(TYPED_ARRAYS, data[0])
        ? TYPED_ARRAYS[data[0] as keyof typeof TYPED_ARRAYS]
        : undefined;
      if (!TypedArray || bytes.byteLength % TypedArray.BYTES_PER_ELEMENT !== 0) break;
      return new TypedArray(
        bytes.buffer as ArrayBuffer,
        0,
        bytes.byteLength / TypedArray.BYTES_PER_ELEMENT,
      );
    }
    case "M":
      if (
        Array.isArray(data) &&
        data.every((entry) => Array.isArray(entry) && entry.length === 2)
      ) {
        return new Map(data.map(([key, value]) => [decodeChild(key), decodeChild(value)]));
      }
      break;
    case "S":
      if (Array.isArray(data)) return new Set(data.map(decodeChild));
      break;
    default:
      throw new TypeError(`unknown ${JSON.stringify(tag)} tag`);
  }
  throw new TypeError(`malformed ${JSON.stringify(tag)} tag`);
}

/** Describes where in a value encoding failed, for error messages: `user.roles[2]`. */
function describePath(path: readonly (string | number)[]): string {
  return path
    .map((part, index) =>
      typeof part === "number"
        ? `[${part}]`
        : /^[A-Za-z_$][\w$]*$/.test(part)
          ? `${index === 0 ? "" : "."}${part}`
          : `[${JSON.stringify(part)}]`,
    )
    .join("");
}

/** Thrown by `encode` for a value it cannot carry; names where the value sits. */
export class EncodeError extends TypeError {
  /** Where the value sits, from the root: `["user", "roles", 2]`. */
  readonly path: readonly (string | number)[];
  /** What is wrong with it: "functions are not serializable". */
  readonly reason: string;
  constructor(reason: string, path: readonly (string | number)[]) {
    super(path.length > 0 ? `${describePath(path)}: ${reason}` : reason);
    this.name = "EncodeError";
    this.path = [...path];
    this.reason = reason;
  }

  /** The path as written in code: `user.roles[2]`. */
  get location(): string {
    return describePath(this.path);
  }
}

export interface EncodeOptions {
  /**
   * Encodes a function, such as a server action, or returns undefined to refuse it. Without it,
   * functions throw.
   */
  encodeFunction?: (value: Function) => unknown;
  /**
   * Encodes an object the codec cannot carry itself (`FormData`, a `Blob`), or returns
   * undefined to refuse it.
   */
  encodeObject?: (value: object) => unknown;
  /** Names the root of the value in error messages. */
  path?: readonly (string | number)[];
}

/**
 * Encodes a value for JSON with the tags above: plain objects, arrays and the types listed.
 * Symbols, class instances, circular values and (without `encodeFunction`) functions throw an
 * `EncodeError` that names where the value sits.
 */
export function encode(value: unknown, options: EncodeOptions = {}): unknown {
  const seen = new Set<object>();
  const path: (string | number)[] = [...(options.path ?? [])];
  const fail = (reason: string): never => {
    throw new EncodeError(reason, path);
  };
  const visit = (value: unknown): unknown => {
    const leaf = encodeLeaf(value);
    if (leaf) return leaf;
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return value;
    if (typeof value === "function") {
      const encoded = options.encodeFunction?.(value);
      return encoded === undefined ? fail("functions are not serializable") : encoded;
    }
    if (typeof value !== "object") return fail(`${typeof value} values are not serializable`);
    if (seen.has(value)) return fail("circular values are not serializable");
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((entry, index) => {
          path.push(index);
          try {
            return visit(entry);
          } finally {
            path.pop();
          }
        });
      }
      if (value instanceof Map) {
        let index = 0;
        return tagged(
          "M",
          Array.from(value, ([key, entry]) => {
            path.push(index++);
            try {
              return [visit(key), visit(entry)];
            } finally {
              path.pop();
            }
          }),
        );
      }
      if (value instanceof Set) {
        let index = 0;
        return tagged(
          "S",
          Array.from(value, (entry) => {
            path.push(index++);
            try {
              return visit(entry);
            } finally {
              path.pop();
            }
          }),
        );
      }
      if (typeof (value as { $$typeof?: unknown }).$$typeof === "symbol") {
        return fail("elements (JSX) are not serializable");
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        const special = options.encodeObject?.(value as object);
        if (special !== undefined) return special;
        const name = (value as object).constructor?.name;
        return fail(`class instances${name ? ` (${name})` : ""} are not serializable`);
      }
      const encoded = plainObject(
        Object.entries(value).map(([key, entry]): [string, unknown] => {
          path.push(key);
          try {
            return [key, visit(entry)];
          } finally {
            path.pop();
          }
        }),
      );
      return needsObjectTag(value) ? tagged(OBJECT_TAG, encoded) : encoded;
    } finally {
      seen.delete(value);
    }
  };
  return visit(value);
}

export interface DecodeOptions {
  /**
   * Decodes one of the runtime's reference tags (`r`, `s`, `a`), or returns undefined to refuse
   * it. Without it, every reference throws: input from a browser must not name the runtime's own
   * references unless the caller checks them.
   */
  decodeReference?: (object: Record<string, unknown>) => unknown;
}

/** Decodes what `encode` produced, after `JSON.parse`. Reference tags are rejected by default. */
export function decode(value: unknown, options: DecodeOptions = {}): unknown {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    if (getTag(value) !== undefined) {
      const object = value as Record<string, unknown>;
      const decoded = decodeTagged(object, visit);
      if (decoded !== NOT_A_VALUE) return decoded;
      const reference = options.decodeReference?.(object);
      if (reference !== undefined) return reference;
      throw new TypeError(`a ${JSON.stringify(object[TAG])} reference is not allowed here`);
    }
    if (needsObjectTag(value)) throw new TypeError('malformed "$" tag');
    return plainObject(Object.entries(value).map(([key, entry]) => [key, visit(entry)]));
  };
  return visit(value);
}
