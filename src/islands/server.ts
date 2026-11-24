/**
 * @farm.js/islx/islands/server: islands for any renderer, on the server. The renderer writes a
 * component's HTML with its own string renderer; this wraps it in the wire format the browser
 * runtime (`@farm.js/islx/islands/client`) hydrates. Server only.
 */
import type { IslandStrategy } from "../client/schedule";
import { ISLAND_ELEMENT, PROPS_SCRIPT_TYPE, VALUE_SCRIPT_TYPE } from "../protocol/wire";
import { encodeActionReference } from "../server/actions";
import { addressValues, escapeScriptJson, selectValuesToSend } from "../server/values";

export interface IslandMarkupInput {
  /** The module the browser imports for the island, as `<f-island src>` carries it. */
  src: string;
  /** The component's export in that module. Default `"default"`. */
  export?: string;
  /** When the island hydrates. Default `"load"`. */
  strategy?: IslandStrategy;
  /** Names the island's props script. Unique within the response. */
  id: string;
  /** The props the browser hydrates the component with. */
  props: Record<string, unknown>;
  /** The component rendered with `props` by the renderer's own string renderer. */
  html: string;
  /**
   * The value keys this response already sent, or the browser said it holds (`F-Values`). Keep one
   * set for the whole response: keys this island sends are added, so a shared value goes once.
   */
  sent?: Set<string>;
}

const ATTRIBUTE_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  '"': "&quot;",
  "<": "&lt;",
  ">": "&gt;",
};

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/g, (character) => ATTRIBUTE_ESCAPES[character]!);
}

function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * The island's HTML: the value scripts it sends first, `<f-island>` around the renderer's HTML,
 * and its props script, in the wire format `@farm.js/islx/react` uses. It leaves out what React's
 * islands add on top: the `ids` position for `useId`, slots and promise props.
 *
 * Props are JSON values, the codec's types (`Date`, `Map`, `Set`, `BigInt`, typed arrays and the
 * rest) and server actions. A function, a promise or a renderer element throws, naming the prop's
 * component, because the browser could not rebuild it.
 */
export function renderIslandMarkup(input: IslandMarkupInput): string {
  const exportName = input.export ?? "default";
  const strategy = input.strategy ?? "load";
  let addressed: ReturnType<typeof addressValues>;
  try {
    addressed = addressValues(input.props, {
      encodeSpecial(value) {
        if (typeof value === "function") {
          const reference = encodeActionReference(value);
          if (reference) return reference;
          const name = (value as { name?: string }).name;
          throw new TypeError(
            `functions are not serializable${name ? ` (${name})` : ""}: pass a server action, or move the function into the client component`,
          );
        }
        if (isThenable(value)) {
          throw new TypeError(
            "a promise cannot be a prop of a renderer-neutral island yet: await it on the server and pass its value",
          );
        }
        return undefined;
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeError(
      `${exportName} (${input.src}) cannot get its props in the browser: ${message}`,
      { cause: error },
    );
  }

  const values = selectValuesToSend(addressed, input.sent ?? null);
  for (const value of values) input.sent?.add(value.key);

  return (
    values
      .map(
        (value) =>
          `<script type="${VALUE_SCRIPT_TYPE}" name="${escapeAttribute(value.key)}">${escapeScriptJson(value.json)}</script>`,
      )
      .join("") +
    `<${ISLAND_ELEMENT} src="${escapeAttribute(input.src)}" export="${escapeAttribute(exportName)}" props="${escapeAttribute(input.id)}" strategy="${strategy}" style="display:contents">` +
    input.html +
    `</${ISLAND_ELEMENT}>` +
    `<script type="${PROPS_SCRIPT_TYPE}" for="${escapeAttribute(input.id)}">${escapeScriptJson(addressed.json)}</script>`
  );
}
