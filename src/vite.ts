/**
 * @farmjs/islx/vite: islx for Vite 6 and later (the Environment API).
 *
 *   import react from "@vitejs/plugin-react";
 *   import { islx } from "@farmjs/islx/vite";
 *   export default defineConfig({ plugins: [react(), islx()] });
 *
 * - Server environments: `"use client"` components render as islands, `"use server"` exports
 *   and inline actions register.
 * - The client environment: `"use server"` modules become references; inline actions are
 *   refused; the browser entry hydrates islands.
 * - `vite build` builds the server first, which finds the client components pages use, then the
 *   browser with exactly those (plus `clientComponents.include`), each in a chunk of its own that
 *   the browser entry imports when an island needs it. An island names its module by its path
 *   from the root; the server build learns the entry's URL once the browser build has named it.
 */
import { randomBytes } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { walk } from "estree-walker";
import { analyze } from "periscopic";
import type { Plugin, ResolvedConfig, ViteBuilder } from "vite";
import type { ClientHooks } from "./client/hooks";
import { transformActions, type AstNode } from "./compiler/actions";
import { transformClientModule } from "./compiler/client";
import type { ServerHooks } from "./server/hooks";

export interface IslxOptions {
  clientComponents?: {
    /**
     * Client modules to build for the browser even when no page the server build saw imports
     * them, as components chosen by name at runtime. Globs, from the root.
     */
    include?: string[];
    /** Files never treated as client components, even with `"use client"`. Globs, from the root. */
    exclude?: string[];
  };
  /** The environments that render on the server. Default: every environment but `client`. */
  serverEnvironments?: string[];
  /**
   * The directives your code marks client modules and actions with. Default `"use client"` and
   * `"use server"`; set others when another tool in the app already owns those. Libraries in
   * `node_modules` always use `"use client"` (and their actions are never registered).
   */
  directives?: { client?: string; server?: string };
  /**
   * Same-site links move between pages without loading a new document: the runtime, its code
   * and the values the browser holds stay. Default true; false loads every page.
   */
  navigation?: boolean | { viewTransition?: boolean };
  /**
   * Lifecycle hooks: callbacks, or the path of a module that exports them (`defineClientHooks`,
   * `defineServerHooks`). Callbacks are copied into the browser or server build as source, so
   * they may use only their arguments and globals (`window`, `fetch`, `console`, …); hooks that
   * import app code go in a module.
   */
  hooks?: {
    client?: string | ClientHooks;
    server?: string | ServerHooks;
  };
}

const RUNTIME_ID = "virtual:islx/runtime";
const ENTRY_ID = "virtual:islx/client-entry";
const CLIENT_HOOKS_ID = "virtual:islx/hooks-client";
const SERVER_HOOKS_ID = "virtual:islx/hooks-server";

// Globals a hook copied into the browser may use, besides the JavaScript ones Node also has.
const BROWSER_GLOBALS = new Set([
  "window",
  "document",
  "location",
  "history",
  "navigator",
  "screen",
  "localStorage",
  "sessionStorage",
  "alert",
  "confirm",
  "prompt",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "IntersectionObserver",
  "MutationObserver",
  "ResizeObserver",
  "HTMLElement",
  "Element",
  "Node",
  "CustomEvent",
  "Event",
  "matchMedia",
  "getComputedStyle",
  "innerWidth",
  "innerHeight",
  "scrollX",
  "scrollY",
  "self",
]);

/**
 * The source of a hooks module made from callbacks. Each callback is copied as written, so it
 * must not use anything from where it was written: an outside variable, an import.
 */
export function serializeHooks(
  hooks: Record<string, unknown>,
  where: "client" | "server",
  parse: (file: string, code: string) => AstNode,
): string {
  const entries: string[] = [];
  for (const [name, value] of Object.entries(hooks)) {
    if (value === undefined) continue;
    if (typeof value !== "function")
      throw new Error(`islx: hooks.${where}.${name} must be a function`);
    const source = Function.prototype.toString.call(value);
    if (source.includes("[native code]")) {
      throw new Error(
        `islx: hooks.${where}.${name} must be written in the config, not a built-in or bound function`,
      );
    }
    // `navigated({ url }) {…}` (a method) is only valid inside an object literal.
    const expression =
      (parse("hook.js", `(${source});`) as AstNode & { errors: unknown[] }).errors.length === 0;
    entries.push(expression ? `${JSON.stringify(name)}: ${source}` : source);
  }
  const code = `export default {\n${entries.join(",\n")}\n};\n`;
  const program = parse("hooks.js", code);
  const { globals } = analyze(program as never);
  const outside = [...globals.keys()].filter((name) =>
    where === "client"
      ? !(name in globalThis) && !BROWSER_GLOBALS.has(name)
      : // The server has no browser globals, whatever the process running the build has.
        BROWSER_GLOBALS.has(name) || !(name in globalThis),
  );
  let imports = false;
  walk(program as never, {
    enter(node: { type: string }) {
      if (node.type === "ImportExpression") imports = true;
    },
  });
  if (outside.length > 0 || imports) {
    const what = imports ? "`import()`" : outside.map((name) => `\`${name}\``).join(", ");
    throw new Error(
      `islx: hooks.${where} uses ${what}, which does not exist where the hook runs: hooks written in the config are copied into the ${where === "client" ? "browser" : "server"} build as source. ` +
        `Use a global${where === "client" ? " (window.analytics)" : ""}, or put the hooks in a module and pass its path: hooks: { ${where}: "./src/islx.${where}.ts" }.`,
    );
  }
  return code;
}
/** Stand for the browser entry's URL, and the files each client module needs, in the server
 * build until the browser build names them. */
