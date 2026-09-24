// AI Provider 接口和实现
// 支持 LongCat 2.0 和 Mock 两种模式

import type {
  AiConfig,
  AiRunRecord,
  AssessmentQuestion,
  AnswerFeedback,
  DiagnosisResult,
  LearningRecord,
} from "./ai-types.js";
import { LongCatAiProvider } from "./longcat-provider.js";

// Provider 接口
export interface AiProvider {
  generateQuestions(params: {
    courseId: string;
    topic: string;
    count: number;
    difficulty: string;
    context: string;
  }): Promise<AssessmentQuestion[]>;

  submitAnswer(params: {
    question: AssessmentQuestion;
    answer: string;
    context: string;
  }): Promise<AnswerFeedback>;

  generateDiagnosis(params: {
    courseId: string;
    answers: Array<{ question: AssessmentQuestion; answer: string; feedback: AnswerFeedback }>;
    learningRecords: LearningRecord[];
  }): Promise<DiagnosisResult>;

  generateFeynmanExplanation(params: {
    concept: string;
    level: string;
    context: string;
  }): Promise<{ explanation: string; analogy: string; examples: string[] }>;

  generateRemediationTasks(params: {
    weakPoints: DiagnosisResult["weakPoints"];
    currentLevel: string;
  }): Promise<string[]>;
}

// Mock 实现 - 用于开发和测试
export class MockAiProvider implements AiProvider {
  private runRecords: AiRunRecord[] = [];
  private idCounter = 0;

  constructor(private config: AiConfig) {}

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private recordRun(params: {
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    inputSource: string;
    success: boolean;
    error?: string;
  }): void {
    this.runRecords.push({
      id: `run-${++this.idCounter}`,
      timestamp: new Date().toISOString(),
      model: this.config.model,
      ...params,
    });
  }

  async generateQuestions(params: {
    courseId: string;
    topic: string;
    count: number;
    difficulty: string;
    context: string;
  }): Promise<AssessmentQuestion[]> {
    const start = Date.now();
    await this.delay(300);

    // 基于主题生成模拟问题
    const questions: AssessmentQuestion[] = Array.from({ length: params.count }, (_, i) => ({
      id: `q-${params.courseId}-${Date.now()}-${i}`,
      question: `关于"${params.topic}"的第 ${i + 1} 道诊断题（难度：${params.difficulty}）`,
      options: ["选项 A", "选项 B", "选项 C", "选项 D"],
      answer: "选项 A",
      explanation: `这道题考察的是"${params.topic}"中的核心概念。`,
      knowledgePoint: `${params.topic} - 知识点 ${i + 1}`,
    }));

    this.recordRun({
      promptTokens: 50 + params.context.length / 4,
      completionTokens: 200,
      latencyMs: Date.now() - start,
      inputSource: `generateQuestions:${params.courseId}`,
      success: true,
    });

    return questions;
  }

  async submitAnswer(params: {
    question: AssessmentQuestion;
    answer: string;
    context: string;
  }): Promise<AnswerFeedback> {
    const start = Date.now();
    await this.delay(200);

    const isCorrect = params.answer === params.question.answer;
    const score = isCorrect ? 90 + Math.floor(Math.random() * 10) : 20 + Math.floor(Math.random() * 40);

    const feedback: AnswerFeedback = {
      questionId: params.question.id,
      isCorrect,
      score,
      correctPart: isCorrect ? "回答完全正确" : "部分理解有偏差",
      gap: isCorrect ? "无明显缺口" : `对"${params.question.knowledgePoint}"的理解需要加强`,
      evidence: `作答"${params.answer}"，正确答案为"${params.question.answer}"`,
      feynmanExplanation: isCorrect
        ? undefined
        : `让我用简单的方式解释"${params.question.knowledgePoint}"：这就像...`,
    };

    this.recordRun({
      promptTokens: 80 + params.context.length / 4,
      completionTokens: 100,
      latencyMs: Date.now() - start,
      inputSource: `submitAnswer:${params.question.id}`,
      success: true,
    });

    return feedback;
  }

  async generateDiagnosis(params: {
    courseId: string;
    answers: Array<{ question: AssessmentQuestion; answer: string; feedback: AnswerFeedback }>;
    learningRecords: LearningRecord[];
  }): Promise<DiagnosisResult> {
    const start = Date.now();
    await this.delay(400);

    const incorrectAnswers = params.answers.filter((a) => !a.feedback.isCorrect);
    const weakPoints = incorrectAnswers.map((a) => ({
      knowledgePoint: a.question.knowledgePoint,
      evidence: a.feedback.evidence,
      severity: (a.feedback.score < 50 ? "high" : a.feedback.score < 80 ? "medium" : "low") as "high" | "medium" | "low",
    }));

    // 去重
    const uniqueWeakPoints = weakPoints.filter(
      (point, index, self) => self.findIndex((p) => p.knowledgePoint === point.knowledgePoint) === index,
    );

    const diagnosis: DiagnosisResult = {
      courseId: params.courseId,
      weakPoints: uniqueWeakPoints,
      remediationTasks: uniqueWeakPoints.map((p) => `复习"${p.knowledgePoint}"，完成相关练习`),
      nextReviewDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      proposedChanges: {
        courseMarkdown: `<!-- AI 建议更新：新增薄弱点记录 -->`,
        reviewsMarkdown: `<!-- AI 建议更新：新增复习计划 -->`,
        mistakesMarkdown: `<!-- AI 建议更新：新增易错点 -->`,
        sessionMarkdown: `<!-- AI 诊断会话记录 -->`,
      },
    };

    this.recordRun({
      promptTokens: 200 + params.answers.length * 50,
      completionTokens: 500,
      latencyMs: Date.now() - start,
      inputSource: `generateDiagnosis:${params.courseId}`,
      success: true,
    });

    return diagnosis;
  }

  async generateFeynmanExplanation(params: {
    concept: string;
    level: string;
    context: string;
  }): Promise<{ explanation: string; analogy: string; examples: string[] }> {
    const start = Date.now();
    await this.delay(250);

    const result = {
      explanation: `"${params.concept}"的核心思想是...（用简单语言解释）`,
      analogy: `这就像日常生活中的...`,
      examples: ["例子1：...", "例子2：..."],
    };

    this.recordRun({
      promptTokens: 60 + params.context.length / 4,
      completionTokens: 150,
      latencyMs: Date.now() - start,
      inputSource: `generateFeynmanExplanation:${params.concept}`,
      success: true,
    });

    return result;
  }

  async generateRemediationTasks(params): Promise<string[]> {
    const start = Date.now();
    await this.delay(200);

    const tasks = params.weakPoints.map(
      (p, i) => `任务 ${i + 1}：针对"${p.knowledgePoint}"进行专项练习（证据：${p.evidence}）`,
    );

    this.recordRun({
      promptTokens: 100 + params.weakPoints.length * 30,
      completionTokens: 200,
      latencyMs: Date.now() - start,
      inputSource: "generateRemediationTasks",
      success: true,
    });

    return tasks;
  }

  getRunRecords(): AiRunRecord[] {
    return [...this.runRecords];
  }

  clearRunRecords(): void {
    this.runRecords = [];
  }
}

// 工厂函数 - 根据配置创建 Provider
export function createAiProvider(config: AiConfig): AiProvider {
  // 如果配置了 API Key，使用 LongCat
  if (config.apiKey && config.apiKey !== "") {
    return new LongCatAiProvider(config);
  }
  // 否则使用 Mock
  return new MockAiProvider(config);
}
