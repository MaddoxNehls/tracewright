import { expect, test, type Page } from "@playwright/test";

/** Refreshes the README screenshots in docs/screenshots. Runs with the rest of the e2e suite. */
const OUT = "docs/screenshots";

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800); // let bar reveal and chart animations finish
}

async function openSolarRun(page: Page) {
  await page.goto("/p/demo/runs?q=solar&sort=cost");
  await page.locator("tbody tr").first().getByRole("link").click();
  await expect(page.getByRole("tree", { name: "Span tree" })).toBeVisible();
  await page.getByRole("treeitem", { name: /^chat claude-(opus|sonnet)-5-5/ }).last().click();
  await settle(page);
}

test.describe("screenshots", () => {
  test("landing", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await page.screenshot({ path: `${OUT}/landing.png`, fullPage: true });
  });

  test("run list", async ({ page }) => {
    await page.goto("/p/demo/runs");
    await settle(page);
    await page.screenshot({ path: `${OUT}/run-list.png` });
  });

  test("run detail", async ({ page }) => {
    await openSolarRun(page);
    await page.screenshot({ path: `${OUT}/run-detail.png` });
  });

  test("run detail, light theme", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("tw-theme", "light"));
    await openSolarRun(page);
    await page.screenshot({ path: `${OUT}/run-detail-light.png` });
  });

  test("overview", async ({ page }) => {
    await page.goto("/p/demo");
    await settle(page);
    await page.screenshot({ path: `${OUT}/overview.png`, fullPage: true });
  });

  test("compare: model swap, first divergence and input diff", async ({ page }) => {
    await page.goto("/p/demo/runs?tag=model-swap");
    await page.locator("tbody tr").first().getByRole("link").click();
    await page.getByRole("button", { name: "Compare with…" }).click();
    // The baseline of the swap is the most recent failed run with this name before it.
    await page.getByRole("list", { name: "Runs to compare with" }).getByRole("link").filter({ hasText: "Error" }).nth(1).click();
    await page.getByTestId("first-divergence").getByRole("button", { name: "Jump to this row" }).click();
    await page.getByTestId("diff-inspector").getByRole("tab", { name: /Input diff/ }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    // Clicking the tab scrolled the sticky inspector; show it from the top for the picture.
    await page.getByTestId("diff-inspector").evaluate((el) => el.closest("aside")?.scrollTo(0, 0));
    await settle(page);
    await page.screenshot({ path: `${OUT}/compare.png`, fullPage: true });
  });

  test("compare: replay against its original", async ({ page }) => {
    await page.goto("/p/demo/runs?tag=replay");
    await page.locator("tbody tr").first().getByRole("link").click();
    await page.getByTestId("replay-banner").getByRole("link", { name: "Compare with original" }).click();
    await expect(page.getByTestId("first-divergence")).toBeVisible();
    await settle(page);
    await page.screenshot({ path: `${OUT}/compare-replay.png`, fullPage: true });
  });

  test("run detail, replay", async ({ page }) => {
    await page.goto("/p/demo/runs?tag=replay");
    await page.locator("tbody tr").first().getByRole("link").click();
    await settle(page);
    await page.screenshot({ path: `${OUT}/run-detail-replay.png` });
  });

  test("run list, phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/p/demo/runs");
    await settle(page);
    await page.screenshot({ path: `${OUT}/run-list-phone.png` });
  });
});
