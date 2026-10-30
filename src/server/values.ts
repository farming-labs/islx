/**
 * Values sent once: which parts of an island's props travel as values of their own, keyed by a
 * hash of their JSON, and which of those a response leaves out because the browser already holds
 * them. The browser side is `@farmjs/islx/client` (`getValueStore`).
 */
import { encodeLeaf, needsObjectTag } from "../protocol/codec";
import {
  MAX_HELD_VALUES,
  OBJECT_TAG,
  REFERENCE_TAG,
  VALUES_HEADER,
  VALUE_KEY_PATTERN,
} from "../protocol/wire";

/** Shorter values stay inline: a reference and its script cost about 60 bytes. */
export const VALUE_MIN_LENGTH = 512;

/** A 64-bit hash of a value's JSON, as 14 base-36 characters. Not cryptographic. */
export function hashValue(json: string): string {
  let h1 = 0xdeadbeef ^ json.length;
  let h2 = 0x41c6ce57 ^ json.length;
  for (let index = 0; index < json.length; index++) {
    const code = json.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36).padStart(7, "0") + (h1 >>> 0).toString(36).padStart(7, "0");
}

export interface AddressedValue {
  key: string;
  json: string;
  /** Keys of the values this value's JSON refers to. */
  children: string[];
}

export interface AddressedProps {
  /** The props as JSON, with each large value replaced by a reference. */
  json: string;
  values: Map<string, AddressedValue>;
  /** Keys the props refer to directly. */
  roots: string[];
}

export interface AddressOptions {
  /** Values whose JSON is shorter stay inline. */
  minLength?: number;
  /**
   * Encodes what plain JSON cannot hold: a function (an action), an element (a slot). Return
   * undefined to fall back to the codec, which throws for functions.
   */
  encodeSpecial?: (value: unknown) => unknown;
  /**
   * The input is JSON already, with its own tags (a server tree's payload): no type is tagged and
   * no object is wrapped, values are only addressed.
   */
  encoded?: boolean;
}

/**
 * Serializes props with every value whose JSON reaches `minLength` replaced by a reference to it.
 * Types JSON cannot hold are tagged first (the codec), so a `Map` or a `Date` is addressed like
 * any other value. Inner values are addressed first, so a large value that differs between pages
 * in one place still shares its unchanged parts.
 */
export function addressValues(
  props: Record<string, unknown>,
  { minLength = VALUE_MIN_LENGTH, encodeSpecial, encoded = false }: AddressOptions = {},
): AddressedProps {
  const values = new Map<string, AddressedValue>();
  const reference = (json: string, children: string[], parent: string[]) => {
    const key = hashValue(json);
    if (!values.has(key)) values.set(key, { key, json, children });
    parent.push(key);
    return `{"$":"${REFERENCE_TAG}","v":"${key}"}`;
  };
  const seen = new Set<object>();
  // Returns the value's JSON with large inner values replaced, and the length of its full JSON:
  // a value is addressed by its full size, so a tree whose parts are all addressed still gets one
  // key of its own.
  const encode = (value: unknown, parent: string[]): [json: string, length: number] => {
    const special = encoded ? undefined : encodeSpecial?.(value);
    if (special !== undefined) {
      const json = JSON.stringify(special);
      return [json, json.length];
    }
    const leaf = encoded ? undefined : encodeLeaf(value);
    if (leaf) {
      const json = JSON.stringify(leaf);
      return [json, json.length];
    }
    if (typeof value === "function") throw new TypeError("functions are not serializable");
    if (typeof value === "symbol") throw new TypeError("symbol values are not serializable");
    if (value === null || typeof value !== "object") {
      const json = JSON.stringify(value);
      return [
        typeof value === "string" && json.length >= minLength ? reference(json, [], parent) : json,
        json.length,
      ];
    }
    if (seen.has(value)) throw new TypeError("circular values are not serializable");
    seen.add(value);
    try {
      if (!encoded && (value instanceof Map || value instanceof Set)) {
        // The entries become an array inside the tag, addressed like any array.
        const entries =
          value instanceof Map ? Array.from(value, ([key, entry]) => [key, entry]) : [...value];
        const [json, length] = encode(entries, parent);
        const tag = value instanceof Map ? "M" : "S";
        const prefix = `{"$":"${tag}","v":`;
        return [`${prefix}${json}}`, length + prefix.length + 1];
      }
      const prototype = Object.getPrototypeOf(value);
      if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("class instances are not serializable");
      }
      const own: string[] = [];
      let length = 2;
      const parts: string[] = [];
      if (Array.isArray(value)) {
        for (const entry of value) {
          const [json, entryLength] = encode(entry, own);
          parts.push(json);
          length += entryLength + 1;
        }
      } else {
        for (const [key, entry] of Object.entries(value)) {
          const [json, entryLength] = encode(entry, own);
          const name = JSON.stringify(key);
          parts.push(`${name}:${json}`);
          length += name.length + entryLength + 2;
        }
      }
      let json = Array.isArray(value) ? `[${parts.join(",")}]` : `{${parts.join(",")}}`;
      if (!encoded && !Array.isArray(value) && needsObjectTag(value)) {
        json = `{"$":"${OBJECT_TAG}","v":${json}}`;
        length += 14;
      }
      // A thin wrapper around one addressed value is not worth a key and a script of its own.
      const wrapper = own.length === 1 && json.length < minLength / 4;
      if (length >= minLength && !wrapper) return [reference(json, own, parent), length];
      parent.push(...own);
      return [json, length];
    } finally {
      seen.delete(value);
    }
  };
  const roots: string[] = [];
  const json = `{${Object.entries(props)
    .map(([key, entry]) => `${JSON.stringify(key)}:${encode(entry, roots)[0]}`)
    .join(",")}}`;
  return { json, values, roots };
}

/**
 * The values a response sends for `addressed`, parents first. A value the browser holds is left
 * out with everything inside it: the browser kept those when it read the value.
 */
export function selectValuesToSend(
  addressed: AddressedProps,
  held: ReadonlySet<string> | null,
): AddressedValue[] {
  const send: AddressedValue[] = [];
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    if (held?.has(key)) return;
    const value = addressed.values.get(key)!;
    send.push(value);
    value.children.forEach(visit);
  };
  addressed.roots.forEach(visit);
  return send;
}

/**
 * The value keys a request names (`F-Values`): well-formed keys only, at most `MAX_HELD_VALUES`.
 *
 * A response that leaves values out is one browser's. Integrations must keep it out of shared
 * caches (CDN, ISR, PPR shells), and add `Vary: F-Values` to cacheable responses.
 */
export function parseHeldValues(
  input: Request | Headers | string | null | undefined,
): ReadonlySet<string> {
  const header =
    typeof input === "string" || input == null
      ? input
      : (input instanceof Request ? input.headers : input).get(VALUES_HEADER);
  const held = new Set<string>();
  if (!header) return held;
  for (const key of header.split(",", MAX_HELD_VALUES * 2)) {
    const trimmed = key.trim();
    if (VALUE_KEY_PATTERN.test(trimmed)) held.add(trimmed);
    if (held.size === MAX_HELD_VALUES) break;
  }
  return held;
}

/** A value script's JSON, safe inside a `<script>` element. */
export function escapeScriptJson(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
