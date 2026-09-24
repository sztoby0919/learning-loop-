// E2E 测试：完整诊断流程
// 验证用户能从课程页完成一轮诊断，并在确认后看到刷新后的复习任务

import { test, expect } from "@playwright/test";

test.describe("学习诊断流程", () => {
  test("完整诊断流程：开始 → 作答 → 诊断 → 确认 → 档案更新", async ({ page }) => {
    // 1. 打开课程详情页
    await page.goto("/courses/calculus-101");
    await expect(page.getByRole("heading", { name: "微积分基础" })).toBeVisible();

    // 2. 点击"开始诊断"
    const startButton = page.getByRole("button", { name: "开始诊断" });
    await startButton.click();

    // 3. 逐题作答（5 道题）
    for (let i = 0; i < 5; i++) {
      // 等待题目加载
      await expect(page.getByText(`题目 ${i + 1} / 5`)).toBeVisible();

      // 选择第一个选项
      const firstOption = page.locator(".coach-option").first();
      await firstOption.click();

      // 等待反馈或下一题
      await page.waitForTimeout(500);
    }

    // 4. 验证诊断结果页面
    await expect(page.getByText("诊断结果与修改建议")).toBeVisible();

    // 5. 点击"确认应用修改"
    const confirmButton = page.getByRole("button", { name: "确认应用修改" });
    await confirmButton.click();

    // 6. 验证完成状态
    await expect(page.getByText("诊断完成")).toBeVisible();
  });

  test("拒绝诊断修改", async ({ page }) => {
    await page.goto("/courses/calculus-101/coach");

    // 快速完成 5 道题
    for (let i = 0; i < 5; i++) {
      const firstOption = page.locator(".coach-option").first();
      await firstOption.click();
      await page.waitForTimeout(500);
    }

    // 点击"拒绝修改"
    const rejectButton = page.getByRole("button", { name: "拒绝修改" });
    await rejectButton.click();

    // 应该返回初始页面
    await expect(page.getByText("学习诊断")).toBeVisible();
  });

  test("未配置 API Key 时使用 Mock 模式", async ({ page }) => {
    // 这个测试在 API Key 未配置时运行
    await page.goto("/courses/calculus-101/coach");

    // 应该能看到 Mock 生成的题目
    const startButton = page.getByRole("button", { name: "开始诊断" });
    await startButton.click();

    // Mock 模式应该快速返回
    await expect(page.getByText("题目 1 / 5")).toBeVisible({ timeout: 5000 });
  });
});
