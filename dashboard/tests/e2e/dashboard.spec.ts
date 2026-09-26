import { expect, test } from "@playwright/test";

test("homepage shows the demo course and opens its details", async ({ page }, testInfo) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "学习总览", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "查看微积分基础课程" })).toBeVisible();

  if (testInfo.project.name === "desktop") {
    await page.screenshot({ path: "test-results/homepage-desktop.png", fullPage: true });
  }

  await page.getByRole("link", { name: "查看微积分基础课程" }).click();
  await expect(page.getByRole("heading", { name: "微积分基础", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "学习路线" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "关键知识" })).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
});

test("all nine navigation destinations render real pages", async ({ page }) => {
  const destinations = [
    ["/", "学习总览"],
    ["/courses", "课程"],
    ["/tasks", "任务"],
    ["/notes", "笔记"],
    ["/review", "复习"],
    ["/resources", "资源"],
    ["/calendar", "日历"],
    ["/stats", "统计"],
    ["/settings", "设置"],
  ] as const;

  for (const [path, title] of destinations) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    await expect(page.locator(".page-error")).toHaveCount(0);
  }
});

test("demo course notes render from the configured Markdown file", async ({ page }) => {
  await page.goto("/notes/calculus-101");

  await expect(page.getByRole("heading", { name: "课程笔记", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "极限与连续", level: 2 })).toBeVisible();
});
