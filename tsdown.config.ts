import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    client: "src/client.ts",
    server: "src/server.ts",
    compiler: "src/compiler.ts",
    react: "src/react.ts",
    "react/server": "src/react/server.ts",
    "react/client": "src/react/client.ts",
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
  },
});
