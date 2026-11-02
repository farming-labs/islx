import { defineConfig } from "@playwright/test";

// The example apps, served from their production builds and from Vite's dev servers.
const example = "examples/react";
const tanstack = "examples/tanstack-start";
// TanStack Start renders everything before sending it to a bot, and HeadlessChrome counts as one:
// the TanStack projects browse as desktop Chrome, so pages stream as they do for people.
const desktopChrome =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  // One at a time: the development tests edit the example's source.
  workers: 1,
  use: { channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" },
  projects: [
    { name: "production", testIgnore: /tanstack/, use: { baseURL: "http://localhost:4311" } },
    { name: "development", testIgnore: /tanstack/, use: { baseURL: "http://localhost:4312" } },
    {
      name: "tanstack-start production",
      testMatch: /tanstack/,
      use: { baseURL: "http://localhost:4321", userAgent: desktopChrome },
    },
    {
      name: "tanstack-start development",
      testMatch: /tanstack/,
      use: { baseURL: "http://localhost:4322", userAgent: desktopChrome },
    },
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
    {
      command: `pnpm --dir ${tanstack} build && PORT=4321 node ${tanstack}/.output/server/index.mjs`,
      url: "http://localhost:4321/",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm --dir ${tanstack} exec vite dev --port 4322 --strictPort`,
      url: "http://localhost:4322/",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
