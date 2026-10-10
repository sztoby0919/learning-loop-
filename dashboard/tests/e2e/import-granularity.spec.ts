import { expect, test } from "@playwright/test";

test("a document imports one stage per topic and preserves it after refresh", async ({ page }) => {
  await page.goto("/courses/import");
  await page.getByLabel("选择文件").setInputFiles({
    name: "knowledge-granularity.md", mimeType: "text/markdown",
    buffer: Buffer.from("# 机器学习演示\n## 线性回归\n### 定义\n拟合输入与输出。\n### 例题\n计算预测值。\n## 决策树\n### 性质\n递归划分。"),
  });
  await expect(page.getByLabel("阶段 1", { exact: true })).toHaveValue("线性回归");
  await expect(page.getByLabel("阶段 2", { exact: true })).toHaveValue("决策树");
  await expect(page.locator(".import-stage")).toHaveCount(2);
  await expect(page.getByLabel("阶段 1 任务 3", { exact: true })).toHaveValue(/例题/);
  await page.getByRole("button", { name: "更新预览", exact: true }).click();
  await page.reload();
  await expect(page.locator(".import-stage")).toHaveCount(2);
  await expect(page.getByLabel("阶段 1", { exact: true })).toHaveValue("线性回归");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "取消导入", exact: true }).click();
  await expect(page).toHaveURL(/\/courses$/);
});
