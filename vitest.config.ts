import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@farm\.js\/islx$/, replacement: source("index.ts") },
      { find: /^@farm\.js\/islx\/(.*)$/, replacement: source("$1.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
