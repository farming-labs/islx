import { expect, test } from "@playwright/test";

test("a click before the browser entry runs is held, then replayed on the hydrated island", async ({
  page,
}) => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  // Hold the browser entry back, as a slow network would.
  await page.route(/islx-entry|client-entry/, async (route) => {
    await released;
    await route.continue();
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("first").click();
  await page.getByTestId("on-click").click();
  // Nothing has hydrated yet: both clicks are held.
  expect(await page.evaluate(() => (window as any).__islxPending.length)).toBe(2);
  await expect(page.getByTestId("first")).toHaveText("first 1");
  release();
  await expect(page.getByTestId("first")).toHaveText("first 2");
  await expect(page.getByTestId("on-click")).toHaveText("on click 1");
});
