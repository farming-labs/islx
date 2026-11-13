# Changelog

## 0.0.16

Elements that arrive later render, as under React Server Components.

- A client component given a promise that resolves to elements renders them, client components
  inside included, and they hydrate. Before, the promise rejected in the browser.
- A client component that reads a stream prop while rendering on the server gets its own copy of
  the stream, and elements in its chunks render and hydrate. Before, the server render failed
  with "ReadableStream is locked".
- A server action's promises and streams can settle to elements. They render inside the
  framework's `run`, with the request's context. Before, the browser got a rejection.
- An island in Suspense content that React reveals after the document is parsed hydrates. React
  batches reveals, and before, such an island stayed inert.

## 0.0.15

Values that refer to themselves travel, as under React Server Components.

- A client component can receive a prop that refers to itself: a node whose `self` is the node,
  children that point at their parent, a `Map` or `Set` holding itself. The browser gets the same
  cycle. Before, the island rendered without hydration and logged a warning.
- A server action can take and return such values, in its arguments, its result and the promises
  and streams in it. Before, the call failed with "circular values are not serializable".
- Wire: a new `C` tag, `{"$":"C","v":levels}`, stands for the object, array, `Map` or `Set` that
  many levels up. `CIRCULAR_VALUE` is deprecated; nothing throws it now.

## 0.0.14

Islands take what React Server Components send, and refuse what they refuse.

- A client component can receive a `ReadableStream` or an async iterable. Its chunks stream in
  after the page, as the server reads them, and an error reaches the browser without the
  server's reason. Before, the island rendered without hydration.
- A server action can return promises, `ReadableStream`s and async iterables. The call returns
  first, and they settle as the server resolves them (`application/x-ndjson`). Before, the action
  ran and then answered 500.
- A client component given a plain function, a class instance or a symbol fails the render, with
  an error that names the component and the prop, as under React Server Components. Before, it
  rendered without hydration and logged a warning. A circular prop still renders without
  hydration.

## 0.0.13

- The browser keeps at most 1000 server action references, dropping the least recently used. Each
  action with captured values gets a new reference per render, so a long session kept every one
  it saw. A reference still in use keeps its identity.

## 0.0.12

Two fixes for frameworks on islx.

- A server action that returns elements, under a framework whose `run` wraps the result, now
  sends that result wrapped once. Before, the elements rendered through `run` a second time and
  the browser got the wrapper as the value.
- The browser's value store keeps the values a page has not used yet when it grows past its
  limit. It drops the oldest resolved values instead of all of them, so an island that hydrates
  late still finds its props.

## 0.0.11

Islands behave as React Server Components do in two more cases, and one prop no longer breaks a
page.

- A server action can return React elements (JSX), alone or inside arrays and plain objects. They
  render on the server as a server tree, so client components in them are live in the browser and
  async server components have run. Before, the action ran and then answered 500.
