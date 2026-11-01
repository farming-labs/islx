/**
 * The names islx writes into HTML, JSON and headers, and reads back. Elements, script types and
 * headers carry the `f` prefix; JSON uses one reserved key, `$`, whose value is a short tag. See
 * SPEC.md for the whole format.
 *
 *   <f-island src="/src/toc.tsx" export="Toc" props="_R_b_" strategy="load">…</f-island>
 *   <script type="f/props" for="_R_b_">{…props…}</script>
 *   <script type="f/value" name="04jiw29097x8ki">…a value sent once…</script>
 *   <f-slot name="_R_5_s0">…server output passed as children…</f-slot>
 */

/** The element around a client component's server HTML. */
export const ISLAND_ELEMENT = "f-island";
/** The script type of an island's props; its `for` attribute names the island. */
export const PROPS_SCRIPT_TYPE = "f/props";
/** The script type of a value sent once; its `name` attribute is the value's key. */
export const VALUE_SCRIPT_TYPE = "f/value";
/** Set on an island once it hydrated (and its held interaction was replayed). */
export const HYDRATED_ATTRIBUTE = "hydrated";
/** The element that keeps server output passed to an island as children. */
export const SLOT_ELEMENT = "f-slot";
/** The script type of a page's server tree, rebuilt in the browser without the page's HTML. */
export const TREE_SCRIPT_TYPE = "f/tree";
/** The script type of a server tree chunk that streamed in after the tree. */
export const CHUNK_SCRIPT_TYPE = "f/chunk";
/** The element around server HTML inside a server tree. */
export const HTML_ELEMENT = "f-html";
/**
 * The script type of a promise's outcome, written when it settles: `{"v":value}`, or `{"e":1}` for
 * a rejection. Its `name` attribute names the promise.
 */
export const PROMISE_SCRIPT_TYPE = "f/promise";
/** The script type of React's form state after a `useActionState` form post, for hydration. */
export const FORM_STATE_SCRIPT_TYPE = "f/form-state";

/** The reserved JSON key whose value is a tag. */
export const TAG = "$";
/** The key of a tagged object's data. */
export const TAG_VALUE = "v";
/** The key of an action's sealed captured values. */
export const TAG_BOUND = "b";

/** `{"$":"r","v":key}`: a value sent once, by key. */
export const REFERENCE_TAG = "r";
/** `{"$":"s","v":name}`: a slot. */
export const SLOT_TAG = "s";
/** `{"$":"a","v":id}` or `{"$":"a","v":id,"b":sealed}`: a server action. */
export const ACTION_TAG = "a";
/**
 * `{"$":"T","v":name}`: a promise an island receives, settled by the `f/promise` script `name`.
 * (Inside a server tree, `{"$":"P","v":value}` is a promise that resolved already.)
 */
export const PROMISE_TAG = "T";
/** `{"$":"o","v":{…}}`: app data that has its own `$` key. */
export const OBJECT_TAG = "o";
/** `{"$":"F","v":n}`: a `FormData` argument, sent as fields of a multipart call. */
export const FORM_DATA_TAG = "F";
/** `{"$":"K","v":n}`: a `Blob` or `File` argument, sent as a field of a multipart call. */
export const BLOB_TAG = "K";
/** The multipart field of a call's JSON (`{"a":…,"b":…}`) when it carries form data or files. */
export const CALL_FIELD = "$F_CALL";
/** The multipart field name of attachment `n`, or of field `key` of `FormData` attachment `n`. */
export function attachmentField(index: number, key?: string): string {
  return key === undefined ? `$F_${index}` : `$F_${index}_${key}`;
}

/** Request header: the value keys the browser holds. */
export const VALUES_HEADER = "F-Values";
/** Request header: the layouts on screen, so the response can leave them out. */
export const LAYOUTS_HEADER = "F-Layouts";
/** Request header: `tree` asks for a page's server tree without its HTML. */
export const RENDER_HEADER = "F-Render";
/** Request header: the server action a client calls. */
export const ACTION_HEADER = "F-Action";

/** Response header: the action id is unknown here, as after a deploy. The page should reload. */
export const ACTION_STALE_HEADER = "F-Action-Stale";

/**
 * A form or button posting a server action without JavaScript. React names the field (a hidden
 * input for a form, the button's own name for a button) and writes the data fields after it; the
 * last name a submission carries is the action that runs, so a clicked button wins over its form.
 *
 *   <input type="hidden" name="$F_REF_R_1_">
 *   <input type="hidden" name="$F_R_1_:A" value="…action id…">
 *   <input type="hidden" name="$F_R_1_:B" value="…sealed values…">
 */
export const FORM_REF_PREFIX = "$F_REF_";
/** A form field of the action posted under `prefix`: `A` its id, `B` its sealed values. */
export function formFieldName(prefix: string, field: "A" | "B"): string {
  return `$F_${prefix}:${field}`;
}
/** Every form field the runtime owns starts with this, and is removed before an action runs. */
export const FORM_FIELD_PREFIX = "$F_";

/**
 * The action a form submission posts: the last `$F_REF_` field names it, so a clicked button
 * wins over its form. Null for a form that posts no action.
 */
export function readPostedAction(form: FormData): { id: string; token?: string } | null {
  let prefix: string | null = null;
  for (const key of form.keys()) {
    if (key.startsWith(FORM_REF_PREFIX)) prefix = key.slice(FORM_REF_PREFIX.length);
  }
  if (prefix === null) return null;
  const id = form.get(formFieldName(prefix, "A"));
  const token = form.get(formFieldName(prefix, "B"));
  if (typeof id !== "string") return null;
  return { id, token: typeof token === "string" ? token : undefined };
}

/** Removes the runtime's fields, so the action sees only the form's own. */
export function stripRuntimeFields(form: FormData): void {
  // A snapshot of the keys: deleting while iterating the form itself skips entries.
  for (const key of new Set(form.keys())) {
    if (key.startsWith(FORM_FIELD_PREFIX) || key === ACTION_KEY_FIELD) form.delete(key);
  }
}
/** React's field naming which `useActionState` hook a form posted from. */
export const ACTION_KEY_FIELD = "$ACTION_KEY";
/** A `FormData` argument's field for its action's sealed values, in calls from JavaScript. */
export const BOUND_FIELD = "$F_BOUND";

/** A value key: 14 base-36 characters. */
export const VALUE_KEY_PATTERN = /^[0-9a-z]{14}$/;
/** Value keys a request names at most: the most recently used ones. */
export const MAX_HELD_VALUES = 128;

/**
 * The tag of a tagged object (`{"$":tag}`, `{"$":tag,"v":data}`, or an action's
 * `{"$":"a","v":id,"b":sealed}`), or undefined for anything else.
 */
export function getTag(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const tag = (value as Record<string, unknown>)[TAG];
  if (typeof tag !== "string") return undefined;
  const keys = Object.keys(value);
  if (keys.length === 1) return tag;
  if (keys.length === 2 && TAG_VALUE in value) return tag;
  if (keys.length === 3 && tag === ACTION_TAG && TAG_VALUE in value && TAG_BOUND in value) {
    return tag;
  }
  return undefined;
}
