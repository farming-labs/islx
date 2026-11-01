# Changelog

## 0.0.4

Promise props, and islands in a page that streams after it loaded.

- A server component can pass an unawaited promise to a client component, which reads it with
  `use()`. The promise travels as `{"$":"T","v":name}`; when it settles, a Suspense boundary after
  the island writes `<script type="f/promise" name>` with `{"v":value}` (the same codec and values
  sent once) or `{"e":1}`. A rejection's reason stays on the server. In the browser the prop is a
  thenable: settled already when its outcome is on the page, so hydration does not suspend, and
  settled when it streams in otherwise.
- An island holding a Suspense boundary that is still streaming, after the document has loaded (a
  framework router that streams navigations), hydrates once React reveals the boundary instead of
  React rendering it again in the browser (error #419). `endStreamedContent(root)` from
  `@farm.js/islx/react/client` marks boundaries a stream never completed as rendered in the
  browser, so their islands hydrate on the next pass.

## 0.0.3

Server layouts as trees.

- A server layout around a client provider renders as a server tree, so a framework no longer
  ships the layout's module to hydrate it. On the server, `renderServerTree(layout, { outlets,
  scope })` with `<Outlet />` where the page goes; in the browser, `createServerTreeLayout(source,
  scope, { load, ServerHtml, onUpdate })` and `layout.render({ children: page })`. Rendering it
  again with another page keeps the provider's state.
- A layout's tree names its payload, chunks and server HTML by its scope (`f/chunk name="/:0"`),
  so it and the page's tree at its outlet never read each other's parts. New tag `L` (outlet).

## 0.0.2

Streaming and hydration fixes.

- Islands inside Suspense content that streams in after the browser entry has run now hydrate.
  While the document streams, the runtime watches it: an island hydrates once React moves it out
  of its hidden staging `<div>`, an island React removes (a replaced fallback) is released, and
  watching stops once the document is parsed and every staged boundary is revealed. React 19.2
  can reveal boundaries after parsing ends.
- Islands that share a value decode it once and share the result. Props and values without tags
  skip decoding, and decoded objects are built with plain assignment (`__proto__` stays data).

## 0.0.1

The first release: the islx wire format, server actions, React islands, and the Vite plugin.

### Wire format (`@farm.js/islx`)

- `f-` vocabulary: `<f-island>`, `f/props`, `f/value`, `<f-slot>`, `f/tree`, `f/chunk`, `<f-html>`,
  `f/form-state`; headers `F-Values`, `F-Layouts`, `F-Render`, `F-Action`.
- One reserved JSON key, `$`, with short tags: `Date`, `Map`, `Set`, `BigInt`, `URL`, `RegExp`,
  bytes, `undefined`, special numbers, `FormData` and file arguments; app data with a `$` key
  travels wrapped. Decoding refuses unknown tags and keeps `__proto__` an ordinary key.

### Server (`@farm.js/islx/server`)

- Values sent once: large props keyed by a hash of their JSON, left out for browsers that hold
  them.
- Server actions: `"use server"` modules and inline `"use server"` functions. Captured variables
  and `.bind` arguments travel sealed (AES-GCM, bound to the action, key rotation).
- `handleAction(request)`: calls and forms without JavaScript, `<button formAction>`,
  `useActionState` form state, origin checks, a body limit, stale-deploy answers, errors that
  never reach the browser.
- Lifecycle hooks: `defineServerHooks({ action, actionError, error })`.

### Browser (`@farm.js/islx/client`)

- Action references: calls in order, refresh after each, redirects, stale-deploy reloads.
- Client navigation, view transitions, server-component forms without reloads.
- Lifecycle hooks and `f:` DOM events; the pre-hydration script that holds early interactions.

### React (`@farm.js/islx/react`, `/react/server`, `/react/client`)

- `createIsland`, `renderToStream`, the hydration runtime (`load`, `idle`, `visible`,
  `interaction`), carry-over across refreshes, server HTML restored on failure.
- Server trees for layouts that hydrate as one root, payload-only navigations.
- For frameworks: `IslandsProvider`, `withinClientRoot`, `isolateIslands`, `createServerHtml`.

### Build (`@farm.js/islx/compiler`, `@farm.js/islx/vite`)

- `transformActions` and `transformClientModule`, with errors that say where and what to do.
- `islx()` for Vite 6+: discovery, one chunk per client module, preloads, dev reloads,
  `directives`, `hooks`, `navigation`, `clientComponents`.
