// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerReference } from "@farm.js/islx/client";
import { handleAction, registerServerReference } from "@farm.js/islx/server";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// The browser's fetch, answered by the server's handler, as one origin.
function serve(options: Parameters<typeof handleAction>[1] = {}) {
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

async function readAll(value: unknown): Promise<unknown[]> {
  const chunks: unknown[] = [];
  if (value instanceof ReadableStream) {
    const reader = value.getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      chunks.push(read.value);
    }
    return chunks;
  }
  for await (const chunk of value as AsyncIterable<unknown>) chunks.push(chunk);
  return chunks;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("an action's result", () => {
  it("streams the promises, ReadableStreams and async iterables in it, as React Server Components do", async () => {
    async function* rows() {
      for (const row of ["a", "b"]) {
        await tick();
        yield { row };
      }
      return "done";
    }
    const report = async () => ({
      title: "report",
      total: tick().then(() => 2),
      bytes: new ReadableStream<Uint8Array>({
        async start(controller) {
          await tick();
          controller.enqueue(new Uint8Array([1, 2]));
          controller.close();
        },
      }),
      rows: rows(),
      words: {
        [Symbol.asyncIterator]: async function* () {
          yield "hi";
        },
      },
    });
    registerServerReference(report, "stream-report");
    serve();
    const result = (await createServerReference("stream-report")()) as {
      title: string;
      total: Promise<number>;
      bytes: ReadableStream<Uint8Array>;
      rows: AsyncIterator<{ row: string }, string>;
      words: AsyncIterable<string>;
    };
    expect(result.title).toBe("report");
    expect(await result.total).toBe(2);
    expect(await readAll(result.bytes)).toEqual([new Uint8Array([1, 2])]);
    expect(await result.rows.next()).toEqual({ value: { row: "a" }, done: false });
    expect(await result.rows.next()).toEqual({ value: { row: "b" }, done: false });
    expect(await result.rows.next()).toEqual({ value: "done", done: true });
    expect(await readAll(result.words)).toEqual(["hi"]);
  });

  it("returns before its streams finish, and a returned promise resolves later", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    registerServerReference(async () => ({ later: gate.then(() => "late") }), "stream-gate");
    serve();
    const result = (await createServerReference("stream-gate")()) as { later: Promise<string> };
    let settled = false;
    void result.later.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    release();
    expect(await result.later).toBe("late");
  });

  it("rejects a failed promise or stream in the browser without the server's reason", async () => {
    const onError = vi.fn();
    registerServerReference(
      async () => ({
        lost: tick().then(() => Promise.reject(new Error("password hunter2"))),
        broken: new ReadableStream({
          async start(controller) {
            controller.enqueue("ok");
            await tick();
            controller.error(new Error("disk hunter2"));
          },
        }),
      }),
      "stream-fails",
    );
    serve({ onError });
    const result = (await createServerReference("stream-fails")()) as {
      lost: Promise<never>;
      broken: ReadableStream<string>;
    };
    await expect(result.lost).rejects.toThrow("rejected on the server");
    const reader = result.broken.getReader();
    expect(await reader.read()).toEqual({ value: "ok", done: false });
    await expect(reader.read()).rejects.toThrow("rejected on the server");
    expect(String(onError.mock.calls)).toContain("hunter2");
  });
});

describe("an action's arguments and result", () => {
  it("keep values that contain themselves, as React Server Components do", async () => {
    type Node = { name: string; self?: Node; children: Array<{ parent: Node }> };
    const echo = async (node: Node) => {
      expect(node.self).toBe(node);
      expect(node.children[0]!.parent).toBe(node);
      const reply: Node = { name: `${node.name}!`, children: [] };
      reply.self = reply;
      reply.children.push({ parent: reply });
      return { reply, later: Promise.resolve(reply) };
    };
    registerServerReference(echo, "cycle-echo");
    serve();
    const node: Node = { name: "root", children: [] };
    node.self = node;
    node.children.push({ parent: node });
    const { reply, later } = (await createServerReference("cycle-echo")(node)) as {
      reply: Node;
      later: Promise<Node>;
    };
    expect(reply.name).toBe("root!");
    expect(reply.self).toBe(reply);
    expect(reply.children[0]!.parent).toBe(reply);
    const settled = await later;
    expect(settled.self).toBe(settled);
  });

  it("settle a promise to the object that holds it, as React Server Components do", async () => {
    type Holder = {
      name: string;
      self?: Promise<Holder>;
      items: Array<{ owner: Promise<Holder> }>;
    };
    const make = async () => {
      const holder: Holder = { name: "holder", items: [] };
      holder.self = Promise.resolve(holder);
      holder.items.push({ owner: holder.self });
      return holder;
    };
    registerServerReference(make, "cycle-promise");
    serve();
    const holder = (await createServerReference("cycle-promise")()) as Holder;
    expect(await holder.self).toBe(holder);
    // The same promise met twice is one promise in the browser.
    expect(holder.items[0]!.owner).toBe(holder.self);
  });

  it("let a stream's chunks refer to what holds the stream, without keeping every chunk", async () => {
    type Feed = { name: string; chunks?: ReadableStream<{ feed: Feed; index: number }> };
    const make = async () => {
      const feed: Feed = { name: "feed" };
      let index = 0;
      feed.chunks = new ReadableStream({
        pull(controller) {
          if (index === 3) return controller.close();
          controller.enqueue({ feed, index: index++ });
        },
      });
      return feed;
    };
    registerServerReference(make, "cycle-stream");
    serve();
    const feed = (await createServerReference("cycle-stream")()) as Feed;
    const seen: number[] = [];
    for await (const chunk of feed.chunks as unknown as AsyncIterable<{
      feed: Feed;
      index: number;
    }>) {
      expect(chunk.feed).toBe(feed);
      seen.push(chunk.index);
    }
    expect(seen).toEqual([0, 1, 2]);
  });
});
