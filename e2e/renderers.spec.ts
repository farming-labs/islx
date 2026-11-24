import { expect, test, type Page } from "@playwright/test";

// examples/renderers: the same three islands on a page per renderer, each written by that
// renderer's string renderer and hydrated through @farm.js/islx/islands/client.
const renderers = ["preact", "vue", "svelte", "solid"] as const;

/** Page errors, console errors and warnings: a hydration mismatch is reported as one of them. */
function problems(page: Page): string[] {
  const seen: string[] = [];
  page.on("pageerror", (error) => seen.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") seen.push(message.text());
  });
  return seen;
}

/** Whether each element is still the node the server's HTML created. */
function serverNodes(page: Page, ids: string[]): Promise<boolean[]> {
  return page.evaluate(
    (ids) =>
      ids.map((id) =>
        (window as unknown as { __serverNodes: Element[] }).__serverNodes.includes(
          document.querySelector(`[data-testid="${id}"]`)!,
        ),
      ),
    ids,
  );
}

const island = (page: Page, strategy: string) => page.locator(`f-island[strategy="${strategy}"]`);

for (const renderer of renderers) {
  test.describe(renderer, () => {
    test("hydrates a load island over the server's DOM, with typed props", async ({ page }) => {
      const seen = problems(page);
      await page.goto(`/${renderer}`);
      await expect(island(page, "load")).toHaveAttribute("hydrated", "");
      await expect(page.getByTestId("load-props")).toHaveText("2026-11-23T00:00:00.000Z a=1");
      await page.getByTestId("load").click();
      await expect(page.getByTestId("load")).toHaveText("load 2");
      expect(await serverNodes(page, ["load", "load-props"])).toEqual([true, true]);
      expect(seen).toEqual([]);
    });

    test("replays the click that wakes an interaction island, once", async ({ page }) => {
      const seen = problems(page);
      await page.goto(`/${renderer}`);
      await expect(island(page, "load")).toHaveAttribute("hydrated", "");
      await expect(island(page, "interaction")).not.toHaveAttribute("hydrated");
      await page.getByTestId("interaction").click();
      await expect(island(page, "interaction")).toHaveAttribute("hydrated", "");
      await expect(page.getByTestId("interaction")).toHaveText("interaction 11");
      // A click replayed twice, or a handler bound twice, shows on the next one.
      await page.getByTestId("interaction").click();
      await expect(page.getByTestId("interaction")).toHaveText("interaction 12");
      await expect(page.getByTestId("interaction-props")).toHaveText(
        "2026-11-24T00:00:00.000Z a=2",
      );
      expect(await serverNodes(page, ["interaction"])).toEqual([true]);
      expect(seen).toEqual([]);
    });

    test("hydrates a visible island when it scrolls into view", async ({ page }) => {
      const seen = problems(page);
      await page.goto(`/${renderer}`);
      await expect(island(page, "load")).toHaveAttribute("hydrated", "");
      await expect(island(page, "visible")).not.toHaveAttribute("hydrated");
      await page.getByTestId("visible").scrollIntoViewIfNeeded();
      await expect(island(page, "visible")).toHaveAttribute("hydrated", "");
      await page.getByTestId("visible").click();
      await expect(page.getByTestId("visible")).toHaveText("visible 101");
      expect(await serverNodes(page, ["visible"])).toEqual([true]);
      expect(seen).toEqual([]);
    });
  });
}

test("solid: an island that wakes after the page's first click works, on fresh DOM", async ({
  page,
}) => {
  const seen = problems(page);
  await page.goto("/solid");
  await expect(island(page, "load")).toHaveAttribute("hydrated", "");
  await page.getByTestId("load").click();
  await expect(page.getByTestId("load")).toHaveText("load 2");
  await page.getByTestId("visible").scrollIntoViewIfNeeded();
  await expect(island(page, "visible")).toHaveAttribute("hydrated", "");
  await page.getByTestId("visible").click();
  await expect(page.getByTestId("visible")).toHaveText("visible 101");
  // Solid 1.9 stops hydrating after the page's first delegated event and renders the island
  // again instead, as the README says.
  expect(await serverNodes(page, ["visible"])).toEqual([false]);
  expect(seen).toEqual([]);
});
