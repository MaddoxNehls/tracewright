import { expect, test, type Page } from "@playwright/test";

/** Trace id (first 12 hex) of a run row in the current run list. */
const shortIdOfRow = async (page: Page, index: number) =>
  (await page.locator("tbody tr").nth(index).locator("td:nth-child(3) span.font-mono").innerText()).trim();

test("run detail → Compare with… → first divergence → inspector shows the text diff", async ({ page }) => {
  // The model-swap pair: A (Haiku answers, overflows its context) and B (Sonnet answers, succeeds).
  await page.goto("/p/demo/runs?q=llm%20eval&status=error");
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  const baselineId = await shortIdOfRow(page, 1); // the older failure is the swap's baseline

  await page.goto("/p/demo/runs?tag=model-swap");
  await page.locator("tbody tr").first().getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("research: llm eval contamination");

  await page.getByRole("button", { name: "Compare with…" }).click();
  await page.getByRole("list", { name: "Runs to compare with" }).getByRole("link").filter({ hasText: baselineId }).click();
  await expect(page).toHaveURL(/\/p\/demo\/compare\?a=[0-9a-f]{32}&b=[0-9a-f]{32}/);

  // Summary deltas: the swap fixed the run and raised the cost.
  const summary = page.getByTestId("compare-summary");
  await expect(summary).toContainText("Fixed in B");
  await expect(summary).toContainText("Cost");

  const divergence = page.getByTestId("first-divergence");
  await expect(divergence).toContainText("First divergence at row");
  await expect(divergence).toContainText("chat claude-sonnet-5-5");
  await expect(divergence).toContainText("a different model");

  await divergence.getByRole("button", { name: "Jump to this row" }).click();
  const selected = page.locator('[role="option"][aria-selected="true"]');
  await expect(selected).toHaveAttribute("data-status", "modified");
  await expect(selected).toContainText("chat claude-haiku-5-5");
  await expect(selected).toContainText("chat claude-sonnet-5-5");

  const inspector = page.getByTestId("diff-inspector");
  await expect(inspector).toContainText("Modified");
  await expect(inspector).toContainText("claude-haiku-5-5 → claude-sonnet-5-5");
  await inspector.getByRole("tab", { name: /Input diff/ }).click();
  const textDiff = inspector.getByTestId("text-diff");
  await expect(textDiff).toBeVisible();
  await expect(textDiff).toContainText('"model": "claude-sonnet-5-5"');
  await expect(textDiff.locator("tr", { hasText: '"model": "claude-haiku-5-5"' })).toBeVisible();

  await inspector.getByRole("radio", { name: "Words" }).click();
  await expect(inspector.getByTestId("text-diff").locator("ins")).not.toHaveCount(0);

  // Clicking another row re-targets the inspector; added rows only exist in B.
  await page.locator('[role="option"][data-status="added"]').first().click();
  await expect(inspector).toContainText("Added in B");
});

test("replay badge → Compare with original → replayed steps are unchanged", async ({ page }) => {
  await page.goto("/p/demo/runs?tag=replay");
  await page.locator("tbody tr").first().getByRole("link").click();

  const banner = page.getByTestId("replay-banner");
  await expect(banner).toContainText("Replay of");
  await expect(banner).toContainText("with model claude-opus-5-5");
  // Spans served from the recording are marked in the waterfall.
  await expect(page.getByRole("treeitem", { name: /web_search.*replayed/ }).first()).toBeVisible();

  await banner.getByRole("link", { name: "Compare with original" }).click();
  await expect(page).toHaveURL(/\/compare\?a=[0-9a-f]{32}&b=[0-9a-f]{32}/);
  await expect(page.getByText("Replay of A")).toBeVisible();
  await expect(page.getByTestId("first-divergence")).toContainText("chat claude-opus-5-5");

  // Every replayed step lines up as unchanged.
  const replayedRows = page.locator('[role="option"]', { has: page.locator('span:text-is("replayed")') });
  await expect(replayedRows.first()).toBeVisible();
  for (const status of await replayedRows.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))) {
    expect(status).toBe("same");
  }
});

test("select two runs in the list → Compare", async ({ page }) => {
  await page.goto("/p/demo/runs");
  const boxes = page.locator("tbody tr input[type=checkbox]");
  await boxes.nth(0).check();
  await expect(page.getByRole("region", { name: "Compare selection" })).toContainText("Pick one more");
  await boxes.nth(3).check();
  // At most two: the rest are disabled.
  await expect(boxes.nth(5)).toBeDisabled();
  await page.getByRole("region", { name: "Compare selection" }).getByRole("link", { name: "Compare" }).click();
  await expect(page).toHaveURL(/\/p\/demo\/compare\?a=[0-9a-f]{32}&b=[0-9a-f]{32}/);
  await expect(page.getByTestId("compare-summary")).toBeVisible();
  await expect(page.getByRole("listbox", { name: "Aligned steps" })).toBeVisible();
});
