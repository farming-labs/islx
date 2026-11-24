import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    client: "src/client.ts",
    boot: "src/boot.ts",
    server: "src/server.ts",
    compiler: "src/compiler.ts",
    react: "src/react.ts",
    "react/server": "src/react/server.ts",
    "react/client": "src/react/client.ts",
    "islands/server": "src/islands/server.ts",
    "islands/client": "src/islands/client.ts",
    vite: "src/vite.ts",
    "tanstack-start": "src/tanstack-start/index.ts",
    "tanstack-start/server": "src/tanstack-start/server.ts",
  },
  format: "esm",
  platform: "neutral",
  target: "es2022",
  dts: true,
  clean: true,
  fixedExtension: true,
  external: [/^node:/, "estree-walker", "is-reference", "magic-string", "periscopic", "react", /^react\//, "react-dom", /^react-dom\//, "vite", "oxc-parser", /^virtual:/, /^@vitejs\//, /^@tanstack\//, /^@farm\.js\/islx/],
  outputOptions: {
    chunkFileNames: (chunk) => (chunk.isEntry ? "[name].mjs" : "_chunks/[name]-[hash].mjs"),
    // One chunk per browser module, so an app's bundler can leave out of a page's first load
    // whatever only a later call imports (the reviver, slot trees, the action client): a bundler
    // places a module's code by the files it comes in, not by the exports it uses.
    codeSplitting: {
      // A module's own chunk, not its imports': those get theirs.
      includeDependenciesRecursively: false,
      groups: [
        {
          debugName: "browser modules",
          name: (id) => {
            const module = /[\\/]src[\\/]((?:client|protocol|react)[\\/][\w-]+)\.ts$/.exec(id)?.[1];
            if (!module || /^react[\\/](?:client|server)$/.test(module)) return null;
            return module.replace(/[\\/]/g, "-");
          },
        },
      ],
    },
  },
});
