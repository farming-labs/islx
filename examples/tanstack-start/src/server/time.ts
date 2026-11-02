import { createServerFn } from "@tanstack/react-start";

// A Start server function, called from an island.
export const getServerTime = createServerFn({ method: "GET" }).handler(async () => ({
  iso: new Date("2026-11-01T12:00:00.000Z").toISOString(),
  pid: typeof process === "undefined" ? "edge" : "node",
}));
