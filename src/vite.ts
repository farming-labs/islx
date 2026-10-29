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
import type { Plugin, ResolvedConfig, ViteBuilder } from "vite";
import { transformActions, type AstNode } from "./compiler/actions";
import { transformClientModule } from "./compiler/client";

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
}

const RUNTIME_ID = "virtual:islx/runtime";
const ENTRY_ID = "virtual:islx/client-entry";
/** Stand for the browser entry's URL, and the files each client module needs, in the server
 * build until the browser build names them. */
const ENTRY_PLACEHOLDER = "__islx_client_entry_url__";
const MODULES_PLACEHOLDER = "__islx_client_modules__";
const SCRIPT = /\.[cm]?[jt]sx?$/;

type Parse = (file: string, code: string) => AstNode;

async function createParser(): Promise<Parse> {
  const vite = (await import("vite")) as {
    parseSync?: (file: string, code: string) => { program: unknown };
  };
  if (typeof vite.parseSync === "function") {
    return (file, code) => vite.parseSync!(file, code).program as AstNode;
  }
  try {
    const oxc = (await import("oxc-parser" as string)) as {
      parseSync(file: string, code: string): { program: unknown };
    };
    return (file, code) => oxc.parseSync(file, code).program as AstNode;
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

export function islx(options: IslxOptions = {}): Plugin[] {
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
      if (id === RUNTIME_ID || id === ENTRY_ID) return `\0${id}`;
      return undefined;
    },
    async load(id) {
      if (id === `\0${RUNTIME_ID}`) {
        // Imported by every server module with islands or actions.
        const entry = isBuild() ? ENTRY_PLACEHOLDER : `${config.base}@id/__x00__${ENTRY_ID}`;
        const modules = isBuild() ? `JSON.parse(${JSON.stringify(MODULES_PLACEHOLDER)})` : "{}";
        return [
          `import { setBuildDefaults } from "@farmjs/islx/server";`,
          `setBuildDefaults({ entry: ${JSON.stringify(entry)}, key: ${JSON.stringify(buildKey)}, modules: ${modules} });`,
        ].join("\n");
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
          : `const load = (src) => import(/* @vite-ignore */ ${JSON.stringify(config.base)} + src);`;
        return [
          ...(preamble && !isBuild() ? [`import "@vitejs/plugin-react/preamble";`] : []),
          `import { createHydrationRuntime, refreshDocument } from "@farmjs/islx/react/client";`,
          `import { enhanceForms, setActionNavigator } from "@farmjs/islx/client";`,
          load,
          `const runtime = createHydrationRuntime({ load });`,
          `setActionNavigator({ refresh: () => refreshDocument(runtime), navigate: (href) => location.assign(href) });`,
          `enhanceForms();`,
          `runtime.hydrate(document);`,
          `export { runtime };`,
        ].join("\n");
      }
      return undefined;
    },
    transform(code, id) {
      if (
        id.startsWith("\0") ||
        id.includes("/node_modules/") ||
        !SCRIPT.test(id.split("?", 1)[0]!)
      )
        return null;
      if (!code.includes("use client") && !code.includes("use server")) return null;
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
            if (relative.startsWith("..")) {
              throw new Error(
                `islx: client component ${relative} is outside the root ${config.root}`,
              );
            }
            discovered.add(relative);
            return JSON.stringify(relative);
          },
          sideEffects: [RUNTIME_ID],
        });
        if (island) {
          // Client code: an inline action in it is a mistake, caught as the browser build would.
          transformActions({
            code,
            id: file,
            root: config.root,
            environment: "client",
            parse: parseFile,
          });
          return { code: island.code, map: island.map };
        }
      }
      const actions = transformActions({
        code,
        id: file,
        root: config.root,
        environment: server ? "server" : "client",
        parse: parseFile,
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
