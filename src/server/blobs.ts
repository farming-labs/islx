/**
 * Blobs a server sends to the browser, in props or an action's result. Their bytes are read before
 * the value is encoded (encoding is synchronous), and travel inline: a `Blob` as `b`, a `FormData`
 * as `f` with its entries, as React Server Components send them. A `File` arrives as a `Blob`.
 */
import { readIterator, toBase64 } from "../protocol/codec";
import { getStreamKind } from "../protocol/stream";
import { TAG, TAG_VALUE } from "../protocol/wire";

const bytes = new WeakMap<Blob, Uint8Array>();
const reads = new WeakMap<object, Promise<void> | null>();

/**
 * Reads the blobs in `value` (in a `FormData` too) that were not read yet. Returns null when there
 * are none, else a promise to wait for: the same one for the same value, so a render that suspends
 * on it and runs again reads it settled.
 */
export function prepareBlobs(value: unknown): Promise<void> | null {
  if (!value || typeof value !== "object") return null;
  if (reads.has(value)) return reads.get(value)!;
  const found: Blob[] = [];
  const seen = new Set<object>();
  const visit = (entry: unknown) => {
    if (!entry || typeof entry !== "object" || seen.has(entry)) return;
    seen.add(entry);
    if (typeof Blob === "function" && entry instanceof Blob) {
      if (!bytes.has(entry)) found.push(entry);
      return;
    }
    // What a promise or stream settles to is read when it settles.
    if (typeof (entry as { then?: unknown }).then === "function" || getStreamKind(entry)) return;
    if (typeof FormData === "function" && entry instanceof FormData) {
      for (const [, field] of entry) visit(field);
      return;
    }
    if (entry instanceof Map) {
      for (const [key, field] of entry) {
        visit(key);
        visit(field);
      }
      return;
    }
    if (entry instanceof Set) {
      for (const field of entry) visit(field);
      return;
    }
    const entries = readIterator(entry);
    if (entries) return entries.forEach(visit);
    if (Array.isArray(entry)) return entry.forEach(visit);
    const prototype = Object.getPrototypeOf(entry);
    if (prototype === Object.prototype || prototype === null) Object.values(entry).forEach(visit);
  };
  visit(value);
  const read =
    found.length === 0
      ? null
      : Promise.all(
          found.map(async (blob) => {
            bytes.set(blob, new Uint8Array(await blob.arrayBuffer()));
          }),
        ).then(() => {});
  reads.set(value, read);
  return read;
}

function encodeBlob(blob: Blob): Record<string, unknown> {
  const read = bytes.get(blob);
  if (!read) throw new TypeError("a Blob was sent before its bytes were read (prepareBlobs)");
  return { [TAG]: "b", [TAG_VALUE]: [blob.type, toBase64(read)] };
}

/** `b` for a read `Blob`, `f` for a `FormData`, or undefined for any other value. */
export function encodeSentObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof Blob === "function" && value instanceof Blob) return encodeBlob(value);
  if (typeof FormData === "function" && value instanceof FormData) {
    return {
      [TAG]: "f",
      [TAG_VALUE]: Array.from(value, ([name, field]) => [
        name,
        typeof field === "string" ? field : encodeBlob(field),
      ]),
    };
  }
  return undefined;
}
