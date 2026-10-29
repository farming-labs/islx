/**
 * @farmjs/islx/react/server: rendering a React page with islands. Importing it gives islands the
 * server code they need (values, action references); `renderToStream` renders a page.
 */
import * as React from "react";
import { renderToReadableStream, type RenderToReadableStreamOptions } from "react-dom/server";
import { encode } from "../protocol/codec";
import { FORM_STATE_SCRIPT_TYPE } from "../protocol/wire";
import { encodeActionReference } from "../server/actions";
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
 */
export function renderToStream(
  element: React.ReactNode,
  { request, formState, ...options }: RenderToStreamOptions = {},
): Promise<ReadableStream<Uint8Array> & { allReady: Promise<void> }> {
  const held = request ? parseHeldValues(request) : null;
  const { render } = getContexts();
  const tree = React.createElement(
    render.Provider,
    { value: { held: held && held.size > 0 ? held : null, sent: new Set<string>() } },
    element,
    formState ? React.createElement(FormStateScript, { formState }) : null,
  );
  return renderToReadableStream(tree, { ...options, formState: formState as never });
}

/** Whether a response rendered for `request` leaves out values its browser holds. */
export function isPersonalized(request: Request): boolean {
  return parseHeldValues(request).size > 0;
}

export { createIsland } from "./island";
