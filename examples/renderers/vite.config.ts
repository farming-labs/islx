import { svelte } from "@sveltejs/vite-plugin-svelte";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// One app, four renderers: each page's islands are written by one renderer's string renderer and
// hydrated through @farm.js/islx/islands/client with that renderer's hydrate function.
export default defineConfig({
  plugins: [vue(), svelte(), solid({ ssr: true })],
  builder: {},
  environments: {
    client: {
      build: {
        outDir: "dist/client",
        rollupOptions: {
          input: {
            preact: "src/preact/client.ts",
            vue: "src/vue/client.ts",
            svelte: "src/svelte/client.ts",
            solid: "src/solid/client.ts",
          },
          // Stable names, so the server writes each page's entry without a manifest.
          output: { entryFileNames: "assets/[name].js" },
        },
      },
    },
    ssr: {
      build: {
        outDir: "dist/server",
        rollupOptions: { input: { "entry-server": "src/entry-server.ts" } },
      },
    },
  },
});
