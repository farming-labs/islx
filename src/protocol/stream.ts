/**
 * Streams as chains of promises: each step settles to a chunk and the promise of the next step,
 * or to the end. A stream travels as its first step's promise, so it reuses how promises travel:
 * each step is written when it settles, and the browser rebuilds the stream from them.
 */

/** What a step settles to: a chunk and the next step (`v`, `n`), or the end (`d`, with `v`). */
export type StreamStep = { v: unknown; n: PromiseLike<StreamStep> } | { d: 1; v?: unknown };

/** `r`: a `ReadableStream`; `i`: an async iterable; `t`: an async iterator (a generator). */
export type StreamKind = "r" | "i" | "t";

/** The kind of stream `value` is, or `undefined` for anything else. */
export function getStreamKind(value: unknown): StreamKind | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (typeof ReadableStream === "function" && value instanceof ReadableStream) return "r";
  const iterate = (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
  if (typeof iterate !== "function") return undefined;
  // An iterator is its own iterable, as a generator is.
  return typeof (value as { next?: unknown }).next === "function" && iterate.call(value) === value
    ? "t"
    : "i";
}

/** The steps of `source`, read as the previous chunk is sent. */
export function toStreamSteps(source: object, kind: StreamKind): Promise<StreamStep> {
  const next: () => Promise<{ done?: boolean; value?: unknown }> =
    kind === "r"
      ? (
          (reader) => () =>
            reader.read()
        )((source as ReadableStream).getReader())
      : (
          (iterator) => () =>
            iterator.next()
        )(
          kind === "t"
            ? (source as AsyncIterator<unknown>)
            : (source as AsyncIterable<unknown>)[Symbol.asyncIterator](),
        );
  const step = (): Promise<StreamStep> =>
    next().then((read) =>
      read.done
        ? read.value === undefined
          ? { d: 1 }
          : { d: 1, v: read.value }
        : { v: read.value, n: step() },
    );
  return step();
}

/** The stream whose steps start with `first`, of the kind it was on the server. */
export function fromStreamSteps(first: PromiseLike<StreamStep>, kind: StreamKind): unknown {
  if (kind === "r") {
    let current = first;
    return new ReadableStream({
      async pull(controller) {
        const step = await current;
        if ("d" in step) return controller.close();
        controller.enqueue(step.v);
        current = step.n;
      },
    });
  }
  async function* iterate(): AsyncGenerator<unknown, unknown> {
    let current = first;
    for (;;) {
      const step = await current;
      if ("d" in step) return step.v;
      yield step.v;
      current = step.n;
    }
  }
  // An iterable reads from the start each time, as its steps stay settled; an iterator once.
  return kind === "t" ? iterate() : { [Symbol.asyncIterator]: iterate };
}
