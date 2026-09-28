import { describe, expect, it } from "vitest";

import { parseReviewsMarkdown } from "./artifact-parser.js";
import { prepareReviewUpdate, ReviewUpdateConflict } from "./review-completion.js";

const plan = `---
courseId: calculus-101
updated: 2026-09-26
---
# 复习计划

| 主题 | 上次复习 | 下次复习 | 掌握度 | 证据 |
|------|----------|----------|--------|------|
| 极限定义 | 2026-09-20 | 2026-09-27 | 8 | 手写证明 |
| 导数概念 |  | 2026-09-27 |  | 诊断发现弱点 |

备注：请保留这段手写说明。
`;

const params = { courseId: "calculus-101", topic: "导数概念", date: "2026-09-28", isCorrect: false, priorConsecutiveCorrectReviews: 0, evidence: "选择 B，得分 0/100" };

describe("prepareReviewUpdate", () => {
  it("resets a wrong answer to tomorrow while preserving other manual content and blank mastery", () => {
    const updated = prepareReviewUpdate(plan, params);
    expect(updated).toContain("| 极限定义 | 2026-09-20 | 2026-09-27 | 8 | 手写证明 |");
    expect(updated).toContain("备注：请保留这段手写说明。");
    expect(updated).toContain("| 导数概念 | 2026-09-28 | 2026-09-29 |  | 选择 B，得分 0/100 |");
    expect(parseReviewsMarkdown(updated, "reviews.md", "2026-09-28").items[1]).toMatchObject({ lastReviewed: "2026-09-28", nextReview: "2026-09-29", mastery: null });
  });

  it("advances correct answers from actual consecutive review count", () => {
    const dates = ["2026-10-01", "2026-10-05", "2026-10-28", "2026-10-28"];
    for (const [priorConsecutiveCorrectReviews, nextDate] of dates.entries()) {
      const updated = prepareReviewUpdate(plan, { ...params, isCorrect: true, priorConsecutiveCorrectReviews, evidence: "选择 A，得分 100/100" });
      expect(parseReviewsMarkdown(updated, "reviews.md", "2026-09-28").items[1]).toMatchObject({ nextReview: nextDate, mastery: null, evidence: "选择 A，得分 100/100" });
    }
  });

  it("creates a parseable table when reviews.md is missing", () => {
    const updated = prepareReviewUpdate(null, params);
    expect(parseReviewsMarkdown(updated, "reviews.md", "2026-09-28")).toMatchObject({ courseId: "calculus-101", items: [{ topic: "导数概念", nextReview: "2026-09-29", mastery: null }] });
  });

  it("rejects duplicate topic rows without choosing one", () => {
    const duplicate = plan.replace("\n\n备注：", "\n| 导数概念 | | 2026-10-01 | 3 | 手写复习 |\n\n备注：");
    expect(() => prepareReviewUpdate(duplicate, params)).toThrow(ReviewUpdateConflict);
  });

  it("detects duplicate rows when GFM omits the outer pipes", () => {
    const duplicate = plan.replace("| 导数概念 |  | 2026-09-27 |  | 诊断发现弱点 |", "导数概念 |  | 2026-09-27 |  | 诊断发现弱点\n导数概念 | 2026-09-24 | 2026-10-01 | 3 | 手写复习");
    expect(() => prepareReviewUpdate(duplicate, params)).toThrow(ReviewUpdateConflict);
  });

  it("updates the actual parsed table instead of a fenced example", () => {
    const fenced = plan.replace("# 复习计划", "# 复习计划\n\n```md\n| 主题 | 上次复习 | 下次复习 | 掌握度 | 证据 |\n| --- | --- | --- | --- | --- |\n| 导数概念 | | 2026-10-01 | | 示例 |\n```");
    const updated = prepareReviewUpdate(fenced, params);
    expect(updated).toContain("| 导数概念 | | 2026-10-01 | | 示例 |");
    expect(parseReviewsMarkdown(updated, "reviews.md", params.date).items.find((item) => item.topic === "导数概念")).toMatchObject({ lastReviewed: params.date, nextReview: "2026-09-29" });
  });

  it("rejects a fenced example when no real table exists", () => {
    const fenced = plan.replace(/\| 主题 \|[\s\S]*?\n\n备注：/, "```md\n| 主题 | 上次复习 | 下次复习 | 掌握度 | 证据 |\n| --- | --- | --- | --- | --- |\n| 导数概念 | | 2026-10-01 | | 示例 |\n```\n\n备注：");
    expect(() => prepareReviewUpdate(fenced, params)).toThrow(ReviewUpdateConflict);
  });

  it("rejects malformed topic rows and malformed tables", () => {
    const shortRow = plan.replace("| 导数概念 |  | 2026-09-27 |  | 诊断发现弱点 |", "| 导数概念 | 2026-09-27 | 缺列 |");
    expect(() => prepareReviewUpdate(shortRow, params)).toThrow(ReviewUpdateConflict);
    expect(() => prepareReviewUpdate(plan.replace("|------|----------|----------|--------|------|", "不是分隔行"), params)).toThrow(ReviewUpdateConflict);
    expect(() => prepareReviewUpdate("# 手写复习计划\n", params)).toThrow(ReviewUpdateConflict);
  });

  it("rejects a review plan for another course", () => {
    expect(() => prepareReviewUpdate(plan.replace("courseId: calculus-101", "courseId: another-course"), params)).toThrow(ReviewUpdateConflict);
  });

  it("rejects malformed existing target dates or mastery", () => {
    expect(() => prepareReviewUpdate(plan.replace("| 导数概念 |  | 2026-09-27 |  |", "| 导数概念 | bad | 2026-09-27 |  |"), params)).toThrow(ReviewUpdateConflict);
    expect(() => prepareReviewUpdate(plan.replace("| 导数概念 |  | 2026-09-27 |  |", "| 导数概念 |  | 2026-09-27 | 11 |"), params)).toThrow(ReviewUpdateConflict);
  });

  it("rejects invalid raw YAML dates before parsing can normalize them", () => {
    expect(() => prepareReviewUpdate(plan.replace("updated: 2026-09-26", "updated: 2026-02-30"), params)).toThrow(ReviewUpdateConflict);
    expect(() => prepareReviewUpdate(plan.replace("updated: 2026-09-26", "updated: 2026-13-01"), params)).toThrow(ReviewUpdateConflict);
  });

  it("accepts an inline YAML comment on the date and keeps the annotation", () => {
    const annotated = plan.replace("updated: 2026-09-26", "updated: 2026-09-26 # audited");
    const updated = prepareReviewUpdate(annotated, params);
    expect(updated).toContain("updated: 2026-09-28 # audited");
    expect(parseReviewsMarkdown(updated, "reviews.md", params.date).updated).toBe(params.date);
  });

  it("distinguishes a quoted hash in the scalar from an actual YAML comment", () => {
    const annotated = plan.replace("updated: 2026-09-26", 'updated: "2026-09-26" # audited');
    expect(prepareReviewUpdate(annotated, params)).toContain('updated: "2026-09-28" # audited');
    const scalarWithHash = plan.replace("updated: 2026-09-26", 'updated: "2026-09-26 # audited"');
    expect(() => prepareReviewUpdate(scalarWithHash, params)).toThrow(ReviewUpdateConflict);
  });

  it("rejects a next date outside the supported YYYY-MM-DD range", () => {
    expect(() => prepareReviewUpdate(null, { ...params, date: "9999-12-31" })).toThrow(ReviewUpdateConflict);
  });
});
