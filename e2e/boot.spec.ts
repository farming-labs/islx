import { expect, test, type Page } from "@playwright/test";

// The boot script (`@farm.js/islx/boot`) starts every page and loads the browser entry when the
// page first needs it. /quiet has one island that only reacts to clicks: islx infers
// "interaction" for it, so the page needs the entry only once it is clicked.
test.skip(({ baseURL }) => !/:431[12]$/.test(baseURL ?? ""), "the React example only");

function scripts(page: Page): string[] {
  const requested: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") requested.push(decodeURIComponent(request.url()));
  });
  return requested;
}

/** The browser entry: built, or served by the dev server. */
const isEntry = (url: string) =>
  /\/islx-entry-[^/]+\.js$/.test(url) || url.includes("virtual:islx/client-entry");

test("a page whose islands all wait loads the entry only when one is clicked", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requested = scripts(page);
  await page.goto("/quiet");
  await page.waitForLoadState("networkidle");
  const like = page.getByTestId("like");
  await expect(page.locator("f-island")).toHaveAttribute("strategy", "interaction");
  expect(requested.filter(isEntry)).toEqual([]);
  // The first click is held, the island hydrates, and the click is replayed.
  await like.click();
  await expect(like).toHaveText("likes 1");
  expect(requested.filter(isEntry)).toHaveLength(1);
  await like.click();
  await expect(like).toHaveText("likes 2");
  expect(errors).toEqual([]);
});

test("a link followed before the entry runs is a client navigation", async ({ page }) => {
  const requested = scripts(page);
  await page.goto("/quiet");
  await page.waitForLoadState("networkidle");
  expect(requested.filter(isEntry)).toEqual([]);
  await page.evaluate(() => Object.assign(window, { __sameDocument: true }));
  // No pointer before the click: nothing has started the entry, so the boot holds the click.
  await page.getByRole("link", { name: "Todos", exact: true }).dispatchEvent("click");
  await expect(page.locator("h1")).toHaveText("Todos");
  expect(await page.evaluate(() => "__sameDocument" in window)).toBe(true);
});

test("a page with an island that hydrates at load loads the entry at once", async ({ page }) => {
  const requested = scripts(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  expect(requested.filter(isEntry)).toHaveLength(1);
  await expect(page.getByTestId("first")).toBeVisible();
});
