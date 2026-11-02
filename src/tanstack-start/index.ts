/**
 * @farm.js/islx/tanstack-start: a TanStack Start app as islands.
 *
 *   import { tanstackStart } from "@tanstack/react-start/plugin/vite";
 *   import { islxTanstackStart } from "@farm.js/islx/tanstack-start";
 *   export default defineConfig({ plugins: [tanstackStart(), react(), islxTanstackStart()] });
 *
 * Routes render on the server; the browser loads islx and the `"use client"` components a page
 * uses, not the router or the routes. TanStack Start's client entry becomes islx's browser entry,
 * so `<Scripts />` still loads it. Client components are the `"use client"` modules under `src/`
 * (`clientComponents.include`); a library's stay server HTML.
 */
import { normalizePath, type Plugin } from "vite";
import { islx, type IslxOptions } from "../vite";

const ISLX_ENTRY = "virtual:islx/client-entry";
const START_CLIENT_ENTRY = "virtual:tanstack-start-client-entry";
const START_SERVER_ENTRY = "virtual:tanstack-start-server-entry";
const START_ROUTER_ENTRY = "#tanstack-router-entry";
const ROUTER_WRAPPER = "\0islx:tanstack-router";
const SERVER_WRAPPER = "\0islx:tanstack-server-entry";

// Start's own server entry, when the app has no src/server.ts: it renders with islx's handler.
const SERVER_ENTRY = `import { createServerEntry, createStartHandler } from "@tanstack/react-start/server";
import { handleAction } from "@farm.js/islx/server";
import { islandsHandler } from "@farm.js/islx/tanstack-start/server";
const start = createStartHandler(islandsHandler);
export default createServerEntry({
  // islx's server actions first; any other request (and Start's server functions) goes to Start.
  async fetch(request, ...rest) {
    return (await handleAction(request)) ?? start(request, ...rest);
  },
});
`;

// The browser does not run the router, so the server dehydrates nothing for it: no loader data
// or manifest in the page. Start reads this lifecycle when the request's render attaches.
const routerWrapper = (routerPath: string) => `import * as app from ${JSON.stringify(routerPath)};
export * from ${JSON.stringify(routerPath)};
export async function getRouter(...args) {
  const router = await app.getRouter(...args);
  const lifecycle = (router.serverSsrLifecycle ??= {});
  // Start dehydrates every request: here that turns hydration off instead.
  (lifecycle.onServerSsrAttach ??= []).push((ssr) => {
    ssr.dehydrate = async () => ssr.disableHydration();
  });
  return router;
}
`;

export type IslxTanstackStartOptions = IslxOptions;

export function islxTanstackStart(options: IslxTanstackStartOptions = {}): Plugin[] {
  let clientEntry: string | undefined;
  let serverEntry: string | undefined;
  let routerEntry: string | undefined;
  const pathOf = (id: string) => normalizePath(id.split("?", 1)[0]!);
  const entry: Plugin = {
    name: "islx:tanstack-start",
    enforce: "pre",
    configResolved(config) {
      const aliasOf = (find: string) => {
        const alias = config.resolve.alias.find((entry) => entry.find === find);
        if (!alias) {
          throw new Error(
            "islx: add tanstackStart() from @tanstack/react-start/plugin/vite before islxTanstackStart()",
          );
        }
        return normalizePath(alias.replacement);
      };
      clientEntry = aliasOf(START_CLIENT_ENTRY);
      routerEntry = aliasOf(START_ROUTER_ENTRY);
      // Only Start's default entry is replaced: an app's own src/server.ts uses islandsHandler.
      const server = aliasOf(START_SERVER_ENTRY);
      if (server.includes("/node_modules/") || server.includes("/@tanstack/")) serverEntry = server;
    },
    resolveId(id, importer) {
      if (this.environment.name === "client" || !routerEntry) return undefined;
      // A virtual module, so its imports resolve from the app rather than from Start's package.
      if (serverEntry && pathOf(id) === serverEntry) return SERVER_WRAPPER;
      if (!importer) return undefined;
      // Start's import of the app's router, after its alias: wrap it. The wrapper's own import
      // of the router passes through.
      if (
        pathOf(id) === routerEntry &&
        importer !== ROUTER_WRAPPER &&
        importer.includes("@tanstack")
      ) {
        return ROUTER_WRAPPER;
      }
      return undefined;
    },
    load(id) {
      if (id === ROUTER_WRAPPER) return routerWrapper(routerEntry!);
      if (id === SERVER_WRAPPER) return SERVER_ENTRY;
      const file = pathOf(id);
      // The page loads Start's client entry: it runs islx instead of hydrating the router.
      if (this.environment.name === "client") {
        return file === clientEntry ? `import ${JSON.stringify(ISLX_ENTRY)};` : undefined;
      }
      return undefined;
    },
  };
  return [
    entry,
    ...islx(
      {
        serverEnvironments: ["ssr"],
        ...options,
        clientComponents: {
          include: options.clientComponents?.include ?? ["src/**"],
          exclude: ["**/node_modules/**", ...(options.clientComponents?.exclude ?? [])],
        },
      },
      { frameworkEntry: true, frameworkBuild: true, frameworkRender: true },
    ),
  ];
}

export default islxTanstackStart;
