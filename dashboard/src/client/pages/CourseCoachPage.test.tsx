import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CourseDetail } from "../../shared/course.js";
import { CourseCoachPage } from "./CourseCoachPage.js";

const course = {
  id: "calculus-101", title: "微积分基础", keyPointsMarkdown: "导数是瞬时变化率。", records: [],
} as unknown as CourseDetail;

afterEach(() => vi.unstubAllGlobals());

describe("CourseCoachPage", () => {
  it("retries a failed report using the same assessment without answering again", async () => {
    let reports = 0;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url.endsWith("/proposal") && ++reports === 1) return { ok: false, status: 502, json: async () => ({ error: "模型返回的数据格式不正确：JSON" }) };
      return { ok: true, json: async () => url.endsWith("/proposal")
        ? { diagnosis: { courseId: course.id, weakPoints: [], remediationTasks: [], nextReviewDate: "2027-01-01" }, files: [{ name: "course.md", before: "旧内容", after: "新内容" }] }
        : url.endsWith("/answers") ? { feedback: { questionId: "q1", isCorrect: true, score: 100, correctPart: "B", gap: "", evidence: "瞬时变化率" }, nextQuestion: null, answered: 1 }
        : { assessmentId: "assessment-retry", total: 1, question: { id: "q1", question: "导数表示什么？", options: ["平均变化率", "瞬时变化率", "函数值", "积分面积"], knowledgePoint: "导数" } } };
    });
    render(<CourseCoachPage course={course} onComplete={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "开始诊断" }));
    await user.click(await screen.findByRole("radio", { name: "B. 瞬时变化率" }));
    await user.click(screen.getByRole("button", { name: "提交回答" }));
    await user.click(await screen.findByRole("button", { name: "查看诊断报告" }));
    await user.click(await screen.findByRole("button", { name: "重新生成报告" }));
    expect(await screen.findByText("新内容")).toBeInTheDocument();
    expect(calls.filter((url) => url.endsWith("/answers"))).toHaveLength(1);
    expect(calls.filter((url) => url === "/api/ai/assessments")).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith("/proposal"))).toEqual(Array(2).fill("/api/ai/assessments/assessment-retry/proposal"));
  });
  it("submits one selected option, shows its explanation without retry, and previews file changes", async () => {
    const calls: string[] = [];
    const submissions: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith("/answers")) submissions.push(JSON.parse(init?.body as string));
      const body = url.endsWith("/apply") ? { success: true }
        : url.endsWith("/proposal") ? { diagnosis: { courseId: "calculus-101", weakPoints: [], remediationTasks: [], nextReviewDate: "2026-09-28" }, files: [{ name: "course.md", before: "旧内容", after: "新内容" }] }
        : url.endsWith("/answers") ? { feedback: { questionId: "q1", score: 0, gap: "你选择了 A. 平均变化率", correctPart: "B. 瞬时变化率", evidence: "导数描述某一点的瞬时变化率。", isCorrect: false }, nextQuestion: null, completed: true, answered: 1, total: 1 }
        : { assessmentId: "assessment-1", total: 1, question: { id: "q1", question: "导数表示什么？", options: ["平均变化率", "瞬时变化率", "函数值", "积分面积"], knowledgePoint: "导数" } };
      return { ok: true, json: async () => body };
    }));
    render(<CourseCoachPage course={course} onComplete={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "开始诊断" }));
    expect(await screen.findByRole("radio", { name: "A. 平均变化率" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交回答" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "A. 平均变化率" }));
    await user.click(screen.getByRole("button", { name: "提交回答" }));
    expect(submissions).toEqual([{ questionId: "q1", answer: "A" }]);
    expect(await screen.findByText(/解析：导数描述某一点的瞬时变化率/)).toBeInTheDocument();
    expect(screen.getByText(/正确答案：B\. 瞬时变化率/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新作答" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看诊断报告" }));
    expect(await screen.findByText("旧内容")).toBeInTheDocument();
    expect(screen.getByText("新内容")).toBeInTheDocument();
    expect(calls).toContain("/api/ai/assessments/assessment-1/proposal");
  });
});
