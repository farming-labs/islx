import { expect, test, type Page } from "@playwright/test";

// examples/tanstack-start: a TanStack Start app with islxTanstackStart(), in production and in
// development.

async function hydrated(page: Page) {
  await page.waitForFunction(
    () => document.querySelectorAll("f-island[strategy=load]:not([hydrated])").length === 0,
  );
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // The example has no favicon.
    if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text());
  });
  return errors;
}

test.describe("TanStack Start", () => {
  test("routes render on the server, and the browser gets only the islands", async ({
    page,
    request,
  }) => {
    const html = await (await request.get("/")).text();
    expect(html).toContain("Hello from the loader (27)");
    expect(html).toContain('<f-island src="src/components/counter.tsx" export="Counter"');
    // The router is not dehydrated: no loader data or manifest for a browser that never runs it.
    expect(html).not.toContain("$_TSR");

    const scripts: string[] = [];
    page.on("response", async (response) => {
      if (response.request().resourceType() === "script") scripts.push(await response.text());
    });
    const errors = collectErrors(page);
    await page.goto("/");
    await hydrated(page);
    const counter = page.getByRole("button", { name: /^Home: / });
    await counter.click();
    await expect(counter).toHaveText("Home: 3");
    for (const script of scripts) {
      expect(script).not.toContain("rendered-on-the-server-only");
      expect(script).not.toContain("useLoaderData");
    }
    expect(errors).toEqual([]);
  });

  test("links move between routes without loading a document, and back", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/");
    await hydrated(page);
    await page.evaluate(() => ((window as unknown as { kept: boolean }).kept = true));
    await page.getByRole("link", { name: "About", exact: true }).click();
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
    await expect(page).toHaveTitle("About islx on TanStack Start");
    const about = page.getByRole("button", { name: /^About: / });
    await about.click();
    await expect(about).toHaveText("About: 11");
    await page.goBack();
    await expect(page.getByRole("button", { name: /^Home: / })).toHaveText("Home: 2");
    expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("a loader's promise streams into an island, which works before it arrives", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto("/stream", { waitUntil: "commit" });
    const early = page.getByRole("button", { name: /^Early: / });
    let quoteFirst = true;
    await expect(async () => {
      await early.click({ timeout: 100 });
      await expect(early).toHaveText(/^Early: [1-9]/, { timeout: 50 });
      quoteFirst = (await page.getByTestId("quote").count()) > 0;
    }).toPass({ intervals: [20], timeout: 10_000 });
    expect(quoteFirst).toBe(false);
    // The value keeps its types (a Date).
    await expect(page.getByTestId("quote")).toHaveText("Streamed from the loader (2026)");
    await expect(page.getByTestId("quote-fallback")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a navigation to a streaming route gets the whole page", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/");
    await hydrated(page);
    await page.getByRole("link", { name: "Stream", exact: true }).click();
    await expect(page.getByTestId("quote")).toHaveText("Streamed from the loader (2026)");
    const likes = page.getByRole("button", { name: /^Likes: / });
    await likes.click();
    await expect(likes).toHaveText("Likes: 1");
    expect(errors).toEqual([]);
  });

  test("islands call Start server functions and islx server actions", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/about");
    await hydrated(page);
    await page.getByRole("button", { name: "Server time" }).click();
    await expect(page.getByTestId("time")).toHaveText("2026-11-01T12:00:00.000Z");
    await page.getByRole("button", { name: "Like twice" }).click();
    await expect(page.getByTestId("likes")).toHaveText(/^\d+$/);
    expect(errors).toEqual([]);
  });
});
