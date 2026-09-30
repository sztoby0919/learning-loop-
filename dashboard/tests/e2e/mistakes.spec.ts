import { expect, test } from "@playwright/test";

test("a confirmed wrong diagnosis becomes a saved targeted attempt after refresh", async ({ page }) => {
  let diagnosisConfirmed = false;
  let practiceConfirmed = false;
  const original = {
    id: "mistake-1", courseId: "calculus-101", question: "导数表示什么？",
    selected: "A. 平均变化率", correct: "B. 瞬时变化率", explanation: "导数描述瞬时变化率。",
    knowledgePoint: "导数", date: "2026-09-28", sourceSession: "diagnosis.md", mode: "mock",
  };
  const saved = {
    ...original, id: "mistake-2", question: "切线斜率表示什么？", selected: "A. 平均变化",
    correct: "B. 瞬时变化", explanation: "切线斜率对应瞬时变化率。", sourceSession: "saved.md", isCorrect: false,
  };
  await page.route("**/api/courses/calculus-101/mistakes", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: diagnosisConfirmed ? [{ ...original, attempts: practiceConfirmed ? [saved] : [] }] : [], warnings: [] }) });
  });
  await page.route("**/api/ai/**", async (route) => {
    const url = route.request().url();
    const body = url.endsWith("/apply") ? (diagnosisConfirmed = true, { success: true })
      : url.endsWith("/proposal") ? { diagnosis: { courseId: "calculus-101", weakPoints: [], remediationTasks: [], nextReviewDate: "2026-09-29" }, files: [{ name: "course.md", before: "旧内容", after: "更新内容" }] }
      : url.endsWith("/answers") ? { feedback: { questionId: "q1", isCorrect: false, score: 0, correctPart: "B. 瞬时变化率", gap: "你选择了 A. 平均变化率", evidence: "导数描述瞬时变化率。" }, nextQuestion: null, answered: 1, total: 1 }
      : { assessmentId: "diagnosis-1", total: 1, question: { id: "q1", question: "导数表示什么？", options: ["平均变化率", "瞬时变化率", "函数值", "面积"], knowledgePoint: "导数" } };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/api/practice-sessions**", async (route) => {
    const url = route.request().url();
    const body = url.endsWith("/confirm") ? (practiceConfirmed = true, { courseId: "calculus-101", mode: "mock", sessionFile: "saved.md" })
      : url.endsWith("/answer") ? { feedback: { questionId: "q2", isCorrect: false, score: 0, correctPart: "B. 瞬时变化", gap: "你选择了 A. 平均变化", evidence: "切线斜率对应瞬时变化率。" } }
      : { sessionId: "practice-1", mode: "mock", question: { id: "q2", question: "切线斜率表示什么？", options: ["平均变化", "瞬时变化", "函数值", "面积"], knowledgePoint: "导数" } };
    await route.fulfill({ status: url.endsWith("/api/practice-sessions") ? 201 : 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto("/courses/calculus-101/mistakes");
  await expect(page.getByText(/暂无已确认的错题/)).toBeVisible();
  await page.goto("/courses/calculus-101");
  await page.getByRole("link", { name: "开始诊断" }).click();
  await page.getByRole("button", { name: "开始诊断" }).click();
  await page.getByRole("radio", { name: "A. 平均变化率" }).check();
  await page.getByRole("button", { name: "提交回答" }).click();
  await page.getByRole("button", { name: "查看诊断报告" }).click();
  await page.getByRole("button", { name: "确认应用修改" }).click();
  await page.goto("/courses/calculus-101");
  await page.getByRole("link", { name: "查看错题本" }).click();
  await expect(page.getByText("导数表示什么？")).toBeVisible();
  await page.getByRole("button", { name: "针对这道错题再练" }).click();
  await expect(page.getByRole("heading", { name: "切线斜率表示什么？" })).toBeVisible();
  await expect(page.getByRole("note")).toContainText(/Mock.*演示题/);
  await page.getByRole("radio", { name: "A. 平均变化" }).check();
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByText(/解析：切线斜率对应瞬时变化率/)).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await page.getByRole("button", { name: "确认保存练习" }).click();
  await expect(page.getByText(/Mock.*演示.*已保存/)).toBeVisible();
  await page.reload();
  const history = page.getByRole("region", { name: "再练历史" });
  await expect(history.getByText("切线斜率表示什么？")).toBeVisible();
  await expect(history).toContainText("答错");
  await expect(history).toContainText("Mock");
  await expect(page.getByRole("button", { name: "针对这道错题再练" })).toHaveCount(1);
  await expect(page.getByText(/已掌握/)).toHaveCount(0);
});
