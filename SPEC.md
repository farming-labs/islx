# islx wire format

Version 1. This document is the contract between a islx server and a islx browser runtime.
Anything that writes and reads it, in any language or framework, is a islx implementation.

## Principles

- **HTML first.** A page is ordinary server HTML. Interactive parts are marked where they sit;
  nothing else is reserved.
- **One prefix.** Every element, script type and header islx owns starts with `f`. Custom
  elements need a hyphen (`f-island`), script types use a slash (`f/props`), headers start `F-`.
- **One reserved JSON key.** Inside JSON, `$` holds a short tag. App data that has its own `$`
  key is wrapped, so no key is off limits to apps.
- **Untrusted by default.** Everything the browser sends back (headers, action arguments, sealed
  values) is validated. References are never accepted from the browser unless the server checks
  them.

## HTML

```html
<f-island src="/src/toc.tsx" export="Toc" props="_R_b_" strategy="load">
  …the component's server HTML…
  <f-slot name="_R_5_s0">…server output passed as children…</f-slot>
</f-island>
<script type="f/value" name="04jiw29097x8ki">[…a value sent once…]</script>
<script type="f/props" for="_R_b_">{"headings":[…],"tree":{"$":"r","v":"04jiw29097x8ki"}}</script>
```

| Name | Meaning |
| --- | --- |
| `<f-island>` | A client component's server HTML. `src` is the module the browser imports, `export` the component's export name, `props` the id of its props script, `strategy` when it hydrates (`load`, `idle`, `visible`, `media`, `only`). |
| `<script type="f/props" for>` | An island's props, as JSON. `for` names the island's `props` id. |
| `<script type="f/value" name>` | A value sent once. `name` is its key. Written before the first island that uses it. |
| `<f-slot name>` | Server output passed to an island as children. It stays server HTML; the island renders it in place. |
| `<script type="f/tree" [partial]>` | A page's server tree, so the browser can rebuild the page inside an existing root without its HTML. `partial` marks a navigation that sent only the tree. |
| `<script type="f/chunk" name>` | A part of a server tree that streamed in after the tree (a resolved Suspense boundary). |
| `<f-html name>` | Server HTML inside a server tree. |

A value script's and props script's JSON escapes `<`, U+2028 and U+2029.

## JSON tags

A tagged object is `{"$":tag}` or `{"$":tag,"v":data}`; an action may also carry `"b"`. An object
with any other keys is data.

| Tag | Stands for | Data |
| --- | --- | --- |
| `r` | a value sent once | its key |
| `s` | a slot | its name |
| `a` | a server action | its id; `b`, when present, holds its sealed captured values |
| `o` | app data with a `$` key | the object |
| `u` | `undefined` | |
| `n` | `NaN`, `Infinity`, `-Infinity`, `-0` | the name |
| `B` | `BigInt` | decimal digits |
| `D` | `Date` | ISO string, `null` for an invalid date |
| `M` | `Map` | `[[key, value], …]`, both tagged |
| `S` | `Set` | `[value, …]`, tagged |
| `U` | `URL` | `href` |
| `R` | `RegExp` | `[source, flags]` |
| `Y` | bytes | `[type, base64]`; type is `ArrayBuffer`, `DataView` or a typed array name |
| `p` | a Suspense boundary inside a server tree | |

The browser resolves `r` first (from its value store), then decodes the rest. Inside `o`, only
the object's properties are read; the object itself is never a tag. Unknown tags are errors.

Decoders build plain objects with own properties, so a `__proto__` key stays an ordinary key.

## Values sent once

A value whose JSON reaches 512 characters travels in its own `f/value` script, keyed by a 64-bit
hash of its JSON (14 base-36 characters), and props refer to it as `{"$":"r","v":key}`. Inner
values are addressed first, so a value that changed in one place shares its unchanged parts. A
thin wrapper around one addressed value is not addressed.

The browser keeps every value it reads, up to 1024, and names the most recently used 128 in each
navigation:

```http
GET /docs/p1
F-Values: 04jiw29097x8ki,1kq0d3f7xg2m9a
```

The server leaves those values out. A response that left values out belongs to one browser: it
must never enter a shared cache (CDN, ISR entry, PPR shell), and a cacheable response sends
`Vary: F-Values`.

## Navigations

| Header | Meaning |
| --- | --- |
| `F-Values` | value keys the browser holds |
| `F-Layouts` | the layouts on screen, as a JSON array of layout keys (pattern with params filled in) |
| `F-Render: tree` | the browser can rebuild the page from its server tree; HTML may be left out |

A server that leaves layouts out renders each kept layout as an empty boundary, and the browser
keeps its own. If the response does not fit what is on screen, the browser loads the full
document. All three headers make a response private, and the server sends `Vary` for each one
it read.

## Server actions

