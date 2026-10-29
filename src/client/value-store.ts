/**
 * The browser's store of values sent once. It keeps every value it has read, parses each once,
 * and gives islands that share a value the same object. A navigation names the keys it holds
 * (`valueHeaders()`), so the server leaves those values out.
 */
import {
  MAX_HELD_VALUES,
  OBJECT_TAG,
  REFERENCE_TAG,
  TAG,
  TAG_VALUE,
  VALUES_HEADER,
  VALUE_KEY_PATTERN,
  VALUE_SCRIPT_TYPE,
  getTag,
} from "../protocol/wire";

/** Past this many values the store starts over at the next navigation. */
const MAX_STORED_VALUES = 1024;

const STORE_KEY = Symbol.for("islx.values");

export interface ValueStore {
  /** Reads the value scripts under `root` that the store does not hold yet. */
  ingest(root: ParentNode): void;
  /**
   * Replaces value references in parsed JSON with the values they name. Other tags stay as they
   * are, for the codec to decode afterwards.
   */
  resolve(value: unknown): unknown;
  /** The `F-Values` header value naming the keys the store holds, or undefined. */
  heldHeader(): string | undefined;
  /** Forgets every value, as after a full page load. */
  clear(): void;
}

interface Entry {
  json: string;
  state: "raw" | "resolving" | "resolved";
  value?: unknown;
}

export function createValueStore(): ValueStore {
  // Map order is use order: a value moves to the end each time an island resolves it.
  const entries = new Map<string, Entry>();
  const read = new WeakSet<Element>();

  const get = (key: string): unknown => {
    const entry = entries.get(key);
    if (!entry) throw new Error(`islx value ${key} was not found`);
    entries.delete(key);
    entries.set(key, entry);
    if (entry.state === "resolved") return entry.value;
    if (entry.state === "resolving") throw new Error(`islx value ${key} refers to itself`);
    entry.state = "resolving";
    try {
      entry.value = resolve(JSON.parse(entry.json));
    } catch (error) {
      entry.state = "raw";
      throw error;
    }
    entry.state = "resolved";
    entry.json = "";
    return entry.value;
  };

  const resolve = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(resolve);
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    const tag = getTag(object);
    if (tag === REFERENCE_TAG && typeof object[TAG_VALUE] === "string") {
      return get(object[TAG_VALUE]);
    }
    // App data wrapped as `o` may itself look tagged: resolve only inside its properties.
    if (tag === OBJECT_TAG && object[TAG_VALUE] && typeof object[TAG_VALUE] === "object") {
      return {
        [TAG]: OBJECT_TAG,
        [TAG_VALUE]: resolveEntries(object[TAG_VALUE] as Record<string, unknown>),
      };
    }
    return resolveEntries(object);
  };

  const resolveEntries = (object: Record<string, unknown>): Record<string, unknown> => {
    const resolved: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
      Object.defineProperty(resolved, key, {
        value: resolve(object[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return resolved;
  };

  return {
    ingest(root) {
      for (const script of root.querySelectorAll(`script[type="${VALUE_SCRIPT_TYPE}"]`)) {
        if (read.has(script)) continue;
        read.add(script);
        const key = script.getAttribute("name") ?? "";
        if (VALUE_KEY_PATTERN.test(key) && !entries.has(key)) {
          entries.set(key, { json: script.textContent || "null", state: "raw" });
        }
      }
    },
    resolve,
    heldHeader() {
      if (entries.size > MAX_STORED_VALUES) entries.clear();
      if (entries.size === 0) return undefined;
      return [...entries.keys()].slice(-MAX_HELD_VALUES).join(",");
    },
    clear() {
      entries.clear();
    },
  };
}

/** The page's value store, shared by every copy of islx on the page. */
export function getValueStore(): ValueStore {
  const scope = globalThis as typeof globalThis & Record<symbol, ValueStore | undefined>;
  return (scope[STORE_KEY] ??= createValueStore());
}

/** Headers a navigation sends so the server can leave out values the browser holds. */
export function valueHeaders(): Record<string, string> {
  const scope = globalThis as typeof globalThis & Record<symbol, ValueStore | undefined>;
  const held = scope[STORE_KEY]?.heldHeader();
  return held ? { [VALUES_HEADER]: held } : {};
}
