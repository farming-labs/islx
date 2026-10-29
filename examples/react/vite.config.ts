import react from "@vitejs/plugin-react";
import { islx } from "@farmjs/islx/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    islx({
      clientComponents: { include: ["src/components/by-name.tsx"] },
      navigation: { viewTransition: true },
      hooks: {
        // Copied into the browser build: they use only their arguments and globals.
        client: {
          navigated({ url, duration }) {
            ((window as any).__islxEvents ??= []).push([
              "navigated",
              url.pathname,
              typeof duration,
            ]);
          },
          hydrate({ export: name, duration }) {
            ((window as any).__islxEvents ??= []).push(["hydrate", name, typeof duration]);
          },
          actionEnd({ name, ok }) {
            ((window as any).__islxEvents ??= []).push(["actionEnd", name ?? "inline", ok]);
          },
        },
        server: {
          async action({ name }, run) {
            const counts = ((globalThis as any).__islxActionCounts ??= {});
            counts[name] = (counts[name] ?? 0) + 1;
            return run();
          },
        },
      },
    }),
  ],
  environments: {
    ssr: {
      build: {
        outDir: "dist/server",
        rollupOptions: { input: { "entry-server": "src/entry-server.tsx" } },
      },
    },
  },
});
