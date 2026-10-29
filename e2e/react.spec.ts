import { expect, test, type Page } from "@playwright/test";

const unique = () => `item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function hydrated(page: Page) {
  await page.waitForFunction(
    () => document.querySelectorAll("f-island[strategy=load]:not([hydrated])").length === 0,
  );
}

test.describe("islands", () => {
  test("hydrate on their own, with typed props and server children", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    await page.goto("/");
    await hydrated(page);
    await page.getByTestId("first").click();
    await expect(page.getByTestId("first")).toHaveText("first 2");
    await expect(page.getByTestId("second")).toHaveText("second 10");
    await expect(page.getByTestId("typed")).toHaveText(
      "2026-10-29T00:00:00.000Z apples=3 9007199254740994",
    );
    await page.getByTestId("toggle").click();
    await expect(page.getByTestId("server-child")).toHaveCount(0);
    await page.getByTestId("toggle").click();
    await expect(page.getByTestId("server-child")).toHaveText("rendered on the server");
    expect(errors).toEqual([]);
  });

  test("wait for their trigger: visible and interaction", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    const later = page.locator('f-island[export="Later"]');
    await expect(later).not.toHaveAttribute("hydrated");
    const onClick = page.locator('f-island[export="OnClick"]');
    await expect(onClick).not.toHaveAttribute("hydrated");
    // The first click hydrates it and is replayed, so it counts.
    await page.getByTestId("on-click").click();
    await expect(page.getByTestId("on-click")).toHaveText("on click 1");
    await page.getByTestId("later").scrollIntoViewIfNeeded();
    await expect(later).toHaveAttribute("hydrated", "");
    await page.getByTestId("later").click();
    await expect(page.getByTestId("later")).toHaveText("later 1");
  });
});

test.describe("actions with JavaScript", () => {
  test("run an inline action with its captured values, refresh the page, keep island state", async ({
    page,
  }) => {
    await page.goto("/todos");
    await hydrated(page);
    await page.getByTestId("clicks").click();
    await page.getByTestId("clicks").click();
    const title = unique();
    await page.getByTestId("title").fill(title);
    await page.getByTestId("add").click();
    await expect(page.getByTestId("items")).toContainText(`${title} by Ada`);
    // The page rendered again; the island kept its state.
    await expect(page.getByTestId("clicks")).toHaveText("clicks 2");
    expect(new URL(page.url()).pathname).toBe("/todos");
  });

  test('run a "use server" module\'s action', async ({ page }) => {
    await page.goto("/todos");
    await hydrated(page);
    const title = unique();
    await page.getByTestId("inbox-title").fill(title);
    await page.getByTestId("inbox-add").click();
    await expect(page.getByTestId("inbox")).toContainText(title);
  });

  test("call an action passed to an island, and keep useActionState's result", async ({ page }) => {
    await page.goto("/todos");
    await hydrated(page);
    await page.getByTestId("rename").click();
    await expect(page.getByTestId("rename")).toHaveText("Ada renamed groceries from island");
    await page.getByTestId("vote").click();
    await expect(page.getByTestId("votes")).toHaveText("votes 2");
    await page.getByTestId("vote").click();
    await expect(page.getByTestId("votes")).toHaveText("votes 4");
  });
});

test.describe("actions without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("post forms, and show useActionState's result", async ({ page }) => {
    await page.goto("/todos");
    const title = unique();
    await page.getByTestId("title").fill(title);
    await page.getByTestId("add").click();
    await expect(page.getByTestId("items")).toContainText(`${title} by Ada`);
    expect(new URL(page.url()).pathname).toBe("/todos");

    await page.getByTestId("vote").click();
    await expect(page.getByTestId("votes")).toHaveText("votes 2");
  });
});