const ENTRY_PLACEHOLDER = "__islx_client_entry_url__";
const MODULES_PLACEHOLDER = "__islx_client_modules__";
const SCRIPT = /\.[cm]?[jt]sx?$/;

type Parse = (file: string, code: string) => AstNode;

async function createParser(): Promise<Parse> {
  type Parsed = { program: unknown; errors?: unknown[] };
  // The program carries the parse errors, for callers that must not accept a broken source.
  const withErrors = (result: Parsed) =>
    Object.assign(result.program as AstNode, { errors: result.errors ?? [] });
  const vite = (await import("vite")) as { parseSync?: (file: string, code: string) => Parsed };
  if (typeof vite.parseSync === "function") {
    return (file, code) => withErrors(vite.parseSync!(file, code));
  }
  try {
    const oxc = (await import("oxc-parser" as string)) as {
      parseSync(file: string, code: string): Parsed;
    };
    return (file, code) => withErrors(oxc.parseSync(file, code));
  } catch {
    throw new Error("@farmjs/islx/vite needs Vite 8, or oxc-parser installed with an older Vite");
  }
}

/** A tiny glob matcher: `**`, `*` and `?`, on paths from the root. */
function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      pattern += glob[index + 2] === "/" ? "(?:.*/)?" : ".*";
      index += glob[index + 2] === "/" ? 2 : 1;
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern.replace(/^\.\//, "")}$`);
}

async function listFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "dist")
      continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, full)));
    else if (SCRIPT.test(entry.name)) files.push(full);
  }
  return files;
}

async function listOutput(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listOutput(full)));
    else if (/\.[cm]?js$/.test(entry.name)) files.push(full);
  }
  return files;
}

const toPosix = (value: string) => value.split(path.sep).join("/");

const RESERVED_DIRECTIVES = new Set(["use strict", "use asm"]);

/** The directives to use, refusing ones that would make a file mean two things. */
export function resolveDirectives(directives: IslxOptions["directives"] = {}): {
  client: string;
  server: string;
} {
  const client = directives.client ?? "use client";
  const server = directives.server ?? "use server";
  for (const [kind, value] of [
    ["client", client],
    ["server", server],
  ] as const) {
    if (
      typeof value !== "string" ||
      !/^[\w-]+( [\w-]+)*$/.test(value) ||
      RESERVED_DIRECTIVES.has(value)
    ) {
      throw new Error(
        `islx: directives.${kind} must be a plain directive such as "use island", not ${JSON.stringify(value)}`,
      );
    }
  }
  if (client === server) {
    throw new Error(
      `islx: directives.client and directives.server are both ${JSON.stringify(client)}`,
    );
  }
  return { client, server };
}

