// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createServerReference } from "@farm.js/islx/client";
import { handleAction, registerServerReference } from "@farm.js/islx/server";
// The React adapter renders the elements in a result, walking every value in it, as Farm runs it.
import "@farm.js/islx/react/server";

function serve(options: Parameters<typeof handleAction>[1] = {}) {
  // The action client runs in a browser, where the page has a location.
  vi.stubGlobal("location", new URL("http://localhost/page"));
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
    handleAction(
      new Request(url, {
        ...init,
        headers: { ...(init.headers as object), origin: new URL(url).origin },
      }),
      options,
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

class Point {
  constructor(
    readonly x: number,
    readonly y: number,
  ) {}
}

describe("values the browser sends that the codec cannot carry", () => {
  it("come back as the same values, as React Server Components return temporary references", async () => {
    const echo = async (sent: Record<string, unknown>, again: unknown) => ({
      ...sent,
      same: sent.element === again,
      inMap: new Map([["point", sent.point]]),
      later: Promise.resolve(sent.local),
    });
    registerServerReference(echo, "temporary-echo");
    serve();
    const element = React.createElement("b", null, "hi");
    const onPick = () => "picked";
    const point = new Point(1, 2);
    const local = Symbol("local");
    const result = (await createServerReference("temporary-echo")(
      { element, onPick, point, local, plain: 1 },
      element,
    )) as Record<string, unknown>;
    expect(result.element).toBe(element);
    expect(result.onPick).toBe(onPick);
    expect(result.point).toBe(point);
    expect(result.local).toBe(local);
    expect(result.plain).toBe(1);
    // The server saw one stand-in for the value sent twice.
    expect(result.same).toBe(true);
    expect((result.inMap as Map<string, unknown>).get("point")).toBe(point);
    expect(await result.later).toBe(local);
  });

  it("come back from a call that also sends files", async () => {
    const echo = async (blob: Blob, point: Point) => ({ size: blob.size, point });
    registerServerReference(echo, "temporary-files");
    serve();
    const point = new Point(3, 4);
    const result = (await createServerReference("temporary-files")(new Blob(["abc"]), point)) as {
      size: number;
      point: Point;
    };
    expect(result).toEqual({ size: 3, point });
    expect(result.point).toBe(point);
  });

  it("cannot be read or changed on the server", async () => {
    const errors: unknown[] = [];
    const read = async (point: { x: number }) => point.x;
    const change = async (point: { x: number }) => {
      point.x = 5;
    };
    registerServerReference(read, "temporary-read");
    registerServerReference(change, "temporary-change");
    serve({ onError: (error) => errors.push(error) });
    await expect(createServerReference("temporary-read")(new Point(1, 2))).rejects.toThrow(
      "Server action failed: 500",
    );
    await expect(createServerReference("temporary-change")(new Point(1, 2))).rejects.toThrow(
      "Server action failed: 500",
    );
    expect(String(errors[0])).toContain('Cannot read "x" of a value the browser sent');
    expect(String(errors[1])).toContain("Cannot change a value the browser sent");
  });

  it("only go back to the call that sent them", async () => {
    const errors: unknown[] = [];
    let kept: unknown;
    const keep = async (value: unknown) => {
      kept = value;
    };
    const giveBack = async () => kept;
    registerServerReference(keep, "temporary-keep");
    registerServerReference(giveBack, "temporary-give-back");
    serve({ onError: (error) => errors.push(error) });
    await createServerReference("temporary-keep")(new Point(1, 2));
    await expect(createServerReference("temporary-give-back")()).rejects.toThrow(
      "Server action failed: 500",
    );
    expect(String(errors[0])).toContain("another server action call");
  });

  it("leave app data shaped like their tag as data", async () => {
    const forged = async () => ({ $: "t", v: 0 });
    registerServerReference(forged, "temporary-forged");
    serve();
    // The action returns app data shaped like the tag: it travels as data, not as a reference.
    expect(await createServerReference("temporary-forged")()).toEqual({ $: "t", v: 0 });
  });

  it("leave promises to fail as before: they are not temporary references", async () => {
    const take = async (_value: unknown) => null;
    registerServerReference(take, "temporary-promise");
    serve();
    await expect(createServerReference("temporary-promise")(Promise.resolve(1))).rejects.toThrow(
      "class instances (Promise) are not serializable",
    );
  });
});
