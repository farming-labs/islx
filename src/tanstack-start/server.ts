/**
 * @farm.js/islx/tanstack-start/server: the render handler of a TanStack Start app as islands.
 * `islxTanstackStart()` uses it for Start's default server entry; an app with its own
 * `src/server.ts` passes it to `createStartHandler`:
 *
 *   import { createServerEntry, createStartHandler } from "@tanstack/react-start/server";
 *   import { islandsHandler } from "@farm.js/islx/tanstack-start/server";
 *   export default createServerEntry({ fetch: createStartHandler(islandsHandler) });
 */
import * as React from "react";
import { StartServer } from "@tanstack/react-start/server";
import type { AnyRouter } from "@tanstack/react-router";
import {
  createSsrStreamResponse,
  defineHandlerCallback,
  getSsrStatus,
  renderRouterToStream,
  transformReadableStreamWithRouter,
  type HandlerCallback,
} from "@tanstack/react-router/ssr/server";
import { IslandsProvider } from "../react/island";
import { RENDER_HEADER, VALUES_HEADER } from "../protocol/wire";
import { parseHeldValues } from "../server/values";

/**
 * Renders the page with its islands: values the browser holds stay out, and a navigation (an
 * `F-Render` request) gets the whole page in one piece, as islx's browser runtime swaps it in.
 */
export const islandsHandler: HandlerCallback<AnyRouter> = defineHandlerCallback(
  ({ request, router, responseHeaders }) => {
    const held = parseHeldValues(request);
    responseHeaders.append("Vary", `${VALUES_HEADER}, ${RENDER_HEADER}`);
    // HTML without the values one browser holds is that browser's alone.
    if (held.size > 0) responseHeaders.set("Cache-Control", "private, no-store");
    const children = React.createElement(
      IslandsProvider,
      { held },
      React.createElement(StartServer, { router }),
    );
    if (!request.headers.has(RENDER_HEADER)) {
      return renderRouterToStream({ request, router, responseHeaders, children });
    }
    return renderWhole(request, router, responseHeaders, children);
  },
);

/** Waits for every Suspense boundary, so React writes the page with no streaming scripts. */
async function renderWhole(
  request: Request,
  router: AnyRouter,
  responseHeaders: Headers,
  children: React.ReactNode,
) {
  const { renderToReadableStream } = await import("react-dom/server");
  const stream = await renderToReadableStream(children, {
    signal: request.signal,
    nonce: router.options.ssr?.nonce,
    onError(error) {
      if (!request.signal.aborted) console.error("Error in renderToReadableStream:", error);
    },
  });
  await stream.allReady;
  const body = transformReadableStreamWithRouter(router, stream, {
    rendererSafePoint: "script-close",
    signal: request.signal,
  });
  return createSsrStreamResponse(
    router,
    new Response(body, { status: getSsrStatus(router), headers: responseHeaders }),
  );
}
