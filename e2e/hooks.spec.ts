import { expect, test } from "@playwright/test";

test.describe("hooks from the plugin's options", () => {
  test("run in the browser: hydrate, navigated, actionEnd", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(
      () => document.querySelectorAll("f-island[strategy=load]:not([hydrated])").length === 0,
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__islxEvents?.filter((event: unknown[]) => event[0] === "hydrate"),
        ),
      )
      .toContainEqual(["hydrate", "Counter", "number"]);
    // The same as a DOM event, for scripts outside the app.
    const dom = page.evaluate(
      () =>
        new Promise((resolve) =>
          document.addEventListener(
            "f:navigated",
            (event) => resolve((event as CustomEvent).detail.url.pathname),
            { once: true },
          ),
        ),
    );
    await page.getByRole("link", { name: "Todos", exact: true }).click();
    expect(await dom).toBe("/todos");
    await expect
      .poll(() => page.evaluate(() => (window as any).__islxEvents))
      .toContainEqual(["navigated", "/todos", "number"]);
    await page.waitForFunction(
      () => document.querySelectorAll("f-island[strategy=load]:not([hydrated])").length === 0,
    );
    await page.getByTestId("rename").click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__islxEvents))
      .toContainEqual(["actionEnd", "inline", true]);
  });

  test("wrap every action on the server", async ({ page }) => {
    await page.goto("/todos");
    const before = Number(
      (await page.getByTestId("inbox-actions").textContent())!.replace(/\D+/g, ""),
    );
    await page.waitForFunction(
      () => document.querySelectorAll("f-island[strategy=load]:not([hydrated])").length === 0,
    );
    await page.getByTestId("inbox-title").fill(`hooked-${Date.now()}`);
    await page.getByTestId("inbox-add").click();
    await expect(page.getByTestId("inbox-actions")).toHaveText(`inbox actions ${before + 1}`);
  });
});
