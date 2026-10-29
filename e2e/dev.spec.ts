import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const example = path.join(import.meta.dirname, "..", "examples", "react", "src");

/** Edits a source file for the test, and puts it back afterwards. */
async function edit(file: string, from: string, to: string) {
  const full = path.join(example, file);
  const original = await readFile(full, "utf8");
  if (!original.includes(from)) throw new Error(`${file} does not contain ${from}`);
  await writeFile(full, original.replace(from, to));
  return () => writeFile(full, original);
}

test.describe("development", () => {
  test.skip(({ baseURL }) => !baseURL?.endsWith(":4312"), "development server only");

  test("updates an edited island in place, keeping its state", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(
      () => document.querySelectorAll("f-island[strategy=load]:not([hydrated])").length === 0,
    );
    await page.getByTestId("first").click();
    await expect(page.getByTestId("first")).toHaveText("first 2");
    let reloaded = false;
    page.on("load", () => (reloaded = true));
    const restore = await edit("components/counter.tsx", "{label} {count}", "{label}: {count}");
    try {
      await expect(page.getByTestId("first")).toHaveText("first: 2");
      expect(reloaded).toBe(false);
    } finally {
      await restore();
    }
    await expect(page.getByTestId("first")).toHaveText("first 2");
  });

  test("reloads the page when a server component changes", async ({ page }) => {
    await page.goto("/");
    const restore = await edit("pages/home.tsx", "islx on Vite", "islx on Vite, edited");
    try {
      await expect(page.locator("h1")).toHaveText("islx on Vite, edited");
    } finally {
      await restore();
    }
    await expect(page.locator("h1")).toHaveText("islx on Vite");
  });
});

test.describe("production", () => {
  test.skip(({ baseURL }) => !baseURL?.endsWith(":4311"), "production build only");

  test("preloads the code of islands that hydrate on load, not of deferred ones", async ({
    page,
  }) => {
    const response = await page.goto("/");
    const html = await response!.text();
    const preloads = [...html.matchAll(/<link rel="modulepreload"[^>]*href="([^"]+)"/g)].map(
      (match) => match[1]!,
    );
    expect(preloads.some((href) => /\/assets\/counter-[^/]+\.js$/.test(href))).toBe(true);
    expect(preloads.some((href) => /\/assets\/panel-[^/]+\.js$/.test(href))).toBe(true);
    expect(preloads.some((href) => /\/assets\/later-[^/]+\.js$/.test(href))).toBe(false);
  });
});
