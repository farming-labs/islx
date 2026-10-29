# furrow

A wire format for server-rendered islands. Pages are plain server HTML; the interactive parts
hydrate on their own, with typed props, values sent once, server actions, and navigations that
send only what changed.

```html
<f-island src="/src/cart.tsx" export="Cart" props="_R_1_" strategy="load">…server HTML…</f-island>
<script type="f/props" for="_R_1_">{"updated":{"$":"D","v":"2026-10-28T09:00:00.000Z"}}</script>
```

furrow started as [Farm.js](https://github.com/farming-labs/farm.js)'s islands mode, where it
replaces React Server Components' Flight payload. On a 300-page docs app it ships 26% less
JavaScript, and a client navigation sends 2.5 KB instead of 12 KB.

> Status: early. The wire format and the server core are here; renderer adapters, the compiler
> and framework integrations follow. See [SPEC.md](./SPEC.md).

## What is here

```ts
import { encode, decode } from "furrow";
import { addressValues, selectValuesToSend, parseHeldValues } from "furrow/server";
import { createActionKeys, sealBound, unsealBound } from "furrow/server";
import { getValueStore, valueHeaders } from "furrow/client";
```

- **Typed values.** `Date`, `Map`, `Set`, `BigInt`, `URL`, `RegExp`, bytes, `undefined` and
  special numbers survive the trip, in props and in action arguments and results.
- **Values sent once.** Large props are keyed by a hash of their JSON. Islands and pages that
  share one share its key, and a navigation leaves out what the browser holds.
- **Sealed captured values.** An action written inside a component carries the variables it reads,
  encrypted with AES-GCM and bound to that action. Web Crypto only, so it runs on every runtime.

## Planned

| Entry | For |
| --- | --- |
| `furrow/react` | React islands, slots, server trees, form actions |
| `furrow/compiler` | `"use client"`, `"use server"`, inline actions |
| `furrow/vite` | Vite, and frameworks built on it (Astro, Nuxt, SvelteKit, Farm) |
| `furrow/webpack` | webpack, Rspack, and Next.js (Turbopack uses the loader) |
| `furrow/next`, `furrow/astro`, `furrow/nuxt` | thin framework integrations |
| `furrow/testing` | the conformance suite every integration must pass |

## License

MIT
