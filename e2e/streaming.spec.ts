import { expect, test } from "@playwright/test";

test("an island that streams in after the entry has run hydrates", async ({ page }) => {
  await page.goto("/");
  const streamed = page.locator("[data-testid=streamed]");
  await expect(streamed).toHaveText("streamed 100");
  // Clicks on an island that has not hydrated are held; give hydration time to happen first.
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
  await streamed.click();
  await expect(streamed).toHaveText("streamed 101");
});
