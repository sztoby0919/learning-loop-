// LongCat 2.0 API Provider 实现
// 使用 OpenAI 兼容协议调用 LongCat 2.0 模型

import type {
  AiConfig,
  AiRunRecord,
  AssessmentQuestion,
  AnswerFeedback,
  DiagnosisResult,
  LearningRecord,
} from "./ai-types.js";
import {
  validateAssessmentQuestions,
  validateAnswerFeedback,
  validateDiagnosisResult,
  validateFeynmanExplanation,
  validateRemediationTasks,
} from "./ai-validators.js";

export interface LongCatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LongCatResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

export class LongCatAiProvider {
  private config: AiConfig;
  private runRecords: AiRunRecord[] = [];
  private idCounter = 0;

  constructor(config: AiConfig) {
    this.config = config;
  }

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

  private async callApi(messages: LongCatMessage[]): Promise<LongCatResponse> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        max_tokens: this.config.maxTokens,
        temperature: this.config.temperature,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LongCat API 错误: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<LongCatResponse>;
  }

  private parseJsonResponse<T>(content: string): T {
    try {
      // 尝试直接解析
      return JSON.parse(content) as T;
    } catch {
      // 尝试提取 JSON 块
      const jsonMatch = content.match(/```json\n([\s\S]*?)```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1]) as T;
      }
      // 尝试提取花括号内容
      const braceMatch = content.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        return JSON.parse(braceMatch[0]) as T;
      }
      throw new Error("无法解析 AI 返回的 JSON");
    }
  }

  private parseAndValidate<T>(content: string, validator: (data: unknown) => { success: boolean; data: T }): T {
    const parsed = this.parseJsonResponse<unknown>(content);
    const result = validator(parsed);
    if (!result.success) {
      throw new Error("AI 返回的数据格式不正确");
    }
    return result.data;
  }

  async generateQuestions(params: {
    courseId: string;
    topic: string;
    count: number;
    difficulty: string;
    context: string;
  }): Promise<AssessmentQuestion[]> {
    const start = Date.now();
    try {
      const response = await this.callApi([
        {
          role: "system",
          content: `你是一位专业的学习诊断教师。请根据课程内容生成 ${params.count} 道简答题，难度为${params.difficulty}。每道题包含：问题、4个选项（A/B/C/D）、正确答案、解释、知识点标签。以 JSON 数组格式返回。`,
        },
        {
          role: "user",
          content: `课程主题：${params.topic}\n\n课程内容：${params.context}\n\n请生成 ${params.count} 道简答题。`,
        },
      ]);

      const content = response.choices[0].message.content;
      const questions = this.parseAndValidate(content, validateAssessmentQuestions);

      this.recordRun({
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        latencyMs: Date.now() - start,
        inputSource: `generateQuestions:${params.courseId}`,
        success: true,
      });

      return questions;
    } catch (error) {
      this.recordRun({
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - start,
        inputSource: `generateQuestions:${params.courseId}`,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async submitAnswer(params: {
    question: AssessmentQuestion;
    answer: string;
    context: string;
  }): Promise<AnswerFeedback> {
    const start = Date.now();
    try {
      const response = await this.callApi([
        {
          role: "system",
          content: `你是一位专业的学习评估教师。请评估学生的回答，给出：是否正确（布尔值）、得分（0-100）、正确部分、知识缺口、证据。以 JSON 格式返回。`,
        },
        {
          role: "user",
          content: `问题：${params.question.question}\n选项：${params.question.options.join("、")}\n正确答案：${params.question.answer}\n学生回答：${params.answer}\n\n请评估学生回答。`,
        },
      ]);

      const content = response.choices[0].message.content;
      const feedback = this.parseAndValidate(content, validateAnswerFeedback);

      this.recordRun({
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        latencyMs: Date.now() - start,
        inputSource: `submitAnswer:${params.question.id}`,
        success: true,
      });

      return feedback;
    } catch (error) {
      this.recordRun({
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - start,
        inputSource: `submitAnswer:${params.question.id}`,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async generateDiagnosis(params: {
    courseId: string;
    answers: Array<{ question: AssessmentQuestion; answer: string; feedback: AnswerFeedback }>;
    learningRecords: LearningRecord[];
  }): Promise<DiagnosisResult> {
    const start = Date.now();
    try {
      const answersText = params.answers
        .map(
          (a, i) =>
            `第${i + 1}题：${a.question.question}\n学生回答：${a.answer}\n是否正确：${a.feedback.isCorrect}\n得分：${a.feedback.score}`,
        )
        .join("\n\n");

      const response = await this.callApi([
        {
          role: "system",
          content: `你是一位专业的学习诊断专家。请根据学生的作答情况，诊断知识薄弱点，生成：薄弱知识点列表（含证据和严重程度）、补救任务、下次复习时间、建议的课程文件修改。以 JSON 格式返回。`,
        },
        {
          role: "user",
          content: `课程ID：${params.courseId}\n\n作答情况：\n${answersText}\n\n历史学习记录：${JSON.stringify(params.learningRecords, null, 2)}`,
        },
      ]);

      const content = response.choices[0].message.content;
      const diagnosis = this.parseAndValidate(content, validateDiagnosisResult);

      this.recordRun({
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        latencyMs: Date.now() - start,
        inputSource: `generateDiagnosis:${params.courseId}`,
        success: true,
      });

      return diagnosis;
    } catch (error) {
      this.recordRun({
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - start,
        inputSource: `generateDiagnosis:${params.courseId}`,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async generateFeynmanExplanation(params: {
    concept: string;
    level: string;
    context: string;
  }): Promise<{ explanation: string; analogy: string; examples: string[] }> {
    const start = Date.now();
    try {
      const response = await this.callApi([
        {
          role: "system",
          content: `你是一位擅长费曼学习法的教师。请用简单易懂的语言解释概念，提供生活类比和具体例子。以 JSON 格式返回：{explanation, analogy, examples}`,
        },
        {
          role: "user",
          content: `概念：${params.concept}\n难度级别：${params.level}\n\n请用费曼学习法解释这个概念。`,
        },
      ]);

      const content = response.choices[0].message.content;
      const result = this.parseAndValidate(content, validateFeynmanExplanation);

      this.recordRun({
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        latencyMs: Date.now() - start,
        inputSource: `generateFeynmanExplanation:${params.concept}`,
        success: true,
      });

      return result;
    } catch (error) {
      this.recordRun({
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - start,
        inputSource: `generateFeynmanExplanation:${params.concept}`,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async generateRemediationTasks(params: {
    weakPoints: DiagnosisResult["weakPoints"];
    currentLevel: string;
  }): Promise<string[]> {
    const start = Date.now();
    try {
      const response = await this.callApi([
        {
          role: "system",
          content: `你是一位专业的学习规划师。请根据薄弱知识点生成具体的补救任务列表。`,
        },
        {
          role: "user",
          content: `薄弱知识点：${JSON.stringify(params.weakPoints, null, 2)}\n当前水平：${params.currentLevel}\n\n请生成补救任务列表。`,
        },
      ]);

      const content = response.choices[0].message.content;
      const tasks = this.parseAndValidate(content, validateRemediationTasks);

      this.recordRun({
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        latencyMs: Date.now() - start,
        inputSource: "generateRemediationTasks",
        success: true,
      });

      return tasks;
    } catch (error) {
      this.recordRun({
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - start,
        inputSource: "generateRemediationTasks",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  getRunRecords(): AiRunRecord[] {
    return [...this.runRecords];
  }

  clearRunRecords(): void {
    this.runRecords = [];
  }
}
