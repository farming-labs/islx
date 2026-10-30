# Changelog

## 0.0.1

The first release: the islx wire format, server actions, React islands, and the Vite plugin.

### Wire format (`@farmjs/islx`)

- `f-` vocabulary: `<f-island>`, `f/props`, `f/value`, `<f-slot>`, `f/tree`, `f/chunk`, `<f-html>`,
  `f/form-state`; headers `F-Values`, `F-Layouts`, `F-Render`, `F-Action`.
- One reserved JSON key, `$`, with short tags: `Date`, `Map`, `Set`, `BigInt`, `URL`, `RegExp`,
  bytes, `undefined`, special numbers, `FormData` and file arguments; app data with a `$` key
  travels wrapped. Decoding refuses unknown tags and keeps `__proto__` an ordinary key.

### Server (`@farmjs/islx/server`)

- Values sent once: large props keyed by a hash of their JSON, left out for browsers that hold
  them.
- Server actions: `"use server"` modules and inline `"use server"` functions. Captured variables
  and `.bind` arguments travel sealed (AES-GCM, bound to the action, key rotation).
- `handleAction(request)`: calls and forms without JavaScript, `<button formAction>`,
  `useActionState` form state, origin checks, a body limit, stale-deploy answers, errors that
  never reach the browser.
- Lifecycle hooks: `defineServerHooks({ action, actionError, error })`.

### Browser (`@farmjs/islx/client`)

- Action references: calls in order, refresh after each, redirects, stale-deploy reloads.
- Client navigation, view transitions, server-component forms without reloads.
- Lifecycle hooks and `f:` DOM events; the pre-hydration script that holds early interactions.

### React (`@farmjs/islx/react`, `/react/server`, `/react/client`)

- `createIsland`, `renderToStream`, the hydration runtime (`load`, `idle`, `visible`,
  `interaction`), carry-over across refreshes, server HTML restored on failure.
- Server trees for layouts that hydrate as one root, payload-only navigations.
- For frameworks: `IslandsProvider`, `withinClientRoot`, `isolateIslands`, `createServerHtml`.

### Build (`@farmjs/islx/compiler`, `@farmjs/islx/vite`)

- `transformActions` and `transformClientModule`, with errors that say where and what to do.
- `islx()` for Vite 6+: discovery, one chunk per client module, preloads, dev reloads,
  `directives`, `hooks`, `navigation`, `clientComponents`.