export function islx(options: IslxOptions = {}): Plugin[] {
  const directives = resolveDirectives(options.directives);
  let config: ResolvedConfig;
  let parse: Parse;
  let preamble = false;
  const include = (options.clientComponents?.include ?? []).map(globToRegExp);
  const exclude = (options.clientComponents?.exclude ?? []).map(globToRegExp);
  /** Client modules the server build rendered, by path from the root. */
  const discovered = new Set<string>();
  /** The browser entry's URL, once the browser build named it. */
  let entryUrl: string | undefined;
  /** The files each client module needs, once the browser build named them. */
  const moduleFiles: Record<string, string[]> = {};
  // One key per build; every instance of the build shares it. A new one per dev server.
  const buildKey = randomBytes(32).toString("base64url");

  const isServer = (name: string) =>
    options.serverEnvironments ? options.serverEnvironments.includes(name) : name !== "client";
  const relativeOf = (id: string) => toPosix(path.relative(config.root, id.split("?", 1)[0]!));
  const excluded = (relative: string) => exclude.some((pattern) => pattern.test(relative));
  const isBuild = () => config.command === "build";
  const clientInputs = async (): Promise<string[]> => {
    const inputs = new Set(discovered);
    if (include.length > 0) {
      for (const file of await listFiles(config.root)) {
        const relative = relativeOf(file);
        if (!include.some((pattern) => pattern.test(relative)) || excluded(relative)) continue;
        if ((await readFile(file, "utf8")).includes("use client")) inputs.add(relative);
      }
    }
    return [...inputs].sort();
  };

  const main: Plugin = {
    name: "islx",
    enforce: "pre",
    sharedDuringBuild: true,
    config(user) {
      const clientBuild = user.environments?.client?.build;
      const input = clientBuild?.rollupOptions?.input;
      return {
        // `vite build` builds every environment, in the order `buildApp` sets.
        builder: user.builder ?? {},
        environments: {
          client: {
            // The browser entry is virtual, so Vite's scan cannot see what it imports: without
            // these, the first page in development finds them late and reloads.
            optimizeDeps: {
              include: [
                "react",
                "react/jsx-runtime",
                "react/jsx-dev-runtime",
                "react-dom",
                "react-dom/client",
              ],
            },
            build: {
              outDir: clientBuild?.outDir ?? "dist/client",
              rollupOptions: {
                input: {
                  ...(typeof input === "string"
                    ? { index: input }
                    : Array.isArray(input)
                      ? Object.fromEntries(input.map((entry, index) => [`input${index}`, entry]))
                      : input),
                  "islx-entry": ENTRY_ID,
                },
              },
            },
          },
        },
      };
    },
    async configResolved(resolved) {
      config = resolved;
      parse = await createParser();
      preamble = resolved.plugins.some((plugin) => plugin.name === "vite:react-virtual-preamble");
    },
    resolveId(id) {
      if (
        id === RUNTIME_ID ||
        id === ENTRY_ID ||
        id === CLIENT_HOOKS_ID ||
        id === SERVER_HOOKS_ID
      ) {
        return `\0${id}`;
      }
      return undefined;
    },
    async load(id) {
      if (id === `\0${RUNTIME_ID}`) {
        // Imported by every server module with islands or actions.
        const entry = isBuild() ? ENTRY_PLACEHOLDER : `${config.base}@id/__x00__${ENTRY_ID}`;
        const modules = isBuild() ? `JSON.parse(${JSON.stringify(MODULES_PLACEHOLDER)})` : "{}";
        return [
          `import { setBuildDefaults, setServerHooks } from "@farmjs/islx/server";`,
          `import hooks from ${JSON.stringify(SERVER_HOOKS_ID)};`,
          `setBuildDefaults({ entry: ${JSON.stringify(entry)}, key: ${JSON.stringify(buildKey)}, modules: ${modules} });`,
          `setServerHooks(hooks);`,
        ].join("\n");
      }
      if (id === `\0${CLIENT_HOOKS_ID}` || id === `\0${SERVER_HOOKS_ID}`) {
        const where = id === `\0${CLIENT_HOOKS_ID}` ? "client" : "server";
        const hooks = options.hooks?.[where];
        if (hooks === undefined) return "export default undefined;";
        if (typeof hooks === "string") {
          return `export { default } from ${JSON.stringify(path.resolve(config.root, hooks))};`;
        }
        return serializeHooks(hooks as Record<string, unknown>, where, parse);
      }
      if (id === `\0${ENTRY_ID}`) {
        // In a build the server build has run: every client module it rendered gets a chunk.
        const load = isBuild()
          ? `const modules = {\n${(await clientInputs())
              .map(
                (relative) =>
                  `  ${JSON.stringify(relative)}: () => import(${JSON.stringify(path.resolve(config.root, relative))}),`,
              )
              .join(
                "\n",
              )}\n};\nconst load = (src) => modules[src] ? modules[src]() : Promise.reject(new Error("islx: no client module " + src));`
          : // Modules outside the root (a hoisted library) are served from /@fs/.
            `const root = new URL(${JSON.stringify(`file://${toPosix(config.root)}/`)});\n` +
            `const load = (src) => import(/* @vite-ignore */ src.startsWith("../") ? "/@fs" + new URL(src, root).pathname : ${JSON.stringify(config.base)} + src);`;
        return [
          ...(preamble && !isBuild() ? [`import "@vitejs/plugin-react/preamble";`] : []),
          `import { createHydrationRuntime, refreshDocument, swapDocument } from "@farmjs/islx/react/client";`,
          `import { enhanceForms, setActionNavigator, setClientHooks, startNavigation, navigate } from "@farmjs/islx/client";`,
          `import hooks from ${JSON.stringify(CLIENT_HOOKS_ID)};`,
          `setClientHooks(hooks);`,
          load,
          `const runtime = createHydrationRuntime({ load });`,
          `setActionNavigator({ refresh: () => refreshDocument(runtime), navigate: (href) => navigate(href) });`,
          `enhanceForms();`,
          ...(options.navigation === false
            ? []
            : [
                `startNavigation({ swap: (next) => swapDocument(runtime, next), viewTransition: ${
                  typeof options.navigation === "object" &&
                  options.navigation.viewTransition === true
                } });`,
              ]),
          `runtime.hydrate(document);`,
          `export { runtime };`,
        ].join("\n");
      }
      return undefined;
    },
    transform(code, id) {
      if (id.startsWith("\0") || !SCRIPT.test(id.split("?", 1)[0]!)) return null;
      // A library: its "use client" components become islands (when Vite bundles it for the
      // server), and nothing in it registers actions.
      const library = id.includes("/node_modules/");
      const clientDirective = library ? "use client" : directives.client;
      if (!code.includes(clientDirective) && (library || !code.includes(directives.server))) {
        return null;
      }
      const file = id.split("?", 1)[0]!;
      const server = isServer(this.environment.name);
      const relative = relativeOf(file);
      const parseFile = (source: string) => parse(file, source);

      if (server && !excluded(relative)) {
        const island = transformClientModule({
          code,
          id: file,
          root: config.root,
          parse: parseFile,
          reference: (relative) => {
            // Outside the root (a hoisted library) it starts with "../": still a stable name.
            discovered.add(relative);
            return JSON.stringify(relative);
          },
          sideEffects: [RUNTIME_ID],
          directive: clientDirective,
        });
        if (island) {
          // Client code: an inline action in it is a mistake, caught as the browser build would.
          if (!library) {
            transformActions({
              code,
              id: file,
              root: config.root,
              environment: "client",
              parse: parseFile,
              directive: directives.server,
            });
          }
          return { code: island.code, map: island.map };
        }
      }
      if (library) return null;
      const actions = transformActions({
        code,
        id: file,
        root: config.root,
        environment: server ? "server" : "client",
        parse: parseFile,
        directive: directives.server,
      });
      if (!actions) return null;
      return {
        code: server ? `import ${JSON.stringify(RUNTIME_ID)};\n${actions.code}` : actions.code,
        map: server ? null : actions.map,
      };
    },
  };

  const reload: Plugin = {
    name: "islx:reload",
    apply: "serve",
    hotUpdate({ file, modules, server }) {
      if (!isServer(this.environment.name) || modules.length === 0) return;
      // A client module updates through the browser's own hot update. Anything else the server
      // renders (a page, a server component, data) changes the HTML: load the page again.
      const client = server.environments.client;
      if (client?.moduleGraph.getModulesByFile(file)?.size) return;
      client?.hot.send({ type: "full-reload" });
    },
  };

  const build: Plugin = {
    name: "islx:build",
    sharedDuringBuild: true,
    async buildApp(builder: ViteBuilder) {
      const servers = Object.values(builder.environments).filter((environment) =>
        isServer(environment.name),
      );
      for (const environment of servers) await builder.build(environment);
      await builder.build(builder.environments.client!);
      // The server build names the browser entry by a placeholder until now.
      if (!entryUrl) throw new Error("islx: the browser build did not emit the islx entry");
      for (const environment of servers) {
        const outDir = path.resolve(config.root, environment.config.build.outDir);
        for (const file of await listOutput(outDir)) {
          const source = await readFile(file, "utf8");
          if (!source.includes(ENTRY_PLACEHOLDER) && !source.includes(MODULES_PLACEHOLDER))
            continue;
          // The modules map sits in a JSON string literal: escape it as one.
          const modules = JSON.stringify(JSON.stringify(moduleFiles)).slice(1, -1);
          await writeFile(
            file,
            source.replaceAll(ENTRY_PLACEHOLDER, entryUrl).replaceAll(MODULES_PLACEHOLDER, modules),
          );
        }
      }
    },
    generateBundle(_options, bundle) {
      if (this.environment.name !== "client") return;
      const url = (fileName: string) => `${config.base}${fileName}`;
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk" || !chunk.facadeModuleId) continue;
        if (chunk.isEntry && chunk.facadeModuleId === `\0${ENTRY_ID}`) {
          entryUrl = url(chunk.fileName);
        } else if (chunk.isDynamicEntry && !chunk.facadeModuleId.startsWith("\0")) {
          // A client module: its chunk, then what it imports (shared with the entry or not).
          moduleFiles[relativeOf(chunk.facadeModuleId)] = [chunk.fileName, ...chunk.imports].map(
            url,
          );
        }
      }
    },
  };

  return [main, reload, build];
}

export default islx;
