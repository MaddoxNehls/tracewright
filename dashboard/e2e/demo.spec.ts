import { expect, test } from "@playwright/test";

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
  await expect(rows).toHaveCount(4);
  for (const status of await rows.locator("td:first-child").allInnerTexts()) expect(status.trim()).toBe("Error");

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
  await tree.getByRole("treeitem", { name: /^chat claude-haiku-4-5/ }).first().click();
  await expect(inspector.getByRole("heading", { level: 2 })).toHaveText("chat claude-haiku-4-5");
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

test("sorting and pagination are carried in the URL", async ({ page }) => {
  await page.goto("/p/demo/runs");
  await page.getByRole("link", { name: "Cost" }).click();
  await expect(page).toHaveURL(/sort=cost/);
  const costs = await page.locator("tbody tr td:nth-child(8)").allInnerTexts();
  const values = costs.map((c) => Number(c.replace("$", "")));
  expect(values).toEqual([...values].sort((a, b) => b - a));

  await page.getByRole("link", { name: "Next page" }).click();
  await expect(page).toHaveURL(/cursor=/);
  await expect(page.locator("tbody tr")).toHaveCount(7);
  const page2 = (await page.locator("tbody tr td:nth-child(8)").allInnerTexts()).map((c) => Number(c.replace("$", "")));
  expect(Math.max(...page2)).toBeLessThanOrEqual(Math.min(...values));
});

test("private projects stay hidden without sign-in", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByRole("link", { name: /Research agent \(demo\)/ })).toBeVisible();
  await expect(page.getByText("Internal evals")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();

  await page.goto("/p/internal-evals/runs");
  await expect(page.getByRole("heading", { name: "Nothing recorded here" })).toBeVisible();
});

test("overview renders charts for the demo project", async ({ page }) => {
  await page.goto("/p/demo");
  for (const title of ["Runs per day", "Cost per day", "Run latency", "Runs by model"]) {
    await expect(page.getByRole("region", { name: title })).toBeVisible();
  }
  await expect(page.locator(".recharts-surface").first()).toBeVisible();
});
