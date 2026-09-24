// Zod 校验模式
// 用于验证 AI 返回的结构化输出

import { z } from "zod";

// 诊断题目校验
export const AssessmentQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  answer: z.string(),
  explanation: z.string(),
  knowledgePoint: z.string(),
});

export const AssessmentQuestionsSchema = z.array(AssessmentQuestionSchema);

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
  courseId: z.string(),
  weakPoints: z.array(
    z.object({
      knowledgePoint: z.string(),
      evidence: z.string(),
      severity: z.enum(["high", "medium", "low"]),
    })
  ),
  remediationTasks: z.array(z.string()),
  nextReviewDate: z.string(),
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
