import { describe, expect, it } from "vitest";
import {
  SealError,
  createActionKeys,
  generateActionKey,
  sealBound,
  unsealBound,
} from "furrow/server";

const key = generateActionKey();

async function rejection(promise: Promise<unknown>): Promise<SealError> {
  const error = await promise.then(
    () => undefined,
    (caught) => caught,
  );
  expect(error).toBeInstanceOf(SealError);
  return error as SealError;
}

describe("sealed captured values", () => {
  it("round-trips typed values", async () => {
    const keys = await createActionKeys(key);
    const user = {
      id: 42,
      joined: new Date("2026-01-01T00:00:00.000Z"),
      roles: new Set(["admin"]),
    };
    const sealed = await sealBound(keys, "page#inline:0", [user, 7n]);
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("42");
    expect(await unsealBound(keys, "page#inline:0", sealed)).toEqual([user, 7n]);
  });

  it("seals the same values differently each time", async () => {
    const keys = await createActionKeys(key);
    expect(await sealBound(keys, "a", [1])).not.toBe(await sealBound(keys, "a", [1]));
  });

  it("opens only for the action it was sealed for", async () => {
    const keys = await createActionKeys(key);
    const sealed = await sealBound(keys, "page#inline:0", [{ id: 42 }]);
    const error = await rejection(unsealBound(keys, "page#inline:1", sealed));
    expect(error.reason).toBe("invalid");
  });

  it("rejects changed or malformed values", async () => {
    const keys = await createActionKeys(key);
    const sealed = await sealBound(keys, "a", [{ id: 42 }]);
    // Flip one character of the ciphertext (the final character may hold only padding bits).
    const at = sealed.length - 5;
    const changed = sealed.slice(0, at) + (sealed[at] === "A" ? "B" : "A") + sealed.slice(at + 1);
    expect((await rejection(unsealBound(keys, "a", changed))).reason).toBe("invalid");
    expect((await rejection(unsealBound(keys, "a", "not base64!"))).reason).toBe("invalid");
    expect((await rejection(unsealBound(keys, "a", ""))).reason).toBe("invalid");
    expect((await rejection(unsealBound(keys, "a", sealed.slice(0, 10)))).reason).toBe("invalid");
  });

  it("reports values sealed with an unknown key as stale, and opens them after rotation", async () => {
    const before = await createActionKeys(key);
    const sealed = await sealBound(before, "a", ["kept"]);
    const next = generateActionKey();
    // A deploy with a new key: the page must reload.
    expect((await rejection(unsealBound(await createActionKeys(next), "a", sealed))).reason).toBe(
      "stale",
    );
    // A deploy that keeps the old key as previous: the page keeps working.
    const rotated = await createActionKeys(next, [key]);
    expect(await unsealBound(rotated, "a", sealed)).toEqual(["kept"]);
    // New values use the new key.
    expect(
      (await rejection(unsealBound(before, "a", await sealBound(rotated, "a", [1])))).reason,
    ).toBe("stale");
  });

  it("names a captured variable it cannot carry", async () => {
    const keys = await createActionKeys(key);
    class Pool {}
    await expect(
      sealBound(keys, "a", [{ id: 1 }, { client: new Pool() }], {
        names: ["user", "db"],
        label: "rename (src/page.tsx)",
      }),
    ).rejects.toThrow(
      "`db` cannot be captured by the server action rename (src/page.tsx) (at db.client): class instances (Pool) are not serializable.",
    );
    await expect(sealBound(keys, "a", [() => {}], { names: ["helper"] })).rejects.toThrow(
      "`helper` cannot be captured by the server action: functions are not serializable.",
    );
  });

  it("carries a captured action through the caller's hooks", async () => {
    const keys = await createActionKeys(key);
    const other = async () => {};
    const sealed = await sealBound(keys, "outer", [other], {
      encodeFunction: (fn) => (fn === other ? { $: "a", v: "other" } : undefined),
    });
    await expect(unsealBound(keys, "outer", sealed)).rejects.toThrow("not allowed");
    expect(
      await unsealBound(keys, "outer", sealed, {
        decodeReference: (object) => (object.$ === "a" ? `stub:${object.v}` : undefined),
      }),
    ).toEqual(["stub:other"]);
  });

  it("refuses a key that is not 32 bytes", async () => {
    await expect(createActionKeys("short")).rejects.toThrow("32 random bytes");
    expect(generateActionKey()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
