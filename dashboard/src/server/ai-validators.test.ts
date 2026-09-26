// @vitest-environment node

import { describe, expect, it } from "vitest";

import { validateAssessmentQuestions } from "./ai-validators.js";

const question = { id: "q1", question: "导数表示什么？", options: ["平均变化率", "瞬时变化率", "函数值", "积分面积"], answer: "B", explanation: "导数是瞬时变化率。", knowledgePoint: "导数" };

describe("assessment question validation", () => {
  it("requires four distinct choices and a single A-D answer key", () => {
    expect(validateAssessmentQuestions([question]).success).toBe(true);
    expect(validateAssessmentQuestions([{ ...question, options: question.options.slice(0, 3) }]).success).toBe(false);
    expect(validateAssessmentQuestions([{ ...question, options: ["相同", "相同", "函数值", "积分面积"] }]).success).toBe(false);
    expect(validateAssessmentQuestions([{ ...question, answer: "瞬时变化率" }]).success).toBe(false);
  });
});
