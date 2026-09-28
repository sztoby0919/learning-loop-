// @vitest-environment node

import { describe, expect, it } from "vitest";

import { parseReviewsMarkdown } from "./artifact-parser.js";
import { ArchiveProposalError, buildArchiveProposal } from "./archive-proposal.js";

describe("buildArchiveProposal", () => {
  it("records a single-choice attempt without retry wording", () => {
    const courseMarkdown = `---\nid: c\ntitle: 课程\nupdated: 2026-09-26\n---\n## 关键知识\n导数\n## 学习记录\n`;
    const files = buildArchiveProposal({ courseRoot: "C:/tmp/c", assessmentId: "test", courseMarkdown, reviewsMarkdown: null, diagnosis: { courseId: "c", weakPoints: [], remediationTasks: [], nextReviewDate: "2026-09-29", proposedChanges: { courseMarkdown: "", reviewsMarkdown: "", mistakesMarkdown: "", sessionMarkdown: "" } }, answers: [{ question: "导数表示什么？", answer: "A. 平均变化率", score: 0, gap: "选择了平均变化率", correctAnswer: "B. 瞬时变化率", explanation: "导数表示瞬时变化率。" }], today: "2026-09-26" });
    expect(files[2].after).toContain("选择：A. 平均变化率");
    expect(files[2].after).toContain("得分：0/100");
    expect(files[2].after).toContain("正确答案：B. 瞬时变化率");
    expect(files[2].after).toContain("解析：导数表示瞬时变化率。");
    expect(files[2].after).not.toContain("初次回答");
    expect(files[2].after).not.toContain("重新回答");
  });
  it("appends a review to the shipped demo table headed 主题 without replacing existing rows", () => {
    const courseMarkdown = `---\nid: calculus-101\ntitle: 微积分基础\nupdated: 2026-09-26\n---\n## 关键知识\n导数\n## 易错点\n暂无\n## 学习记录\n| 日期 | 学习内容 | 掌握度 | 遇到困难 | 下一步 |\n| --- | --- | --- | --- | --- |\n`;
    const reviewsMarkdown = `---\ncourseId: calculus-101\nupdated: 2026-09-26\n---\n| 主题 | 上次复习 | 下次复习 | 掌握度 | 证据 |\n|------|----------|----------|--------|------|\n| 极限定义 | 2026-09-25 | 2026-09-27 | 8 | 练习正确 |\n`;
    const files = buildArchiveProposal({ courseRoot: "C:/tmp/calculus-101", assessmentId: "test", courseMarkdown, reviewsMarkdown, diagnosis: { courseId: "calculus-101", weakPoints: [{ knowledgePoint: "导数", evidence: "未说明瞬时", severity: "medium" }], remediationTasks: ["复习导数"], nextReviewDate: "2026-09-29", proposedChanges: { courseMarkdown: "", reviewsMarkdown: "", mistakesMarkdown: "", sessionMarkdown: "" } }, answers: [], today: "2026-09-26" });
    expect(parseReviewsMarkdown(files[1].after, "reviews.md", "2026-09-26").items.map((item) => item.topic)).toEqual(["极限定义", "导数"]);
    expect(parseReviewsMarkdown(files[1].after, "reviews.md", "2026-09-26").items[1]).toMatchObject({ lastReviewed: null, nextReview: "2026-09-29", mastery: null });
    expect(files[1].after).toContain("| 主题 | 上次复习 | 下次复习 | 掌握度 | 证据 |");
  });
  it("inserts review rows inside the table when notes follow it", () => {
    const courseMarkdown = `---\nid: c\ntitle: 课程\naccent: "#27624B"\nupdated: 2026-09-25\n---\n## 课程概览\n概览\n## 学习路线\n### 第一阶段\n- [ ] 学习\n## 关键知识\n知识\n## 易错点\n暂无\n## 学习记录\n| 日期 | 学习内容 | 掌握度 1-10 | 遇到困难 | 下一步 |\n| --- | --- | ---: | --- | --- |\n`;
    const reviewsMarkdown = `---\ncourseId: c\nupdated: 2026-09-25\n---\n# 复习\n| 知识点 | 上次复习 | 下次复习 | 掌握度 1-10 | 复习证据 |\n| --- | --- | --- | ---: | --- |\n| 旧知识 | | | | |\n\n备注：保留这段说明。\n`;
    const files = buildArchiveProposal({ courseRoot: "C:/tmp/c", assessmentId: "test", courseMarkdown, reviewsMarkdown, diagnosis: { courseId: "c", weakPoints: [{ knowledgePoint: "新知识", evidence: "回答错误", severity: "high" }], remediationTasks: ["重做题"], nextReviewDate: "2026-09-28", proposedChanges: { courseMarkdown: "", reviewsMarkdown: "", mistakesMarkdown: "", sessionMarkdown: "" } }, answers: [], today: "2026-09-25" });
    expect(parseReviewsMarkdown(files[1].after, "reviews.md", "2026-09-25").items.map((item) => item.topic)).toEqual(["旧知识", "新知识"]);
    expect(files[1].after).toContain("备注：保留这段说明。");
  });

  it("rejects a diagnosis topic already present in the manual plan", () => {
    const courseMarkdown = "## 关键知识\n导数\n## 学习记录\n";
    const reviewsMarkdown = "---\ncourseId: c\nupdated: 2026-09-25\n---\n| 主题 | 上次复习 | 下次复习 | 掌握度 | 证据 |\n| --- | --- | --- | --- | --- |\n| 导数 | 2026-09-24 | 2026-09-27 | 8 | 手工复述 |\n";
    expect(() => buildArchiveProposal({ courseRoot: "C:/tmp/c", assessmentId: "test", courseMarkdown, reviewsMarkdown, diagnosis: { courseId: "c", weakPoints: [{ knowledgePoint: "导数", evidence: "本次作答错误", severity: "high" }], remediationTasks: [], nextReviewDate: "2026-09-28", proposedChanges: { courseMarkdown: "", reviewsMarkdown: "", mistakesMarkdown: "", sessionMarkdown: "" } }, answers: [], today: "2026-09-25" })).toThrow(ArchiveProposalError);
  });
});
