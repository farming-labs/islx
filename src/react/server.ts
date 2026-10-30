/**
 * @farmjs/islx/react/server: rendering a React page with islands. Importing it gives islands the
 * server code they need (values, action references); `renderToStream` renders a page.
 */
import * as React from "react";
import { renderToReadableStream, type RenderToReadableStreamOptions } from "react-dom/server";
import { encode } from "../protocol/codec";
import { FORM_STATE_SCRIPT_TYPE, RENDER_HEADER } from "../protocol/wire";
import { PREHYDRATION_SCRIPT } from "../client/prehydration";
import { encodeActionReference } from "../server/actions";
import { getBuildDefaults } from "../server/build";
import type { ReactFormState } from "../server/handle";
import {
  addressValues,
  escapeScriptJson,
  parseHeldValues,
  selectValuesToSend,
} from "../server/values";
import { getContexts, runtimeTagged, setIslandServerHook } from "./island";

setIslandServerHook({
  encode(props, held) {
    const addressed = addressValues(props, {
      encodeSpecial: (value) => {
        if (value && typeof value === "object" && runtimeTagged.has(value)) return value;
        if (typeof value === "function") {
          const reference = encodeActionReference(value);
          if (reference) return reference;
          const name = (value as { name?: string }).name;
          throw new TypeError(
            `functions are not serializable${name ? ` (${name})` : ""}: pass a server action, or move the function into the client component`,
          );
        }
        return undefined;
      },
    });
    return {
      json: addressed.json,
      values: selectValuesToSend(addressed, held).map(({ key, json }) => ({ key, json })),
    };
  },
  escape: escapeScriptJson,
  address(payload, skip) {
    const addressed = addressValues(payload, { encoded: true });
    return {
      json: addressed.json,
      values: selectValuesToSend(addressed, skip).map(({ key, json }) => ({ key, json })),
    };
  },
  action: (value) => encodeActionReference(value),
});

export interface RenderToStreamOptions extends Omit<RenderToReadableStreamOptions, "formState"> {
  /**
   * The request being answered: its `F-Values` header names the values the browser holds, and
   * the page leaves them out. Leave it out for a response that may be shared (a CDN, a static
   * page): every value is sent.
   */
  request?: Request;
  /**
   * The form state `handleAction` passed to `renderFormState`, after a form posted from a
   * `useActionState` hook. The page shows the action's result, and so do its islands once they
   * hydrate.
   */
  formState?: ReactFormState | null;
  /**
   * Adds the browser entry that hydrates islands (from the bundler plugin) to the page. Default
   * true; a framework that adds its own scripts turns it off.
   */
  bootstrap?: boolean;
  /**
   * Adds the inline script that holds a click or a submit on an island before the browser entry
   * has run, to replay it once the island hydrates. Default: with the browser entry.
   */
  prehydration?: boolean;
}

/** The script carrying a form post's state to the browser, for `hydrateRoot`. */
function FormStateScript({ formState }: { formState: ReactFormState }) {
  return React.createElement("script", {
    type: FORM_STATE_SCRIPT_TYPE,
    dangerouslySetInnerHTML: { __html: escapeScriptJson(JSON.stringify(encode(formState))) },
  });
}

/**
 * Renders a page whose client components are islands. A response rendered with a `request` whose
 * browser holds values is that browser's alone: send it `private` and never share it.
 *
 * A navigation (`F-Render` on the request) gets the whole page in one piece: the browser puts it
 * in place with DOM methods, which run no scripts, so the page cannot stream in with React's
 * inline scripts. Every Suspense boundary has resolved before the first byte.
 */
export async function renderToStream(
  element: React.ReactNode,
  { request, formState, bootstrap = true, prehydration, ...options }: RenderToStreamOptions = {},
): Promise<ReadableStream<Uint8Array> & { allReady: Promise<void> }> {
  const held = request ? parseHeldValues(request) : null;
  const { render } = getContexts();
  const tree = React.createElement(
    render.Provider,
    { value: { held: held && held.size > 0 ? held : null, sent: new Set<string>() } },
    element,
    formState ? React.createElement(FormStateScript, { formState }) : null,
  );
  const entry = bootstrap ? getBuildDefaults().entry : undefined;
  const bootstrapModules = entry
    ? [...(options.bootstrapModules ?? []), entry]
    : options.bootstrapModules;
  // The inline script runs as soon as the page's content is parsed, before the deferred entry.
  const bootstrapScriptContent =
    (prehydration ?? entry !== undefined)
      ? `${PREHYDRATION_SCRIPT}${options.bootstrapScriptContent ?? ""}`
      : options.bootstrapScriptContent;
  const stream = await renderToReadableStream(tree, {
    ...options,
    bootstrapModules,
    bootstrapScriptContent,
    formState: formState as never,
  });
  if (request?.headers.has(RENDER_HEADER)) await stream.allReady;
  return stream;
}

/** Whether a response rendered for `request` leaves out values its browser holds. */
export function isPersonalized(request: Request): boolean {
  return parseHeldValues(request).size > 0;
}

export {
  IslandsProvider,
  createIsland,
  getClientReference,
  isolateIslands,
  setRenderStateResolver,
  withinClientRoot,
  type ClientReference,
  type IslandRenderState,
} from "./island";
export { PAYLOAD_ONLY_ATTRIBUTE, renderServerTree, type ServerTreeRenderOptions } from "./tree";
