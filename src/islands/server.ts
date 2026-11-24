/**
 * @farm.js/islx/islands/server: islands for any renderer, on the server. The renderer writes a
 * component's HTML with its own string renderer, or its own elements; this gives it the wire format
 * the browser runtime (`@farm.js/islx/islands/client`) hydrates. Server only.
 */
import type { IslandStrategy } from "../client/schedule";
import { ISLAND_ELEMENT, PROPS_SCRIPT_TYPE, VALUE_SCRIPT_TYPE } from "../protocol/wire";
import { encodeActionReference } from "../server/actions";
import { addressValues, escapeScriptJson, selectValuesToSend } from "../server/values";

export interface ResolveIslandMarkupInput {
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
  /**
   * The value keys this response already sent, or the browser said it holds (`F-Values`). Keep one
   * set for the whole response: keys this island sends are added, so a shared value goes once.
   */
  sent?: Set<string>;
}

export interface IslandMarkupInput extends ResolveIslandMarkupInput {
  /** The component rendered with `props` by the renderer's own string renderer. */
  html: string;
}

/**
 * HTML attributes as they appear in the markup, not escaped yet: the renderer escapes them as it
 * writes any attribute. `style` is a CSS string, which a renderer that takes an object converts.
 */
export type IslandAttributes = Readonly<Record<string, string>>;

export interface IslandScript {
  attributes: IslandAttributes;
  /** Already escaped for a script element. Write it raw, not as text the renderer escapes again. */
  text: string;
}

/** An island's markup in parts, for a renderer that builds elements instead of strings. */
export interface IslandMarkupParts {
  /** Value scripts to write before the island: the values this response has not sent yet. */
  values: IslandScript[];
  /** The element to write around the component, with the component inside it. */
  element: { tag: string; attributes: IslandAttributes };
  /** The props script to write right after the element. */
  script: IslandScript;
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
 * The island's markup in parts: the value scripts it sends first, the `<f-island>` element to put
 * around the component, and its props script, in the wire format `@farm.js/islx/react` uses. It
 * leaves out what React's islands add on top: the `ids` position for `useId`, slots and promise
 * props.
 *
 * Props are JSON values, the codec's types (`Date`, `Map`, `Set`, `BigInt`, typed arrays and the
 * rest) and server actions. A function, a promise or a renderer element throws, naming the prop's
 * component, because the browser could not rebuild it.
 */
export function resolveIslandMarkup(input: ResolveIslandMarkupInput): IslandMarkupParts {
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

  return {
    values: values.map((value) => ({
      attributes: { type: VALUE_SCRIPT_TYPE, name: value.key },
      text: escapeScriptJson(value.json),
    })),
    element: {
      tag: ISLAND_ELEMENT,
      attributes: {
        src: input.src,
        export: exportName,
        props: input.id,
        strategy,
        style: "display:contents",
      },
    },
    script: {
      attributes: { type: PROPS_SCRIPT_TYPE, for: input.id },
      text: escapeScriptJson(addressed.json),
    },
  };
}

function writeAttributes(attributes: IslandAttributes): string {
  let written = "";
  for (const [name, value] of Object.entries(attributes)) {
    written += ` ${name}="${escapeAttribute(value)}"`;
  }
  return written;
}

function writeScript(script: IslandScript): string {
  return `<script${writeAttributes(script.attributes)}>${script.text}</script>`;
}

/**
 * The island's HTML: `resolveIslandMarkup`'s parts written around the renderer's HTML, for a
 * renderer that renders the component to a string.
 */
export function renderIslandMarkup(input: IslandMarkupInput): string {
  const { values, element, script } = resolveIslandMarkup(input);
  return (
    values.map(writeScript).join("") +
    `<${element.tag}${writeAttributes(element.attributes)}>` +
    input.html +
    `</${element.tag}>` +
    writeScript(script)
  );
}