- A client component that clones its server child (`asChild`, Radix's `Slot`, `cloneElement`)
  gives its props to that child when the child is one host element, instead of to the `<f-slot>`
  around it. The child gets the classes, state attributes, handlers and ref, as under React Server
  Components.
- An island whose prop refers to itself renders without hydration, with the reason in a warning,
  as any prop that cannot be sent does. Before, the render overflowed the stack.

## 0.0.10

Islands keep the right state and every click, in three cases they did not.

- An island keeps its state with its item when a list changes after an action or a refresh, as
  React keys do. Islands whose props did not change keep their live root first; the rest pair up
  in document order, as before. Before, removing the first item of a list moved its state onto the
  next one.
- A streamed island whose props script has not arrived yet waits for it while the page loads,
  instead of failing, restoring its server HTML and failing again in a loop.
- Every click made on an `interaction` island while its code loads is replayed, in order, so two
  clicks on a counter count two. A repeated submit of a form, or click on its submit button, is
  still held and replayed once.

## 0.0.9

Islands behave as React Server Components do in four cases they did not.

- `useId` in an island returns the ids its server HTML has, and two islands no longer share ids.
  The props script carries the island's id position (`ids`), which the browser rebuilds before it
  hydrates. The island wrapper no longer calls `useId` inside another island, where it moved every
  id below it.
- Client components in server output passed to an island (`children`, or any element prop) are
  the island's descendants: they read its context, as a consumer below a provider does, and keep
  their own state. Such output travels as a server tree named after its slot; plain HTML still
  travels as HTML only.
- An element prop the island does not render at first (a tab, a closed panel) renders when it
  does. The server writes the slots it did not place in a `<template>` after the props.
- `useFormStatus` in a client component inside a server component's `<form>` reports that form's
  submit. The compiler points `useFormStatus` from `react-dom` at `@farm.js/islx/react`'s, which
  is React's anywhere else; `rewriteFormStatusImports` in `@farm.js/islx/compiler` does it for
  other plugins. A namespace import (`ReactDOM.useFormStatus`) keeps React's.

## 0.0.8

Pages load the runtime only when they first need it, and islands that only react to clicks wait
for one.

- Pages start with a 1.4 KB boot script (`@farm.js/islx/boot`) instead of the browser entry
  (65.6 KB on the React example). It loads the entry at once when an island hydrates at load (such
  an island also preloads it), and otherwise on an island's trigger, a click, press or focus on a
  waiting island, a pointer over a link, or a focus in a form. A link clicked before then is held
  and followed once navigation runs. `islx({ boot: false })` starts every page with the entry.
- A `"use client"` module without a `hydrate` export waits for a click when its code, and the app
  files it imports, provably do nothing before one: no effect, external store or `use()`, no
  handler but `onClick` and `onSubmit` on its elements, no form field, `ref` or `autoFocus`, no
  props spread onto an element, and imports only from React, stylesheets and the app. The click is
  held and replayed once it hydrates. A render that passes such an island `children` hydrates at
  load. `islx({ infer: false })` keeps every island at load; `inferStrategy` in
  `@farm.js/islx/compiler` runs the checks for other plugins.
- A click on a same-page link (`#…`) in an island that has not hydrated is held and replayed, as a
  button's is, so a table of contents that marks its heading still sees it.
- Changed defaults: an island whose module declares nothing and passes the checks above now
  waits for a click. Add `export const hydrate = "load"` to keep one hydrating at load.

## 0.0.7

Cloudflare Workers start, and sealed captured values name their key with 4 bytes.

- `@farm.js/islx/react/server` no longer generates random values while it loads. It made the
  promise-name prefix with `crypto.getRandomValues` at module scope, which Workers reject
  ("Disallowed operation called within global scope"), so no islx app started on Cloudflare
  since promise props (0.0.4). The prefix is made at the first render now.
- An inline `"use server"` function's captured values are sealed with format version 2: the key id
  is the first 4 bytes of the key's SHA-256 instead of the first byte. With one byte, a deploy that
  changed keys without keeping the old one gave the new key the same id one time in 256, and
  values from pages rendered before it failed as invalid (`400`) instead of stale (the page
  reloads). An app that does not set `ISLX_ACTIONS_KEY` gets a new key on every build, so this hit
  about one deploy in 256.
- Values sealed by 0.0.6 or earlier (format version 1) are stale: forms on pages open across the
  upgrade reload once.

## 0.0.6

Server action interceptor, early clicks on TanStack Start, library islands under pnpm.

- `setActionInterceptor((call, next) => …)` from `@farm.js/islx/client` wraps every server
  action call, references decoded from props included. It sees the call when it is made
  (`{ id, name, args }`) and `next` sends it in queue order, so a framework can unwrap what its
  server side adds to a result (cache invalidations, a query's cache entry, a declared failure).
- TanStack Start: a click on a button, or a form submit, in an island before it hydrates is held
  and replayed, as in a plain islx app (the pre-hydration script goes in the root route's head).
- A library's `"use client"` components (islands the Vite plugin makes in a bundled server build)
  import islx's island runtime from the app instead of from the library's folder. Under pnpm the
  library's folder in the store cannot see `@farm.js/islx`, so the server build failed to resolve
  `@farm.js/islx/react`; now it gets the same copy the app's pages use.

## 0.0.5

TanStack Start.

- `@farm.js/islx/tanstack-start`: `islxTanstackStart()` next to `tanstackStart()` runs a Start app
  as islands, with configuration only. Routes, loaders and layouts render on the server; the
  browser loads islx and the `"use client"` components a page uses (the modules under `src/`), not
  the router, the route tree or loader data. Start's client entry becomes islx's and the router is
  not dehydrated. Links move between routes without loading a document; a loader's promise passed
  unawaited to a client component streams in; islands call Start server functions and islx server
  actions. An app with its own `src/server.ts` uses `islandsHandler` from
  `@farm.js/islx/tanstack-start/server`. Needs Node 22.12 or later (Start's own requirement).

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
