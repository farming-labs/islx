# islx

A wire format for server-rendered islands. Pages are plain server HTML; the interactive parts
hydrate on their own, with typed props, values sent once, server actions, and navigations that
send only what changed.

```html
<f-island src="/src/cart.tsx" export="Cart" props="_R_1_" strategy="load">…server HTML…</f-island>
<script type="f/props" for="_R_1_">{"updated":{"$":"D","v":"2026-10-28T09:00:00.000Z"}}</script>
```

islx started as [Farm.js](https://github.com/farming-labs/farm.js)'s islands mode, where it
replaces React Server Components' Flight payload. On a 300-page docs app it ships 26% less
JavaScript, and a client navigation sends 2.5 KB instead of 12 KB.

> Status: 0.0.3. React and Vite are supported; other renderers and framework
> integrations follow. The wire format is in [SPEC.md](./SPEC.md), changes in
> [CHANGELOG.md](./CHANGELOG.md).

```bash
npm install @farm.js/islx
```

## What is here

```ts
import { encode, decode } from "@farm.js/islx";
import { addressValues, selectValuesToSend, handleAction } from "@farm.js/islx/server";
import { getValueStore, createServerReference, setActionNavigator } from "@farm.js/islx/client";
import { transformActions } from "@farm.js/islx/compiler";
```

- **Typed values.** `Date`, `Map`, `Set`, `BigInt`, `URL`, `RegExp`, bytes, `undefined` and
  special numbers survive the trip, in props and in action arguments and results.
- **Values sent once.** Large props are keyed by a hash of their JSON. Islands and pages that
  share one share its key, and a navigation leaves out what the browser holds.
- **Server actions.** `"use server"` modules and inline `"use server"` functions, with:
  - the variables an inline action reads from its component carried along, sealed (AES-GCM,
    bound to the action) so the browser can neither read nor change them;
  - forms that work before JavaScript loads, including `<button formAction>` and
    `useActionState`;
  - `.bind` on the server (sealed) and in the browser;
  - calls run in order, then a page refresh; a redirect navigates; an action from an older
    deploy reloads the page;
  - same-origin checks, a body size limit, and errors that never reach the browser.
- **React islands.** `createIsland` renders a client component as server HTML plus its props;
  `renderToStream` renders a page (leaving out values the browser holds); the hydration runtime
  starts each island as its own root when its strategy says (`load`, `idle`, `visible`,
  `interaction`, which holds the first click or submit and replays it), restores the server HTML
  if an island fails, keeps island state when the page renders again, and hydrates
  `useActionState` with the form post's result.
- **Compiler.** A pure function from source to source for each environment, with errors that
  say where and what to do: an inline action in browser code, one that is not async, uses
  `this`, or captures something that cannot travel.

### Server actions in a framework

```ts
// The server: before rendering a page.
const response = await handleAction(request, {
  allowedOrigins: ["app.example.com"],
  mapError: (error) => (isRedirect(error) ? { redirect: error.location } : undefined),
  renderFormState: (formState) => renderPage(request, { formState }),
});
if (response) return response;

// The browser: once.
setActionNavigator({ refresh: () => router.refresh(), navigate: (href) => router.push(href) });
```

Every server instance must share the key captured values are sealed with: set
`ISLX_ACTIONS_KEY` (make one with `generateActionKey()`), or call `configureActionKeys`. Keep a
rotated-out key in `ISLX_ACTIONS_PREVIOUS_KEYS` so open pages keep working.

### Known limits

- Every registered action is a public endpoint, as in React and Next.js: check inputs and rights
  inside it.
- Arguments carry the typed values above, `FormData`, `File` and `Blob`.
- Actions are not removed from the server build when nothing imports them yet.

## On Vite

```ts
// vite.config.ts
import react from "@vitejs/plugin-react";
import { islx } from "@farm.js/islx/vite";

export default defineConfig({
  plugins: [react(), islx()],
  environments: {
    ssr: { build: { outDir: "dist/server", rollupOptions: { input: "src/entry-server.tsx" } } },
  },
});
```

```tsx
// src/entry-server.tsx
import { renderToStream } from "@farm.js/islx/react/server";
import { handleAction } from "@farm.js/islx/server";

export async function handle(request: Request) {
  const action = await handleAction(request, {
    renderFormState: (formState) => page(request, formState),
  });
  return action ?? page(request);
}

async function page(request: Request, formState?) {
  const stream = await renderToStream(<App />, { request, formState });
  return new Response(stream, { headers: { "content-type": "text/html", "cache-control": "private" } });
}
```

```tsx
// src/components/chart.tsx
"use client";
export const hydrate = "visible"; // or { Chart: "visible", Legend: "idle" }; default "load"
export function Chart(props: { points: Map<string, number> }) { … }
```

- Components are server components unless their module says `"use client"`; those render as
  islands, and the page needs no other setup: `renderToStream` adds the browser entry.
- `vite build` builds the server, then the browser with exactly the client components the server
  rendered, each in its own chunk. `islx({ clientComponents: { include, exclude } })` adds
  components the server build cannot see (chosen by name at runtime) or leaves some out.
- Forms in server components submit without a reload once JavaScript runs, and post normally
  before.
- Same-site links move between pages without loading a new document: the runtime, its code and
  the values the browser holds stay, and the server leaves those values out. Back, forward,
  scroll and focus behave as page loads do. `islx({ navigation: false })` turns it off;
  `rel="external"` opts one link out; `navigate(href)` from `@farm.js/islx/client` navigates from
  code.
- `islx({ directives: { client: "use island", server: "use action" } })` renames the directives
  your code uses, for apps where another tool already owns `"use client"` or `"use server"`.
  Libraries keep `"use client"`: their components become islands when Vite bundles them for the
  server (`ssr.noExternal`), and their `"use server"` never registers an action.
- Lifecycle hooks go in the plugin's options:

  ```ts
  islx({
    navigation: { viewTransition: true },
    hooks: {
      client: {
        navigate(event) { if (window.unsaved) event.preventDefault(); },  // stay on the page
        navigated({ url, duration }) { window.plausible?.("pageview", { u: url.href }); },
        hydrate({ export: name, duration }) { console.debug(name, "interactive in", duration); },
        islandError({ src, error }) { console.error(src, error); },
        actionEnd({ name, ok, duration }) {},
      },
      server: {
        async action({ request, name, module }, run) { /* check, log, time */ return run(); },
        actionError: (error) => (error instanceof Unauthorized ? { status: 401 } : undefined),
        error(error, { name }) {},
      },
    },
  })
  ```

  Callbacks are copied into the browser or server build as source, so they may use only their
  arguments and globals; the build names anything else they use. Hooks that import app code (an
  auth helper, an error reporter) go in a module: `hooks: { server: "./src/islx.server.ts" }`,
  exporting `defineServerHooks({ … })` (or `defineClientHooks`). Every client hook also fires as a
  DOM event on `document`: `f:navigate`, `f:navigated`, `f:navigate-error`, `f:hydrate`,
  `f:island-error`, `f:action`, `f:action-end`.
- Each build makes its own key for sealed action values; set `ISLX_ACTIONS_KEY` to keep forms
  working across deploys.

`examples/react` is a runnable app; `pnpm test:e2e` runs it in Chrome, in development and from
its production build.

## In a framework

A framework that renders pages itself (Farm does) uses the pieces directly instead of
`renderToStream` and the Vite plugin's entry:

| Need | API |
| --- | --- |
| Compile client and action modules | `transformClientModule({ …, reference, strategy })`, `transformActions` from `@farm.js/islx/compiler` |
| Render islands in its own render | wrap the page in `<IslandsProvider held={parseHeldValues(request)}>` |
| A layout that hydrates as one root | `withinClientRoot(layout)`; its server-HTML page: `isolateIslands(page)` |
| An async page under such a layout | `renderServerTree(page, { held, payloadOnly })` on the server; `createServerTreeElement(source, { load, ServerHtml })` in the browser |
| A server layout around a client provider, without shipping the layout | `renderServerTree(<Layout><Outlet /></Layout>, { outlets: { children: page }, scope })` on the server; `createServerTreeLayout(source, scope, { load, ServerHtml, onUpdate })` in the browser, then `layout.render({ children: page })` |
| Hydrate | `createHydrationRuntime({ load, schedule?, wrap?, report? })`, `createServerHtml(runtime)` |
| Hold early clicks | inline `PREHYDRATION_SCRIPT` in the page |
| Actions | `handleAction(request, { allowedOrigins, bodySizeLimit, run, mapError, renderFormState })`; `setActionNavigator({ refresh, navigate })` |
| Navigation with its router | send `F-Values` (`valueHeaders()`), `F-Layouts`, `F-Render`; `refreshDocument` / `swapDocument` or its own swap |

## Planned

| Entry | For |
| --- | --- |
| `@farm.js/islx/react` | server trees (a page rebuilt inside a hydrated layout), partial navigations |
| `@farm.js/islx/webpack` | webpack, Rspack, and Next.js (Turbopack uses the loader) |
| `@farm.js/islx/next`, `@farm.js/islx/astro`, `@farm.js/islx/nuxt` | thin framework integrations |
| `@farm.js/islx/testing` | the conformance suite every integration must pass |

## License

MIT
