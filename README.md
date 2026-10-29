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

> Status: early. The wire format and the server core are here; renderer adapters, the compiler
> and framework integrations follow. See [SPEC.md](./SPEC.md).

## What is here

```ts
import { encode, decode } from "@farmjs/islx";
import { addressValues, selectValuesToSend, handleAction } from "@farmjs/islx/server";
import { getValueStore, createServerReference, setActionNavigator } from "@farmjs/islx/client";
import { transformActions } from "@farmjs/islx/compiler";
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
- Arguments carry the typed values above and `FormData` (as the only argument); `File` and
  `Blob` arguments outside a form are not supported yet.
- Actions are not removed from the server build when nothing imports them yet.

## Planned

| Entry | For |
| --- | --- |
| `@farmjs/islx/react` | server trees (a page rebuilt inside a hydrated layout) |
| `@farmjs/islx/compiler` | `"use client"` islands (actions are done) |
| `@farmjs/islx/vite` | Vite, and frameworks built on it (Astro, Nuxt, SvelteKit, Farm) |
| `@farmjs/islx/webpack` | webpack, Rspack, and Next.js (Turbopack uses the loader) |
| `@farmjs/islx/next`, `@farmjs/islx/astro`, `@farmjs/islx/nuxt` | thin framework integrations |
| `@farmjs/islx/testing` | the conformance suite every integration must pass |

## License

MIT
