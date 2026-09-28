import { expect, test } from "@playwright/test";

for (const mode of ["real", "mock"] as const) {
  test(`${mode} review requires an answer and confirmation, then reloads review and calendar`, async ({ page }) => {
    let advanced = false;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const next = new Date(Date.parse(`${today}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10);
    await page.route("**/api/reviews", (route) => route.fulfill({ json: [{ courseId: "calculus-101", topic: "导数", lastReviewed: advanced ? today : null, nextReview: advanced ? next : today, mastery: 5, evidence: advanced ? "答对 · saved.md" : "等待真实作答", status: advanced ? "upcoming" : "today" }] }));
    await page.route("**/api/reviews/due", (route) => route.fulfill({ json: [] }));
    await page.route("**/api/calendar?*", (route) => route.fulfill({ json: [{ id: "review-1", courseId: "calculus-101", courseTitle: "微积分基础", accent: "#27624B", date: advanced ? next : today, kind: "review", title: "复习：导数", status: "upcoming", detail: advanced ? "答对 · saved.md" : "等待真实作答" }] }));
    await page.route("**/api/practice-sessions**", async (route) => {
      const url = route.request().url();
      if (url.endsWith("/confirm")) {
        advanced = mode === "real";
        await route.fulfill({ json: { courseId: "calculus-101", mode, advanced, sessionFile: "saved.md" } });
      } else if (url.endsWith("/answer")) {
        await route.fulfill({ json: { feedback: { questionId: "q", isCorrect: true, score: 100, correctPart: "B. 瞬时变化", gap: "", evidence: "导数描述瞬时变化率。" } } });
      } else {
        expect(route.request().postDataJSON()).toEqual({ courseId: "calculus-101", topic: "导数", kind: "review-attempt" });
        await route.fulfill({ status: 201, json: { sessionId: "review-1", mode, question: { id: "q", question: "切线表示什么？", options: ["平均变化", "瞬时变化", "面积", "体积"], knowledgePoint: "导数" } } });
      }
    });
    await page.goto("/review");
    await page.getByRole("button", { name: "开始复习" }).click();
    await expect(page.getByRole("heading", { name: "切线表示什么？" })).toBeVisible();
    await expect(page.getByText(/正确答案：/)).toHaveCount(0);
    await page.getByRole("radio", { name: "B. 瞬时变化" }).check();
    await page.getByRole("button", { name: "提交回答" }).click();
    await expect(page.getByText("解析：导数描述瞬时变化率。")).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(0);
    await page.getByRole("button", { name: mode === "real" ? "确认保存并更新复习计划" : "保存演示作答（不推进复习）" }).click();
    await expect(page.getByText(mode === "real" ? "复习作答已保存，复习计划已更新。" : "Mock · 演示作答已保存，复习计划未推进。")).toBeVisible();
    await expect(page.getByRole("cell", { name: mode === "real" ? next : today, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("cell", { name: mode === "real" ? next : today, exact: true })).toBeVisible();
    await page.goto("/calendar");
    if (advanced && next.slice(0, 7) !== today.slice(0, 7)) await page.getByRole("button", { name: "下个月" }).click();
    await expect(page.getByText("复习：导数").first()).toBeVisible();
  });
}
