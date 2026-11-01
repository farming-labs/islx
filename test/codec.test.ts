import { describe, expect, it } from "vitest";
import { EncodeError, NOT_A_VALUE, decode, decodeTagged, encode, getTag } from "@farm.js/islx";

// Every type JSON cannot hold, as a server component might pass them.
export const sample = () => ({
  updated: new Date("2026-10-28T09:00:00.000Z"),
  invalid: new Date(Number.NaN),
  tags: new Set(["new", "sale"]),
  stock: new Map<unknown, unknown>([
    ["sku-1", 3],
    [7, new Date("2026-01-01T00:00:00.000Z")],
  ]),
  id: 12345678901234567890n,
  missing: undefined,
  ratio: Number.NaN,
  limit: Infinity,
  floor: -Infinity,
  sign: -0,
  site: new URL("https://example.com/shop?q=1"),
  pattern: /ab+c/gi,
  bytes: new Uint8Array([0, 1, 254, 255]),
  floats: new Float64Array([1.5, -2.25]),
  buffer: new Uint16Array([1, 65535]).buffer,
  nested: [{ at: new Date("2026-02-03T04:05:06.000Z"), set: new Set([1n]) }],
});

export function expectSample(value: any) {
  expect(value.updated.toISOString()).toBe("2026-10-28T09:00:00.000Z");
  expect(Number.isNaN(value.invalid.getTime())).toBe(true);
  expect(value.tags).toEqual(new Set(["new", "sale"]));
  expect(value.stock.get("sku-1")).toBe(3);
  expect(value.stock.get(7)).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  expect(value.id).toBe(12345678901234567890n);
  expect("missing" in value).toBe(true);
  expect(value.missing).toBeUndefined();
  expect(Number.isNaN(value.ratio)).toBe(true);
  expect(value.limit).toBe(Infinity);
  expect(value.floor).toBe(-Infinity);
  expect(Object.is(value.sign, -0)).toBe(true);
  expect(value.site).toBeInstanceOf(URL);
  expect(value.site.href).toBe("https://example.com/shop?q=1");
  expect(value.pattern).toEqual(/ab+c/gi);
  expect(value.bytes).toEqual(new Uint8Array([0, 1, 254, 255]));
  expect(value.floats).toEqual(new Float64Array([1.5, -2.25]));
  expect(new Uint16Array(value.buffer)).toEqual(new Uint16Array([1, 65535]));
  expect(value.nested[0].at).toEqual(new Date("2026-02-03T04:05:06.000Z"));
  expect(value.nested[0].set).toEqual(new Set([1n]));
}

describe("codec", () => {
  it("round-trips every type through JSON", () => {
    const json = JSON.stringify(encode(sample()));
    expect(json).toContain('{"$":"D","v":"2026-10-28T09:00:00.000Z"}');
    expect(json).toContain('{"$":"B","v":"12345678901234567890"}');
    expect(json).toContain(
      '{"$":"M","v":[["sku-1",3],[7,{"$":"D","v":"2026-01-01T00:00:00.000Z"}]]}',
    );
    expectSample(decode(JSON.parse(json)));
  });

  it("decodes untrusted input safely", () => {
    const decoded = decode(JSON.parse('{"__proto__":{"admin":true},"a":1}')) as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(Object.keys(decoded)).toEqual(["__proto__", "a"]);
    expect(() => decode({ $: "B", v: "1e9" })).toThrow('malformed "B" tag');
    expect(() => decode({ $: "Y", v: ["Window", "AAAA"] })).toThrow("malformed");
    expect(() => decode({ $: "zz" })).toThrow('unknown "zz" tag');
    // A browser cannot smuggle in the runtime's own references.
    expect(() => decode({ $: "a", v: "some-action" })).toThrow("not allowed");
    expect(() => decode({ $: "a", v: "some-action", b: "sealed" })).toThrow("not allowed");
    expect(() => decode({ $: "r", v: "04jiw29097x8ki" })).toThrow("not allowed");
    // A promise only travels from the server to an island, never in an action's arguments.
    expect(() => decode({ $: "T", v: "x.0" })).toThrow("not allowed");
    expect(decodeTagged({ $: "r", v: "x" }, (value) => value)).toBe(NOT_A_VALUE);
  });

  it("decodes references only through the caller's hook", () => {
    const decodeReference = (object: Record<string, unknown>) =>
      object.$ === "a" ? `action:${object.v}` : undefined;
    expect(decode([{ $: "a", v: "id" }], { decodeReference })).toEqual(["action:id"]);
    // A reference the hook refuses still throws.
    expect(() => decode([{ $: "s", v: "slot" }], { decodeReference })).toThrow("not allowed");
  });

  it("wraps app data that looks like a tag, and names values it cannot carry", () => {
    const lookalike = { $: "D", v: "not a date", note: 1 };
    const wrapped = encode(lookalike);
    expect(wrapped).toEqual({ $: "o", v: { $: "D", v: "not a date", note: 1 } });
    expect(decode(JSON.parse(JSON.stringify(wrapped)))).toEqual(lookalike);
    // Even an action-shaped object of the app's travels as data.
    expect(getTag(encode({ $: "a", v: "x", b: "y" }))).toBe("o");

    expect(() => encode({ run: () => {} })).toThrow("run: functions are not serializable");
    class Pool {}
    let error: unknown;
    try {
      encode({ user: { roles: [1, 2, new Pool()] } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EncodeError);
    expect((error as EncodeError).location).toBe("user.roles[2]");
    expect((error as EncodeError).reason).toBe("class instances (Pool) are not serializable");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => encode(circular)).toThrow("self: circular");
    expect(() => encode({ s: Symbol("x") })).toThrow("symbol values");
  });

  it("encodes functions through the caller's hook", () => {
    const action = async () => {};
    expect(
      encode(
        { save: action },
        { encodeFunction: (fn) => (fn === action ? { $: "a", v: "id" } : undefined) },
      ),
    ).toEqual({
      save: { $: "a", v: "id" },
    });
  });

  it("keeps shared values without treating them as circular", () => {
    const shared = { a: 1 };
    expect(encode([shared, shared])).toEqual([{ a: 1 }, { a: 1 }]);
  });
});
