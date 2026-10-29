/**
 * The names furrow writes into HTML, JSON and headers, and reads back. Elements, script types and
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
/** The element that keeps server output passed to an island as children. */
export const SLOT_ELEMENT = "f-slot";
/** The script type of a page's server tree, rebuilt in the browser without the page's HTML. */
export const TREE_SCRIPT_TYPE = "f/tree";
/** The script type of a server tree chunk that streamed in after the tree. */
export const CHUNK_SCRIPT_TYPE = "f/chunk";
/** The element around server HTML inside a server tree. */
export const HTML_ELEMENT = "f-html";

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
/** `{"$":"o","v":{…}}`: app data that has its own `$` key. */
export const OBJECT_TAG = "o";

/** Request header: the value keys the browser holds. */
export const VALUES_HEADER = "F-Values";
/** Request header: the layouts on screen, so the response can leave them out. */
export const LAYOUTS_HEADER = "F-Layouts";
/** Request header: `tree` asks for a page's server tree without its HTML. */
export const RENDER_HEADER = "F-Render";
/** Request header: the server action a client calls. */
export const ACTION_HEADER = "F-Action";

/** Form field: the server action a form posts to. */
export const ACTION_FIELD = "$F_ACTION";
/** Form field: the action's sealed captured values. */
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
