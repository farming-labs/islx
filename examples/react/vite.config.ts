import react from "@vitejs/plugin-react";
import { islx } from "@farmjs/islx/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), islx({ clientComponents: { include: ["src/components/by-name.tsx"] } })],
  environments: {
    ssr: {
      build: {
        outDir: "dist/server",
        rollupOptions: { input: { "entry-server": "src/entry-server.tsx" } },
      },
    },
  },
});
