/** Reading a request body within a size limit. */

/** The body was larger than the limit. */
export class BodyTooLargeError extends Error {
  /** The bytes read before the limit was passed, for callers that peek at the start. */
  readonly head: Uint8Array;
  constructor(head: Uint8Array) {
    super("request body is too large");
    this.name = "BodyTooLargeError";
    this.head = head;
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Reads `request`'s body, stopping as soon as it passes `limit` bytes: a lying or missing
 * `Content-Length` cannot make the server buffer more.
 */
export async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const length = request.headers.get("content-length")?.trim();
  if (length && /^\d+$/.test(length) && Number(length) > limit) {
    throw new BodyTooLargeError(new Uint8Array());
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total > limit) {
        void reader.cancel().catch(() => {});
        throw new BodyTooLargeError(concat(chunks, total));
      }
    }
  } finally {
    reader.releaseLock();
  }
  return concat(chunks, total);
}

/** Parses form bytes with the request's content type, as `Request#formData` would. */
export async function parseForm(request: Request, body: Uint8Array): Promise<FormData> {
  return new Request(request.url, {
    method: "POST",
    headers: { "content-type": request.headers.get("content-type") ?? "" },
    body: body as BodyInit,
  }).formData();
}
