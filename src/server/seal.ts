/**
 * Sealing an action's captured values. An inline `"use server"` function that reads a variable of
 * the render around it (`user` below) runs in a later request, so the value makes the round trip
 * through the browser:
 *
 *   async function Page() {
 *     const user = await getUser();
 *     async function rename(form) {
 *       "use server";
 *       await db.rename(user.id, form.get("name"));
 *     }
 *     return <form action={rename}>…</form>;
 *   }
 *
 * The browser must not read or change it, so it travels sealed: AES-GCM with a fresh random IV,
 * and the action id as additional data, so a sealed value only opens for the action it was made
 * for. Web Crypto only, so it runs on Node, Bun, Deno, workerd and every other runtime with
 * `crypto.subtle`.
 *
 * Sealing is asynchronous. React's server renderer waits for it: a form whose action's values
 * are still sealing suspends, and renders once they are ready.
 *
 *   sealed = base64url( version (1 byte) ‖ key id (1 byte) ‖ IV (12 bytes) ‖ ciphertext+tag )
 */
import {
  EncodeError,
  decode,
  encode,
  type DecodeOptions,
  type EncodeOptions,
} from "../protocol/codec";

const VERSION = 1;
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Thrown when a sealed value does not open: changed, made for another action, or stale. */
export class SealError extends Error {
  /**
   * `stale`: sealed with a key this server does not have, as after a deploy that changed keys.
   * The page should reload. `invalid`: anything else; answer 400.
   */
  readonly reason: "stale" | "invalid";
  constructor(reason: "stale" | "invalid", message: string) {
    super(message);
    this.name = "SealError";
    this.reason = reason;
  }
}

export interface ActionKeys {
  /** The key new values are sealed with. */
  current: CryptoKey;
  /** Its id, written into each sealed value (0-255). */
  currentId: number;
  /**
   * Every key that opens a value, by id: the current one and earlier ones still accepted. Ids are
   * one byte, so two keys can share one; each is tried.
   */
  byId: ReadonlyMap<number, readonly CryptoKey[]>;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/** A new random key, as base64url: what `FURROW_ACTIONS_KEY` holds. */
export function generateActionKey(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

async function importKey(secret: string): Promise<CryptoKey> {
  const bytes = fromBase64url(secret.trim());
  if (!bytes || bytes.length !== KEY_BYTES) {
    throw new TypeError(
      "an actions key must be 32 random bytes as base64url; create one with `npx furrow key`",
    );
  }
  return crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** The key's id: its first byte of SHA-256, so a value names the key that sealed it. */
async function keyId(secret: string): Promise<number> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret.trim()));
  return new Uint8Array(digest)[0]!;
}

/**
 * The keys values are sealed and opened with. `current` seals; `previous` keys still open
 * values, so pages rendered before a key rotation keep working until they are reloaded.
 *
 * Every server that may receive an action must have the same keys. When an app runs more than
 * one instance, or builds and serves on different machines, set them from the environment.
 */
export async function createActionKeys(
  current: string,
  previous: readonly string[] = [],
): Promise<ActionKeys> {
  const byId = new Map<number, CryptoKey[]>();
  const seen = new Set<string>();
  const add = async (secret: string) => {
    const trimmed = secret.trim();
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    const id = await keyId(trimmed);
    const key = await importKey(trimmed);
    byId.set(id, [...(byId.get(id) ?? []), key]);
    return { id, key };
  };
  const { id: currentId, key: currentKey } = (await add(current))!;
  for (const secret of previous) await add(secret);
  return { current: currentKey, currentId, byId };
}

function additionalData(actionId: string): Uint8Array {
  return new TextEncoder().encode(`furrow:action:${actionId}`);
}

export interface SealOptions extends Pick<EncodeOptions, "encodeFunction"> {
  /**
   * The captured variables' names, in order, for error messages: "`db` cannot be captured by the
   * server action rename (src/page.tsx): class instances (Pool) are not serializable".
   */
  names?: readonly string[];
  /** Names the action in error messages. */
  label?: string;
}

/** Seals an action's captured values for the browser to carry. */
export async function sealBound(
  keys: ActionKeys,
  actionId: string,
  values: readonly unknown[],
  options: SealOptions = {},
): Promise<string> {
  let json: string;
  try {
    json = JSON.stringify(
      values.map((value, index) =>
        encode(value, {
          encodeFunction: options.encodeFunction,
          path: [options.names?.[index] ?? `$${index}`],
        }),
      ),
    );
  } catch (error) {
    if (error instanceof EncodeError) {
      const name = String(error.path[0]);
      const where = error.path.length > 1 ? ` (at ${error.location})` : "";
      const action = options.label ? ` ${options.label}` : "";
      throw new TypeError(
        `\`${name}\` cannot be captured by the server action${action}${where}: ${error.reason}. ` +
          "Read it inside the action instead, or capture a plain value.",
        { cause: error },
      );
    }
    throw error;
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: additionalData(actionId) as BufferSource },
      keys.current,
      new TextEncoder().encode(json),
    ),
  );
  const sealed = new Uint8Array(2 + IV_BYTES + ciphertext.length);
  sealed[0] = VERSION;
  sealed[1] = keys.currentId;
  sealed.set(iv, 2);
  sealed.set(ciphertext, 2 + IV_BYTES);
  return base64url(sealed);
}

/**
 * Opens values sealed for `actionId`. Throws a `SealError`: `stale` when no key this server has
 * sealed them, `invalid` when they were changed or sealed for another action.
 */
export async function unsealBound(
  keys: ActionKeys,
  actionId: string,
  sealed: string,
  options: Pick<DecodeOptions, "decodeReference"> = {},
): Promise<unknown[]> {
  const bytes = fromBase64url(sealed);
  if (!bytes || bytes.length < 2 + IV_BYTES + 16) {
    throw new SealError("invalid", "sealed action values are malformed");
  }
  if (bytes[0] !== VERSION) {
    throw new SealError("stale", "sealed action values use another format version");
  }
  const candidates = keys.byId.get(bytes[1]!);
  if (!candidates) {
    throw new SealError("stale", "sealed action values use a key this server does not have");
  }
  let plaintext: ArrayBuffer | undefined;
  for (const key of candidates) {
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytes.subarray(2, 2 + IV_BYTES) as BufferSource,
          additionalData: additionalData(actionId) as BufferSource,
        },
        key,
        bytes.subarray(2 + IV_BYTES) as BufferSource,
      );
      break;
    } catch {
      // Changed, sealed for another action, or another key with the same id.
    }
  }
  if (!plaintext)
    throw new SealError("invalid", "sealed action values do not open for this action");
  // The server wrote this JSON and the key proves it, so a decoding failure is a bug or a format
  // change, not an attack: report it as it is.
  const values = decode(JSON.parse(new TextDecoder().decode(plaintext)), options);
  if (!Array.isArray(values)) throw new SealError("invalid", "sealed action values are malformed");
  return values;
}
