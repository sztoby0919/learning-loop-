// AI 服务封装
// 提供统一的 AI 功能接口，处理错误、重试、日志

import type { AiProvider } from "./ai-provider.js";
import { AiResponseFormatError } from "./openai-compatible-provider.js";
import { AI_TIMEOUT_MS, AiRequestError, aiTimeoutError, abortableDelay } from "./ai-request.js";
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
    this.timeoutMs = config.timeoutMs ?? AI_TIMEOUT_MS;
  }

  // 生成诊断题目
  async generateAssessmentQuestions(params: {
    courseId: string;
    topic: string;
    count?: number;
    difficulty?: string;
    context: string;
    instructions?: string;
  }): Promise<AssessmentQuestion[]> {
    let feedback = "";
    return this.withRetry(async (signal) => {
      try {
        return await this.provider.generateQuestions({
          courseId: params.courseId,
          topic: params.topic,
          count: params.count ?? 5,
          difficulty: params.difficulty ?? "medium",
          context: params.context,
          instructions: [params.instructions, feedback].filter(Boolean).join("\n"),
        }, signal);
      } catch (error) {
        if (error instanceof AiResponseFormatError) feedback = `上次输出未通过校验：${error.message}。请修正这些字段，返回完整、简洁的题目 JSON 数组。`;
        throw error;
      }
    });
  }

  // 提交答案并获取反馈
  async submitAnswer(params: {
    question: AssessmentQuestion;
    answer: string;
    context: string;
  }): Promise<AnswerFeedback> {
    return this.withRetry((signal) =>
      this.provider.submitAnswer({
        question: params.question,
        answer: params.answer,
        context: params.context,
      }, signal),
    );
  }

  // 生成诊断结果
  async generateDiagnosis(params: {
    courseId: string;
    answers: Array<{ question: AssessmentQuestion; answer: string; feedback: AnswerFeedback }>;
    learningRecords: LearningRecord[];
  }): Promise<DiagnosisResult> {
    return this.withRetry((signal) =>
      this.provider.generateDiagnosis({
        courseId: params.courseId,
        answers: params.answers,
        learningRecords: params.learningRecords,
      }, signal),
    );
  }

  // 生成费曼讲解
  async generateFeynmanExplanation(params: {
    concept: string;
    level?: string;
    context: string;
  }): Promise<{ explanation: string; analogy: string; examples: string[] }> {
    return this.withRetry((signal) =>
      this.provider.generateFeynmanExplanation({
        concept: params.concept,
        level: params.level ?? "intermediate",
        context: params.context,
      }, signal),
    );
  }

  // 生成补救任务
  async generateRemediationTasks(params: {
    weakPoints: DiagnosisResult["weakPoints"];
    currentLevel: string;
  }): Promise<string[]> {
    return this.withRetry((signal) =>
      this.provider.generateRemediationTasks({
        weakPoints: params.weakPoints,
        currentLevel: params.currentLevel,
      }, signal),
    );
  }

  // 带重试的包装器
  private async withRetry<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { const error = aiTimeoutError(); controller.abort(error); reject(error); }, this.timeoutMs);
    });
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        controller.signal.throwIfAborted();
        try { return await fn(controller.signal); }
        catch (cause) {
          const error = cause && typeof cause === "object" && "name" in cause && cause.name === "TimeoutError" ? aiTimeoutError() : cause;
          if (controller.signal.aborted) throw controller.signal.reason;
          const retryable = error instanceof AiResponseFormatError ? error.retryable : error instanceof AiRequestError && error.retryable;
          if (!retryable || attempt >= this.maxRetries) throw error;
          await abortableDelay(1000, controller.signal);
        }
      }
    };
    try { return await Promise.race([run(), timeout]); }
    finally { clearTimeout(timer!); }
  }

  getRunRecords(): AiRunRecord[] {
    return [...this.runRecords];
  }
}
