import { PREHYDRATION_SCRIPT } from "@farm.js/islx/client";
import type { IslandStrategy } from "@farm.js/islx/islands/client";
import { renderIslandMarkup } from "@farm.js/islx/islands/server";
import type { CounterProps, ServerRenderer } from "./counter";
import { preact } from "./preact/server";
import { solid } from "./solid/server";
import { svelte } from "./svelte/server";
import { vue } from "./vue/server";

const renderers: Record<string, ServerRenderer> = { preact, vue, svelte, solid };

const islands: { strategy: IslandStrategy; props: CounterProps }[] = [
  {
    strategy: "load",
    props: {
      label: "load",
      start: 1,
      since: new Date("2026-11-23T00:00:00.000Z"),
      tags: new Map([["a", 1]]),
    },
  },
  {
    strategy: "interaction",
    props: {
      label: "interaction",
      start: 10,
      since: new Date("2026-11-24T00:00:00.000Z"),
      tags: new Map([["a", 2]]),
    },
  },
  {
    strategy: "visible",
    props: {
      label: "visible",
      start: 100,
      since: new Date("2026-11-25T00:00:00.000Z"),
      tags: new Map([["a", 3]]),
    },
  },
];

async function page(name: string, renderer: ServerRenderer): Promise<string> {
  const sent = new Set<string>();
  let body = "";
  for (const { strategy, props } of islands) {
    // Below the fold, so the visible island waits for a scroll.
    if (strategy === "visible") body += '<div style="height:150vh"></div>';
    body += renderIslandMarkup({
      src: `/${name}/counter`,
      export: renderer.export,
      strategy,
      id: props.label,
      props: props as unknown as Record<string, unknown>,
      html: await renderer.render(props, props.label),
      sent,
    });
  }
  const entry = import.meta.env.DEV ? `/src/${name}/client.ts` : `/assets/${name}.js`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,">` +
    `<title>${name} islands</title><script>${PREHYDRATION_SCRIPT}</script>${renderer.head ?? ""}` +
    `<script type="module" src="${entry}"></script></head><body><main>${body}</main>` +
    // Runs before the module entry: the tests compare these nodes with the hydrated ones.
    `<script>window.__serverNodes=Array.from(document.querySelectorAll("[data-testid]"))</script>` +
    `</body></html>`
  );
}

export async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  if (pathname === "/") {
    const links = Object.keys(renderers).map((name) => `<a href="/${name}">${name}</a>`);
    return new Response(`<!doctype html><title>islx renderers</title>${links.join(" ")}`, {
      headers,
    });
  }
  const name = pathname.slice(1);
  const renderer = renderers[name];
  if (!renderer) return new Response("Not Found", { status: 404 });
  return new Response(await page(name, renderer), { headers });
}
