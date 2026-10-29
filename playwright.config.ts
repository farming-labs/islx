import { defineConfig } from "@playwright/test";

// The example app, served from its production build and from Vite's dev server.
const example = "examples/react";
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" },
  projects: [
    { name: "production", use: { baseURL: "http://localhost:4311" } },
    { name: "development", use: { baseURL: "http://localhost:4312" } },
  ],
  webServer: [
    {
      command: `pnpm --dir ${example} build && PORT=4311 node ${example}/server.mjs`,
      url: "http://localhost:4311/",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `PORT=4312 node ${example}/server.mjs --dev`,
      url: "http://localhost:4312/",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
