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
  await page.getByRole("treeitem", { name: /^chat claude-opus-4-1|^chat claude-sonnet-4-5/ }).last().click();
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

  test("run list, phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/p/demo/runs");
    await settle(page);
    await page.screenshot({ path: `${OUT}/run-list-phone.png` });
  });
});
