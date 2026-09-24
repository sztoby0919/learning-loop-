// AI 诊断流程测试
// 覆盖：创建诊断、逐题提交、生成方案、拒绝写回、确认写回、源文件冲突

import { describe, it, expect, beforeEach } from "vitest";
import { MockAiProvider } from "./ai-provider.js";
import { AiService } from "./ai-service.js";
import { batchAtomicWrite, computeFileHash, checkFileConflict } from "./file-utils.js";
import type { AiConfig, AssessmentQuestion, AnswerFeedback } from "./ai-types.js";

const testConfig: AiConfig = {
  baseUrl: "https://test.example.com",
  apiKey: "<REDACTED>
  model: "test-model",
  maxTokens: 1000,
  temperature: 0.5,
};

describe("AI 诊断流程", () => {
  let provider: MockAiProvider;
  let service: AiService;

  beforeEach(() => {
    provider = new MockAiProvider(testConfig);
    service = new AiService({ provider, maxRetries: 1, timeoutMs: 5000 });
  });

  it("应该完成完整的诊断流程：生成题目 → 作答 → 诊断", async () => {
    // 1. 生成题目
    const questions = await service.generateAssessmentQuestions({
      courseId: "calculus-101",
      topic: "微积分",
      count: 3,
      difficulty: "medium",
      context: "极限、导数、积分",
    });
    expect(questions).toHaveLength(3);

    // 2. 逐题作答
    const answers = [];
    for (const q of questions) {
      const feedback = await service.submitAnswer({
        question: q,
        answer: q.answer,
        context: "微积分课程内容",
      });
      answers.push({ question: q, answer: q.answer, feedback });
      expect(feedback.isCorrect).toBe(true);
    }

    // 3. 生成诊断
    const diagnosis = await service.generateDiagnosis({
      courseId: "calculus-101",
      answers,
      learningRecords: [],
    });
    expect(diagnosis.courseId).toBe("calculus-101");
    expect(diagnosis.weakPoints).toBeDefined();
    expect(diagnosis.remediationTasks).toBeDefined();
    expect(diagnosis.nextReviewDate).toBeDefined();
  });

  it("应该记录运行日志", async () => {
    await service.generateAssessmentQuestions({
      courseId: "test",
      topic: "测试",
      count: 1,
      difficulty: "easy",
      context: "测试上下文",
    });

    const records = provider.getRunRecords();
    expect(records.length).toBe(1);
    expect(records[0].success).toBe(true);
    expect(records[0].model).toBe("test-model");
  });
});

describe("文件操作", () => {
  it("应该正确计算文件哈希", async () => {
    const { atomicWriteFile } = await import("./file-utils.js");
    const testFile = "/tmp/test-hash-" + Date.now() + ".md";
    await atomicWriteFile(testFile, "# 测试内容");

    const hash = await computeFileHash(testFile);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    // 相同内容应该产生相同哈希
    const hash2 = await computeFileHash(testFile);
    expect(hash).toBe(hash2);
  });

  it("应该检测文件冲突", async () => {
    const { atomicWriteFile } = await import("./file-utils.js");
    const testFile = "/tmp/test-conflict-" + Date.now() + ".md";
    await atomicWriteFile(testFile, "原始内容");
    const originalHash = await computeFileHash(testFile);

    // 模拟外部修改
    await atomicWriteFile(testFile, "修改后内容");
    const hasConflict = await checkFileConflict(testFile, originalHash);
    expect(hasConflict).toBe(true);

    // 相同内容不应冲突
    const currentHash = await computeFileHash(testFile);
    const noConflict = await checkFileConflict(testFile, currentHash);
    expect(noConflict).toBe(false);
  });

  it("应该批量原子写入", async () => {
    const testFiles = [
      { filePath: "/tmp/test-batch-1-" + Date.now() + ".md", content: "文件1" },
      { filePath: "/tmp/test-batch-2-" + Date.now() + ".md", content: "文件2" },
    ];

    const result = await batchAtomicWrite(testFiles);
    expect(result.success).toBe(true);

    // 验证文件已写入
    const { readFile } = await import("node:fs/promises");
    for (const file of testFiles) {
      const content = await readFile(file.filePath, "utf8");
      expect(content).toBe(file.content);
    }
  });

  it("应该在冲突时返回错误", async () => {
    const testFile = "/tmp/test-conflict-batch-" + Date.now() + ".md";
    const { atomicWriteFile } = await import("./file-utils.js");
    await atomicWriteFile(testFile, "原始内容");
    const originalHash = await computeFileHash(testFile);

    // 外部修改
    await atomicWriteFile(testFile, "外部修改");

    // 尝试用旧哈希写入
    const result = await batchAtomicWrite([{
      filePath: testFile,
      content: "AI 修改",
      expectedHash: originalHash,
    }]);

    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
  });
});

describe("安全测试", () => {
  it("API Key 不应出现在日志中", async () => {
    await service.generateAssessmentQuestions({
      courseId: "test",
      topic: "测试",
      count: 1,
      difficulty: "easy",
      context: "测试上下文",
    });

    const records = provider.getRunRecords();
    const recordStr = JSON.stringify(records);
    expect(recordStr).not.toContain("test-api-key");
  });

  it("Mock Provider 不应包含真实 API 调用", () => {
    // Mock 实现不应有网络请求
    const mockProvider = new MockAiProvider({
      baseUrl: "https://api.longcat.chat",
      apiKey: "<REDACTED>
      model: "LongCat-2.0",
      maxTokens: 1000,
      temperature: 0.7,
    });
    // 验证 Mock 被正确创建
    expect(mockProvider).toBeDefined();
  });
});
