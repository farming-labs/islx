import { expect, test, type Page } from "@playwright/test";

async function hydrated(page: Page) {
  await page.waitForFunction(
    () => document.querySelectorAll("f-island[strategy=load]:not([hydrated])").length === 0,
  );
}

test.describe("navigation", () => {
  test("moves between pages without loading a document, and back", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    await expect(page.getByTestId("slow").filter({ visible: true })).toHaveText("streamed in");
    // Survives only while the document does.
    await page.evaluate(() => ((window as any).__kept = true));
    const documents: string[] = [];
    page.on(
      "request",
      (request) => request.resourceType() === "document" && documents.push(request.url()),
    );
    const fetched: Array<Record<string, string>> = [];
    page.on(
      "request",
      (request) => request.resourceType() === "fetch" && fetched.push(request.headers()),
    );

    await page.getByRole("link", { name: "Todos", exact: true }).click();
    await expect(page).toHaveURL(/\/todos$/);
    await expect(page.locator("h1")).toHaveText("Todos");
    await expect(page).toHaveTitle("todos");
    await hydrated(page);
    await page.getByTestId("clicks").click();
    await expect(page.getByTestId("clicks")).toHaveText("clicks 1");
    expect(fetched[0]?.["f-render"]).toBe("document");

    await page.goBack();
    await expect(page.locator("h1")).toHaveText("islx on Vite");
    await hydrated(page);
    // The page's Suspense content arrives whole, not stuck on its fallback.
    await expect(page.getByTestId("slow")).toHaveText("streamed in");
    await page.getByTestId("first").click();
    await expect(page.getByTestId("first")).toHaveText("first 2");

    await page.goForward();
    await expect(page.locator("h1")).toHaveText("Todos");
    expect(documents).toEqual([]);
    expect(await page.evaluate(() => (window as any).__kept)).toBe(true);
  });

  test("restores the scroll position on back", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.evaluate(() =>
      (document.querySelector('a[href="/todos"]') as HTMLAnchorElement).click(),
    );
    await expect(page.locator("h1")).toHaveText("Todos");
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("islx on Vite");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(1500);
  });

  test("loads the page normally for links that opt out", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    await page.evaluate(() => ((window as any).__kept = true));
    await page.getByTestId("external").click();
    await expect(page.locator("h1")).toHaveText("Todos");
    expect(await page.evaluate(() => (window as any).__kept)).toBeUndefined();
  });
});
