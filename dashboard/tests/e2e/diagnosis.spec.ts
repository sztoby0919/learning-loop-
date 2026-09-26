import { expect, test } from "@playwright/test";

test("student can answer, review real file changes, and confirm", async ({ page }) => {
  let applyCount = 0;
  await page.route("**/api/ai/**", async (route) => {
    const url = route.request().url();
    const body = url.endsWith("/apply") ? (applyCount++, { success: true })
      : url.endsWith("/proposal") ? { diagnosis: { courseId: "calculus-101", weakPoints: [{ knowledgePoint: "导数", evidence: "混淆平均与瞬时", severity: "high" }], remediationTasks: ["解释瞬时变化率"], nextReviewDate: "2026-09-28" }, files: [{ name: "course.md", before: "原有课程内容", after: "原有课程内容\n新增补救任务" }] }
      : url.endsWith("/answers") ? { feedback: { questionId: "q1", isCorrect: false, score: 0, correctPart: "B. 瞬时变化率", gap: "你选择了 A. 平均变化率", evidence: "导数描述某一点的瞬时变化率。" }, nextQuestion: null, completed: true, answered: 1, total: 1 }
      : { assessmentId: "browser-assessment", total: 1, question: { id: "q1", question: "导数表示什么？", options: ["平均变化率", "瞬时变化率", "函数值", "积分面积"], knowledgePoint: "导数" } };
    await route.fulfill({ status: url.endsWith("/api/ai/assessments") ? 201 : 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto("/courses/calculus-101");
  await page.getByRole("link", { name: "开始诊断" }).click();
  await page.getByRole("button", { name: "开始诊断" }).click();
  await page.getByRole("radio", { name: "A. 平均变化率" }).check();
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByText(/正确答案：B\. 瞬时变化率/)).toBeVisible();
  await expect(page.getByText(/解析：导数描述某一点的瞬时变化率/)).toBeVisible();
  await expect(page.getByRole("button", { name: "重新作答" })).toHaveCount(0);
  await page.getByRole("button", { name: "查看诊断报告" }).click();
  await expect(page.getByText("原有课程内容", { exact: true })).toBeVisible();
  await expect(page.getByText("原有课程内容\n新增补救任务")).toBeVisible();
  expect(applyCount).toBe(0);
  await page.getByRole("button", { name: "确认应用修改" }).click();
  await expect(page.getByRole("heading", { name: "诊断完成" })).toBeVisible();
  expect(applyCount).toBe(1);
});
