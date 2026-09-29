import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewPage } from "./ReviewPage.js";

it("shows an automatic due review when reviews.md has no handwritten topic", () => {
  render(<ReviewPage courses={[{ id: "course-1", title: "数学", accent: "#27624B", updated: "2026-09-26", status: "ready", progress: 0, completedTasks: 0, totalTasks: 1, currentStage: null, nextTask: null, mastery: null }]} reviews={[]} scheduledReviews={[{ courseId: "course-1", courseTitle: "数学", accent: "#27624B", topic: "极限定义", stage: "全课程", recordDate: "2026-09-25", reviewNumber: 0, nextReviewDate: "2026-09-26", daysUntilReview: 0, mastery: null }]} />);
  expect(screen.getByText("极限定义")).toBeInTheDocument();
  expect(screen.getAllByText("今日复习")).toHaveLength(2);
  expect(screen.getByText(/尚无复习证据/)).toBeInTheDocument();
});

afterEach(() => vi.unstubAllGlobals());

it.each(["real", "mock"] as const)("completes a %s review through single-answer feedback and explicit confirmation", async (mode) => {
  const onSaved = vi.fn();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/answer")) return new Response(JSON.stringify({ feedback: { questionId: "q", isCorrect: true, score: 100, correctPart: "B. 瞬时变化", gap: "", evidence: "切线对应瞬时变化率。" } }));
    if (url.endsWith("/confirm")) return new Response(JSON.stringify({ courseId: "calculus-101", mode, advanced: mode === "real", sessionFile: "saved.md" }));
    expect(JSON.parse(String(init?.body))).toEqual({ courseId: "calculus-101", topic: "导数", kind: "review-attempt" });
    return new Response(JSON.stringify({ sessionId: "review-1", mode, question: { id: "q", question: "切线表示什么？", options: ["平均变化", "瞬时变化", "面积", "体积"], knowledgePoint: "导数" } }));
  });
  vi.stubGlobal("fetch", fetcher);
  render(<ReviewPage courses={[]} reviews={[{ courseId: "calculus-101", topic: "导数", lastReviewed: "2026-09-27", nextReview: "2026-09-28", mastery: 5, evidence: "", status: "today" }]} onSaved={onSaved} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "开始复习" }));
  await screen.findByRole("heading", { name: "切线表示什么？" });
  expect(screen.queryByText(/解析：/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("radio", { name: "B. 瞬时变化" }));
  await user.click(screen.getByRole("button", { name: "提交回答" }));
  await screen.findByText("解析：切线对应瞬时变化率。");
  expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  expect(onSaved).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: mode === "real" ? "确认保存并更新复习计划" : "保存演示作答（不推进复习）" }));
  expect(await screen.findByText(mode === "real" ? "复习作答已保存，复习计划已更新。" : "Mock · 演示作答已保存，复习计划未推进。" )).toBeInTheDocument();
  expect(onSaved).toHaveBeenCalledOnce();
});

it("shows a confirmation conflict while keeping feedback visible", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/confirm") ? { error: "文件冲突：复习计划已被修改" } : url.endsWith("/answer") ? { feedback: { questionId: "q", isCorrect: false, score: 0, correctPart: "B. 瞬时变化", gap: "", evidence: "解释" } } : { sessionId: "review", mode: "real", question: { id: "q", question: "题目", options: ["平均变化", "瞬时变化", "面积", "体积"], knowledgePoint: "导数" } }), { status: url.endsWith("/confirm") ? 409 : 200 })));
  render(<ReviewPage courses={[]} reviews={[{ courseId: "calculus-101", topic: "导数", lastReviewed: null, nextReview: "2026-09-28", mastery: null, evidence: "", status: "today" }]} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "开始复习" }));
  await user.click(await screen.findByRole("radio", { name: "A. 平均变化" }));
  await user.click(screen.getByRole("button", { name: "提交回答" }));
  await user.click(await screen.findByRole("button", { name: "确认保存并更新复习计划" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("文件冲突");
  expect(screen.getByRole("alert")).toHaveTextContent("请刷新页面后重新开始复习");
  expect(screen.getByText("解析：解释")).toBeInTheDocument();
  expect(screen.queryByRole("radio")).not.toBeInTheDocument();
});

it("preserves a saved automatic review when refreshed data moves it into the handwritten list", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/confirm") ? { courseId: "calculus-101", mode: "real", advanced: true, sessionFile: "saved.md" } : url.endsWith("/answer") ? { feedback: { questionId: "q", isCorrect: true, score: 100, correctPart: "B. 瞬时变化", gap: "", evidence: "解释" } } : { sessionId: "review", mode: "real", question: { id: "q", question: "题目", options: ["平均变化", "瞬时变化", "面积", "体积"], knowledgePoint: "导数" } }))));
  const other = { courseId: "calculus-101", topic: "积分", lastReviewed: null, nextReview: "2026-09-28", mastery: null, evidence: "", status: "today" as const };
  const automatic = { courseId: "calculus-101", courseTitle: "微积分", accent: "#27624B", topic: "导数", stage: "全课程", recordDate: "2026-09-27", reviewNumber: 0, nextReviewDate: "2026-09-28", daysUntilReview: 0, mastery: null };
  const { rerender } = render(<ReviewPage courses={[]} reviews={[other]} scheduledReviews={[automatic]} />);
  const user = userEvent.setup();
  await user.click(screen.getAllByRole("button", { name: "开始复习" })[1]);
  await user.click(await screen.findByRole("radio", { name: "B. 瞬时变化" }));
  await user.click(screen.getByRole("button", { name: "提交回答" }));
  await user.click(await screen.findByRole("button", { name: "确认保存并更新复习计划" }));
  await screen.findByText("复习作答已保存，复习计划已更新。");
  rerender(<ReviewPage courses={[]} reviews={[{ ...other, topic: "导数", nextReview: "2026-10-01" }, other]} scheduledReviews={[]} />);
  expect(screen.getByText("复习作答已保存，复习计划已更新。")).toBeInTheDocument();
});
