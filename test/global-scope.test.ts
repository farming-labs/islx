import { afterEach, describe, expect, it, vi } from "vitest";

// Cloudflare Workers reject a module that generates random values, sets a timer or does I/O
// while it loads ("Disallowed operation called within global scope"), so the worker never starts.
// Server entries must wait for a request to do any of that.
const serverEntries = [
  "@farm.js/islx",
  "@farm.js/islx/server",
  "@farm.js/islx/react",
  "@farm.js/islx/react/server",
  "@farm.js/islx/tanstack-start/server",
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("server entries in a worker's global scope", () => {
  it.each(serverEntries)("%s loads without random values or timers", async (entry) => {
    vi.resetModules();
    const random = vi.spyOn(crypto, "getRandomValues");
    const uuid = vi.spyOn(crypto, "randomUUID");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    await import(/* @vite-ignore */ entry);
    expect(random).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  });
});
