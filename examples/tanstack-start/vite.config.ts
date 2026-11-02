import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import { islxTanstackStart } from "@farm.js/islx/tanstack-start";

export default defineConfig({
  plugins: [tanstackStart(), react(), nitro(), islxTanstackStart()],
});
