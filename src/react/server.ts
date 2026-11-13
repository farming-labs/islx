/**
 * @farm.js/islx/react/server: rendering a React page with islands. Importing it gives islands the
 * server code they need (values, action references); `renderToStream` renders a page.
 */
import * as React from "react";
import { getStreamKind, toStreamSteps } from "../protocol/stream";
import type { RenderToReadableStreamOptions } from "react-dom/server";
import { encode, plainObject } from "../protocol/codec";
import {
  FORM_STATE_SCRIPT_TYPE,
  PROMISE_TAG,
  STREAM_KIND_FIELD,
  STREAM_TAG,
  RENDER_HEADER,
  TAG,
  TAG_VALUE,
} from "../protocol/wire";
import { RUNTIME_GLOBAL } from "../boot";
import { PREHYDRATION_SCRIPT } from "../client/prehydration";
import { encodeActionReference } from "../server/actions";
import { getBuildDefaults } from "../server/build";
import { RenderedElements, setActionResultRenderer, type ReactFormState } from "../server/handle";
import {
  addressValues,
  escapeScriptJson,
  parseHeldValues,
  selectValuesToSend,
} from "../server/values";
import { getContexts, runtimeTagged, setIslandServerHook } from "./island";
import { renderSlotTree } from "./tree";

// Promise names are unique across renders and server instances, so a page that keeps islands from
// an earlier response never has two promises of one name. The random prefix is made at the first
// render: Cloudflare Workers reject a module that generates random values while it loads.
let promisePrefix: string | undefined;
let promiseCount = 0;

function nextPromiseName(): string {
  promisePrefix ??= `${Array.from(crypto.getRandomValues(new Uint32Array(2)), (part) =>
    part.toString(36),
  ).join("")}.`;
  return promisePrefix + (promiseCount++).toString(36);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

setIslandServerHook({
  encode(props, held) {
    const promises: Array<{ name: string; promise: PromiseLike<unknown> }> = [];
    const addressed = addressValues(props, {
      encodeSpecial: (value) => {
        if (value && typeof value === "object" && runtimeTagged.has(value)) return value;
        const kind = getStreamKind(value);
        if (kind) {
          // Sent as the promise of its first step, which settles as the stream is read.
          const name = nextPromiseName();
          promises.push({ name, promise: toStreamSteps(value as object, kind) });
          return { [TAG]: STREAM_TAG, [TAG_VALUE]: name, [STREAM_KIND_FIELD]: kind };
        }
        if (isThenable(value)) {
          const name = nextPromiseName();
          promises.push({ name, promise: value });
          return { [TAG]: PROMISE_TAG, [TAG_VALUE]: name };
        }
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
      promises,
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
  const defaults = getBuildDefaults();
  const entry = bootstrap ? defaults.entry : undefined;
  // The boot entry starts the page and loads the browser entry when the page first needs it.
  const boot = entry !== undefined ? defaults.boot : undefined;
  const bootstrapModules = entry
    ? [...(options.bootstrapModules ?? []), boot ?? entry]
    : options.bootstrapModules;
  const runtime = boot
    ? `window.${RUNTIME_GLOBAL}=${escapeScriptJson(JSON.stringify(entry))};`
    : "";
  // The inline script runs as soon as the page's content is parsed, before the deferred entry.
  const bootstrapScriptContent =
    (prehydration ?? entry !== undefined)
      ? `${PREHYDRATION_SCRIPT}${runtime}${options.bootstrapScriptContent ?? ""}`
      : runtime || options.bootstrapScriptContent
        ? `${runtime}${options.bootstrapScriptContent ?? ""}`
        : undefined;
  // Loaded here, not at the top: importing this module (for islands' server code) must work in any
  // React environment, including a react-server one that has no renderToReadableStream.
  const { renderToReadableStream } = await import("react-dom/server");
  const stream = await renderToReadableStream(tree, {
    ...options,
    bootstrapModules,
    bootstrapScriptContent,
    formState: formState as never,
  });
  if (request?.headers.has(RENDER_HEADER)) await stream.allReady;
  return stream;
}

let resultScopes = 0;

/**
 * Renders elements an action returned as a slot's server tree, so the browser rebuilds them with
 * their client components live. Each result gets a scope of its own.
 */
async function renderResultElements(element: React.ReactElement): Promise<RenderedElements> {
  const scope = `x${(resultScopes++).toString(36)}`;
  const tree = await renderSlotTree(element, scope, null);
  const { render } = getContexts();
  const { renderToReadableStream } = await import("react-dom/server");
  const stream = await renderToReadableStream(
    React.createElement(
      render.Provider,
      { value: { held: null, sent: new Set<string>() } },
      tree.element,
    ),
  );
  await stream.allReady;
  return new RenderedElements(scope, await new Response(stream).text());
}

/**
 * The value with each React element in it rendered; anything else stays as it is. Boxed: an async
 * function that returned a promise the action returned would wait for it, and the browser would
 * get its value instead of the promise.
 */
async function renderInResult(value: unknown, ancestors: Set<object>): Promise<{ value: unknown }> {
  if (React.isValidElement(value)) return { value: await renderResultElements(value) };
  if (!value || typeof value !== "object" || ancestors.has(value)) return { value };
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = await Promise.all(value.map((entry) => renderInResult(entry, ancestors)));
      return entries.some((entry, index) => entry.value !== value[index])
        ? { value: entries.map((entry) => entry.value) }
        : { value };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { value };
    const entries = await Promise.all(
      Object.entries(value).map(
        async ([key, entry]) =>
          [key, entry, (await renderInResult(entry, ancestors)).value] as const,
      ),
    );
    if (entries.every(([, entry, rendered]) => entry === rendered)) return { value };
    return { value: plainObject(entries.map(([key, , rendered]) => [key, rendered])) };
  } finally {
    ancestors.delete(value);
  }
}

const renderResult = async (value: unknown) => (await renderInResult(value, new Set())).value;

setActionResultRenderer(renderResult);

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
export {
  Outlet,
  PAYLOAD_ONLY_ATTRIBUTE,
  renderServerTree,
  type ServerTreeRenderOptions,
} from "./tree";
