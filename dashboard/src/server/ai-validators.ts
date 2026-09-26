// Zod 校验模式
// 用于验证 AI 返回的结构化输出

import { z } from "zod";

// 诊断题目校验
export const AssessmentQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.string().trim().min(1)).length(4).refine((options) => new Set(options).size === 4, "选项不能重复"),
  answer: z.enum(["A", "B", "C", "D"]),
  explanation: z.string().min(1),
  knowledgePoint: z.string().min(1),
});

export const AssessmentQuestionsSchema = z.array(AssessmentQuestionSchema).min(1).max(10);

// 答案反馈校验
export const AnswerFeedbackSchema = z.object({
  questionId: z.string(),
  isCorrect: z.boolean(),
  score: z.number().min(0).max(100),
  correctPart: z.string(),
  gap: z.string(),
  evidence: z.string(),
  feynmanExplanation: z.string().optional(),
});

// 诊断结果校验
export const DiagnosisResultSchema = z.object({
  courseId: z.string().min(1),
  weakPoints: z.array(
    z.object({
      knowledgePoint: z.string().min(1),
      evidence: z.string().min(1),
      severity: z.enum(["high", "medium", "low"]),
    })
  ),
  remediationTasks: z.array(z.string()),
  nextReviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  }, "无效复习日期"),
  proposedChanges: z.object({
    courseMarkdown: z.string(),
    reviewsMarkdown: z.string(),
    mistakesMarkdown: z.string(),
    sessionMarkdown: z.string(),
  }),
});

// 费曼讲解校验
export const FeynmanExplanationSchema = z.object({
  explanation: z.string(),
  analogy: z.string(),
  examples: z.array(z.string()),
});

// 补救任务校验
export const RemediationTasksSchema = z.array(z.string());

// 校验函数
export function validateAssessmentQuestions(data: unknown) {
  return AssessmentQuestionsSchema.safeParse(data);
}

export function validateAnswerFeedback(data: unknown) {
  return AnswerFeedbackSchema.safeParse(data);
}

export function validateDiagnosisResult(data: unknown) {
  return DiagnosisResultSchema.safeParse(data);
}

export function validateFeynmanExplanation(data: unknown) {
  return FeynmanExplanationSchema.safeParse(data);
}

export function validateRemediationTasks(data: unknown) {
  return RemediationTasksSchema.safeParse(data);
}
