// AI 服务封装
// 提供统一的 AI 功能接口，处理错误、重试、日志

import type { AiProvider } from "./ai-provider.js";
import type {
  AiConfig,
  AiRunRecord,
  AssessmentQuestion,
  AnswerFeedback,
  DiagnosisResult,
  LearningRecord,
} from "./ai-types.js";

export interface AiServiceConfig {
  provider: AiProvider;
  maxRetries?: number;
  timeoutMs?: number;
}

export class AiService {
  private provider: AiProvider;
  private maxRetries: number;
  private timeoutMs: number;
  private runRecords: AiRunRecord[] = [];

  constructor(config: AiServiceConfig) {
    this.provider = config.provider;
    this.maxRetries = config.maxRetries ?? 1;
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  // 生成诊断题目
  async generateAssessmentQuestions(params: {
    courseId: string;
    topic: string;
    count?: number;
    difficulty?: string;
    context: string;
  }): Promise<AssessmentQuestion[]> {
    return this.withRetry(() =>
      this.provider.generateQuestions({
        courseId: params.courseId,
        topic: params.topic,
        count: params.count ?? 5,
        difficulty: params.difficulty ?? "medium",
        context: params.context,
      }),
    );
  }

  // 提交答案并获取反馈
  async submitAnswer(params: {
    question: AssessmentQuestion;
    answer: string;
    context: string;
  }): Promise<AnswerFeedback> {
    return this.withRetry(() =>
      this.provider.submitAnswer({
        question: params.question,
        answer: params.answer,
        context: params.context,
      }),
    );
  }

  // 生成诊断结果
  async generateDiagnosis(params: {
    courseId: string;
    answers: Array<{ question: AssessmentQuestion; answer: string; feedback: AnswerFeedback }>;
    learningRecords: LearningRecord[];
  }): Promise<DiagnosisResult> {
    return this.withRetry(() =>
      this.provider.generateDiagnosis({
        courseId: params.courseId,
        answers: params.answers,
        learningRecords: params.learningRecords,
      }),
    );
  }

  // 生成费曼讲解
  async generateFeynmanExplanation(params: {
    concept: string;
    level?: string;
    context: string;
  }): Promise<{ explanation: string; analogy: string; examples: string[] }> {
    return this.withRetry(() =>
      this.provider.generateFeynmanExplanation({
        concept: params.concept,
        level: params.level ?? "intermediate",
        context: params.context,
      }),
    );
  }

  // 生成补救任务
  async generateRemediationTasks(params: {
    weakPoints: DiagnosisResult["weakPoints"];
    currentLevel: string;
  }): Promise<string[]> {
    return this.withRetry(() =>
      this.provider.generateRemediationTasks({
        weakPoints: params.weakPoints,
        currentLevel: params.currentLevel,
      }),
    );
  }

  // 带重试的包装器
  private async withRetry<T>(fn: () => Promise<T>, attempt = 0): Promise<T> {
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("请求超时")), this.timeoutMs),
      );
      return await Promise.race([fn(), timeoutPromise]);
    } catch (error) {
      if (attempt < this.maxRetries) {
        await this.delay(1000 * (attempt + 1));
        return this.withRetry(fn, attempt + 1);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getRunRecords(): AiRunRecord[] {
    return [...this.runRecords];
  }
}
