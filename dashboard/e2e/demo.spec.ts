import { expect, test, type Page } from "@playwright/test";

// Run list columns: 1 select, 2 status, 3 run, 4 started, 5 duration, 6 LLM, 7 tools, 8 tokens, 9 cost.
const STATUS_COL = "td:nth-child(2)";
const COST_COL = "td:nth-child(9)";

/** Unknown-model runs show "–" and sort as zero. */
const costsOnPage = async (page: Page) =>
  (await page.locator(`tbody tr ${COST_COL}`).allInnerTexts()).map((c) => (c.trim() === "–" ? 0 : Number(c.replace("$", ""))));

test("landing → demo run list → filter → run detail → inspect an LLM span", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Every step your agent took");

  await page.getByRole("link", { name: "Explore the live demo" }).click();
  await expect(page).toHaveURL(/\/p\/demo\/runs$/);
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(25);
  await expect(page.getByRole("link", { name: "Next page" })).toBeVisible();

  // Status filter lives in the URL.
  await page.getByRole("radio", { name: "Error" }).click();
  await expect(page).toHaveURL(/status=error/);
  await expect(rows).toHaveCount(6);
  for (const status of await rows.locator(STATUS_COL).allInnerTexts()) expect(status.trim()).toBe("Error");

  // Debounced name search narrows further.
  await page.getByRole("searchbox", { name: "Search run names" }).fill("calorie");
  await expect(page).toHaveURL(/q=calorie/);
  await expect(rows).toHaveCount(1);

  await rows.first().getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("research: bike commute calorie burn");
  const tree = page.getByRole("tree", { name: "Span tree" });
  await expect(tree).toBeVisible();

  // The root span is selected by default.
  const inspector = page.getByTestId("span-inspector");
  await expect(inspector.getByRole("heading", { level: 2 })).toHaveText("research: bike commute calorie burn");

  // Select an LLM span: the inspector shows the chat transcript and usage.
  await tree.getByRole("treeitem", { name: /^chat claude-haiku-5-5/ }).first().click();
  await expect(inspector.getByRole("heading", { level: 2 })).toHaveText("chat claude-haiku-5-5");
  await expect(inspector.getByRole("tab", { name: "Conversation", selected: true })).toBeVisible();
  await expect(inspector.getByText("System prompt")).toBeVisible();
  await expect(inspector.getByText("Response", { exact: true })).toBeVisible();
  await expect(inspector.getByText("Input tokens")).toBeVisible();
  await expect(page).toHaveURL(/span=[0-9a-f]{16}/);

  await inspector.getByRole("tab", { name: "Input" }).click();
  await expect(inspector.getByRole("tabpanel")).toContainText('"messages"');

  // The failed step shows its error.
  await tree.getByRole("treeitem", { name: /^calculator/ }).click();
  await expect(inspector.getByRole("alert")).toContainText("ZeroDivisionError");
});

test("keyboard navigation moves through spans", async ({ page }) => {
  await page.goto("/p/demo/runs");
  await page.locator("tbody tr").first().getByRole("link").click();
  const tree = page.getByRole("tree", { name: "Span tree" });
  const selected = tree.locator('[role="treeitem"][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  const first = await selected.getAttribute("data-span-id");

  await page.keyboard.press("j");
  await expect(selected).not.toHaveAttribute("data-span-id", first ?? "");
  await page.keyboard.press("k");
  await expect(selected).toHaveAttribute("data-span-id", first ?? "");

  // ← on an expanded parent collapses it.
  await tree.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tree.getByRole("treeitem")).toHaveCount(1);
  await page.keyboard.press("ArrowRight");
  await expect(tree.getByRole("treeitem")).not.toHaveCount(1);
});

test("sorting and both pagination directions are carried in the URL", async ({ page }) => {
  await page.goto("/p/demo/runs");
  await page.getByRole("link", { name: "Cost" }).click();
  await expect(page).toHaveURL(/sort=cost/);
  const page1 = await costsOnPage(page);
  expect(page1).toEqual([...page1].sort((a, b) => b - a));
  const firstPageIds = await page.locator("tbody tr td:nth-child(3) a").allInnerTexts();

  await page.getByRole("link", { name: "Next page" }).click();
  await expect(page).toHaveURL(/cursor=/);
  await expect(page.locator("tbody tr")).toHaveCount(13);
  const page2 = await costsOnPage(page);
  expect(Math.max(...page2)).toBeLessThanOrEqual(Math.min(...page1));
  await expect(page.locator('[aria-disabled="true"]', { hasText: "Next page" })).toBeVisible();

  await page.getByRole("link", { name: "Previous page" }).click();
  await expect(page).toHaveURL(/before=/);
  await expect(page.locator("tbody tr")).toHaveCount(25);
  expect(await page.locator("tbody tr td:nth-child(3) a").allInnerTexts()).toEqual(firstPageIds);
  await expect(page.locator('[aria-disabled="true"]', { hasText: "Previous page" })).toBeVisible();
});

test("private projects stay hidden without sign-in", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByRole("link", { name: /Research agent \(demo\)/ })).toBeVisible();
  await expect(page.getByText("Internal evals")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();

  const res = await page.goto("/p/internal-evals/runs");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Nothing recorded here" })).toBeVisible();
});

test("an unknown project slug is a real HTTP 404", async ({ page, request }) => {
  for (const path of ["/p/no-such-project", "/p/no-such-project/runs", "/p/no-such-project/compare"]) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
  const res = await page.goto("/p/no-such-project/runs");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Nothing recorded here" })).toBeVisible();
});

test("overview renders charts for the demo project", async ({ page }) => {
  await page.goto("/p/demo");
  for (const title of ["Runs per day", "Cost per day", "Run latency", "Runs by model"]) {
    await expect(page.getByRole("region", { name: title })).toBeVisible();
  }
  await expect(page.locator(".recharts-surface").first()).toBeVisible();
});
