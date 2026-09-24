// Mock AI Provider 测试
import { describe, it, expect } from "vitest";
import { MockAiProvider } from "./ai-provider.js";
import type { AiConfig } from "./ai-types.js";

const testConfig: AiConfig = {
  baseUrl: "https://test.example.com",
  apiKey: "<REDACTED>
  model: "test-model",
  maxTokens: 1000,
  temperature: 0.5,
};

describe("MockAiProvider", () => {
  it("应该生成指定数量的诊断题目", async () => {
    const provider = new MockAiProvider(testConfig);
    const questions = await provider.generateQuestions({
      courseId: "test-course",
      topic: "微积分",
      count: 5,
      difficulty: "medium",
      context: "测试上下文",
    });

    expect(questions).toHaveLength(5);
    expect(questions[0]).toHaveProperty("id");
    expect(questions[0]).toHaveProperty("question");
    expect(questions[0]).toHaveProperty("options");
    expect(questions[0]).toHaveProperty("knowledgePoint");
  });

  it("应该正确判断答案并返回反馈", async () => {
    const provider = new MockAiProvider(testConfig);
    const questions = await provider.generateQuestions({
      courseId: "test-course",
      topic: "微积分",
      count: 1,
      difficulty: "easy",
      context: "测试上下文",
    });

    const feedback = await provider.submitAnswer({
      question: questions[0],
      answer: questions[0].answer, // 正确答案
      context: "测试上下文",
    });

    expect(feedback.isCorrect).toBe(true);
    expect(feedback.score).toBeGreaterThanOrEqual(90);
    expect(feedback).toHaveProperty("evidence");
  });

  it("应该生成诊断结果", async () => {
    const provider = new MockAiProvider(testConfig);
    const questions = await provider.generateQuestions({
      courseId: "test-course",
      topic: "线性代数",
      count: 3,
      difficulty: "medium",
      context: "测试上下文",
    });

    const answers = questions.map((q) => ({
      question: q,
      answer: q.answer,
      feedback: {
        questionId: q.id,
        isCorrect: true,
        score: 95,
        correctPart: "正确",
        gap: "无",
        evidence: "测试证据",
      },
    }));

    const diagnosis = await provider.generateDiagnosis({
      courseId: "test-course",
      answers,
      learningRecords: [],
    });

    expect(diagnosis).toHaveProperty("courseId");
    expect(diagnosis).toHaveProperty("weakPoints");
    expect(diagnosis).toHaveProperty("remediationTasks");
    expect(diagnosis).toHaveProperty("nextReviewDate");
    expect(diagnosis).toHaveProperty("proposedChanges");
  });

  it("应该记录运行日志", async () => {
    const provider = new MockAiProvider(testConfig);
    await provider.generateQuestions({
      courseId: "test-course",
      topic: "测试",
      count: 1,
      difficulty: "easy",
      context: "测试上下文",
    });

    const records = provider.getRunRecords();
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]).toHaveProperty("model");
    expect(records[0]).toHaveProperty("latencyMs");
    expect(records[0].success).toBe(true);
  });

  it("应该生成费曼讲解", async () => {
    const provider = new MockAiProvider(testConfig);
    const result = await provider.generateFeynmanExplanation({
      concept: "导数",
      level: "beginner",
      context: "测试上下文",
    });

    expect(result).toHaveProperty("explanation");
    expect(result).toHaveProperty("analogy");
    expect(result).toHaveProperty("examples");
    expect(result.examples.length).toBeGreaterThan(0);
  });
});