An action id names one server function: a hash of its module's path from the app root and its
export name (`inline:N` for the Nth inline action in the module). Ids are opaque to the browser.
Every registered action is a public endpoint: anyone can call it with any arguments, so an
action checks its inputs and the caller's rights like any other request handler.

An action's **bound values** are the variables an inline action captured, then arguments added
with `.bind` on the server. They travel sealed (below) and come before the call's own arguments.

**Called from JavaScript:**

```http
POST /current/page
F-Action: nSaHH8FImEr_M6
Content-Type: text/plain;charset=UTF-8

{"a":[…arguments, tagged…],"b":"…sealed…"}
```

A single `FormData` argument is sent as `multipart/form-data` instead, with the sealed values in
the `$F_BOUND` field. The response is JSON: `{"result":…tagged…}` or `{"redirect":"/path"}`.
Arguments may contain actions (`a`, with `b` when they carry sealed values) the server
registered; never `r` or `s`. The browser runs calls one at a time, in order, and refreshes the
page after each one (a redirect navigates instead).

**Posted by a form without JavaScript:** React writes the fields while it renders the form, for
`<form action>` and `<button formAction>`:

```html
<form action="" method="POST" enctype="multipart/form-data">
  <input type="hidden" name="$F_REF_R_1_">
  <input type="hidden" name="$F_R_1_:A" value="…action id…">
  <input type="hidden" name="$F_R_1_:B" value="…sealed…">
  <button name="$F_REF_R_2_">Delete</button>
  <input type="hidden" name="$F_R_2_:A" value="…another action…">
  …
</form>
```

The last `$F_REF_` field a submission carries names the action, so a clicked button wins over
its form. Every `$F_` field and `$ACTION_KEY` is removed before the action sees the form. The
server answers `303 See Other` back to the page, or to the action's redirect. A form posted from
a `useActionState` hook carries React's `$ACTION_KEY`; a server that can render the page renders
it with React's form state `[result, $ACTION_KEY, id, bound count - 1]` instead of redirecting,
and hydrates with the same.

**Checks the server makes**, before running anything:

- the method is `POST`, and the request names a same-origin source (`Origin`, then `Referer`,
  then `Sec-Fetch-Site: same-origin`), or one from an origin the app allows;
- the body is within the size limit (`413`); a form over the limit that does not post an action
  is left to the app;
- the id is registered; an unknown id is `404` with `F-Action-Stale: 1` for calls, and a `303`
  back to the page for forms, so the browser loads the page this deploy renders;
- arguments decode; malformed or unknown tags are `400`;
- sealed values open for this id: values sealed with a key the server does not have are stale
  (`409`, `F-Action-Stale: 1`), anything else that does not open is `400`, and so is an inline
  action that captured values posted without them.

A failing action answers `500` with no details; the error is reported on the server.

## Sealed captured values

An action written inside a component may read variables of the render around it. Those values
travel with the action, sealed, so the browser can neither read nor change them:

```
sealed = base64url( version ‖ key id ‖ IV ‖ AES-256-GCM(ciphertext ‖ tag) )
```

- `version` is `1`; `key id` is the first byte of SHA-256 of the key; the IV is 12 random bytes;
- the additional data is `islx:action:<id>`, so values sealed for one action never open for
  another;
- the plaintext is the captured values as a tagged JSON array.

A value sealed with a key the server does not have is **stale** (the page reloads); anything that
does not open is **invalid** (`400`). Servers may hold previous keys, so pages rendered before a
key rotation keep working. Every server instance must share the keys.

## Integration model

islx is layered so each framework needs only a thin integration:

| Layer | Package entry | Depends on |
| --- | --- | --- |
| Wire format and codec | `@farmjs/islx` | nothing (Web APIs) |
| Server: values, sealing, action handling | `@farmjs/islx/server` | `@farmjs/islx` |
| Browser: value store, hydration, navigation | `@farmjs/islx/client` | `@farmjs/islx` |
| Renderer adapters | `@farmjs/islx/react` (then Preact, Vue, Svelte, Solid) | the renderer |
| Compiler: `"use client"`, `"use server"`, inline actions | `@farmjs/islx/compiler` | a parser |
| Bundler plugins | `@farmjs/islx/vite`, `@farmjs/islx/webpack`, `@farmjs/islx/rollup`, `@farmjs/islx/esbuild` | the compiler |
| Frameworks | `@farmjs/islx/next`, `@farmjs/islx/astro`, `@farmjs/islx/nuxt`, … | the above |

- **Request handling** is one function on Web `Request` and `Response`, so any server mounts it:
  a Next.js route handler or middleware, a Nitro event handler, Astro middleware, Hono, Express
  through an adapter.
- **The compiler** is a pure function from source and environment (`server` or `client`) to
  source, with no bundler in it. Each bundler plugin is a few lines around it, and Turbopack uses
  the webpack loader.
- **Conformance.** `@farmjs/islx/testing` will ship the contract suite: an implementation passes when its
  fixture app passes it, in development and production.
