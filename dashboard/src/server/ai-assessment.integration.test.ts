// @vitest-environment node

import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { AiProvider } from "./ai-provider.js";
import { AiService } from "./ai-service.js";
import { createApp } from "./app.js";
import { CourseEventBus } from "./course-events.js";
import { AiResponseFormatError, OpenAiCompatibleProvider } from "./openai-compatible-provider.js";
import { WorkspaceRepository } from "./workspace-repository.js";

const courseMarkdown = `---
id: calculus-101
title: 微积分基础
accent: "#27624B"
updated: 2026-09-25
---
# 微积分基础
## 课程概览
学习导数。
## 学习路线
### 导数
- [ ] 理解导数
## 关键知识
导数是瞬时变化率。
## 易错点
暂无个人易错点。
## 学习记录
| 日期 | 学习内容 | 掌握度 1-10 | 遇到困难 | 下一步 |
| --- | --- | ---: | --- | --- |
`;

const reviewsMarkdown = `---
courseId: calculus-101
updated: 2026-09-25
---
# 微积分复习
| 知识点 | 上次复习 | 下次复习 | 掌握度 1-10 | 复习证据 |
| --- | --- | --- | ---: | --- |
`;

const provider: AiProvider = {
  async generateQuestions() {
    return [{ id: "q1", question: "导数表示什么？", options: ["平均变化率", "瞬时变化率", "函数值", "积分面积"], answer: "B", explanation: "导数是函数在某点的瞬时变化率。", knowledgePoint: "导数" }];
  },
  async submitAnswer({ question, answer }) {
    const isCorrect = answer.includes("瞬时");
    return { questionId: question.id, isCorrect, score: isCorrect ? 90 : 30, correctPart: "提到了变化", gap: isCorrect ? "" : "没有说明瞬时", evidence: `回答：${answer}`, feynmanExplanation: isCorrect ? undefined : "想象汽车速度表显示此刻速度。" };
  },
  async generateDiagnosis({ courseId }) {
    return { courseId, weakPoints: [{ knowledgePoint: "导数", evidence: "没有说明瞬时", severity: "high" }], remediationTasks: ["解释瞬时变化率并举例"], nextReviewDate: "2026-09-28", proposedChanges: { courseMarkdown: "恶意替换整个文件", reviewsMarkdown: "恶意替换复习表", mistakesMarkdown: "", sessionMarkdown: "" } };
  },
  async generateFeynmanExplanation() { return { explanation: "", analogy: "", examples: [] }; },
  async generateRemediationTasks() { return []; },
};

async function setup(aiProvider: AiProvider = provider, mode: "real" | "mock" = "mock") {
  const root = await mkdtemp(path.join(tmpdir(), "learning-loop-assessment-"));
  const courseRoot = path.join(root, "calculus-101");
  await mkdir(courseRoot);
  await writeFile(path.join(courseRoot, "course.md"), courseMarkdown);
  await writeFile(path.join(courseRoot, "reviews.md"), reviewsMarkdown);
  const repository = new WorkspaceRepository({ configPath: path.join(root, "dashboard.config.json"), courses: [{ id: "calculus-101", root: courseRoot, enabled: true }] }, () => "2026-09-25");
  return { app: createApp(repository, new CourseEventBus(), new AiService({ provider: aiProvider, maxRetries: 0 }), undefined, mode), courseRoot };
}

async function startAndAnswer(app: Awaited<ReturnType<typeof setup>>["app"]) {
  const created = await request(app).post("/api/ai/assessments").send({ courseId: "calculus-101" });
  const assessmentId = created.body.assessmentId as string;
  const questionId = created.body.question.id as string;
  const answered = await request(app).post(`/api/ai/assessments/${assessmentId}/answers`).send({ questionId, answer: "A" });
  return { created, answered, assessmentId };
}

describe("AI assessment API", () => {
  it("grades one selected option on the server, reveals the explanation, and forbids a second attempt", async () => {
    const multipleChoiceProvider: AiProvider = {
      ...provider,
      async generateQuestions() {
        return [{ id: "q1", question: "导数表示什么？", options: ["平均变化率", "瞬时变化率", "函数值", "积分面积"], answer: "B", explanation: "导数描述某一点的瞬时变化率。", knowledgePoint: "导数" }];
      },
      async submitAnswer() { throw new Error("选择题不应调用模型评分"); },
    };
    const { app } = await setup(multipleChoiceProvider);
    const created = await request(app).post("/api/ai/assessments").send({ courseId: "calculus-101" });
    expect(created.status).toBe(201);
    expect(created.body.question.options).toEqual(["平均变化率", "瞬时变化率", "函数值", "积分面积"]);
    expect(JSON.stringify(created.body)).not.toContain('"answer":"B"');
    const path = `/api/ai/assessments/${created.body.assessmentId}/answers`;
    const first = await request(app).post(path).send({ questionId: "q1", answer: "A" });
    expect(first.status).toBe(200);
    expect(first.body.feedback).toMatchObject({ isCorrect: false, score: 0, correctPart: "B. 瞬时变化率", evidence: "导数描述某一点的瞬时变化率。" });
    expect((await request(app).post(path).send({ questionId: "q1", answer: "B" })).status).toBe(409);
    expect((await request(app).post(`/api/ai/assessments/${created.body.assessmentId}/retry`).send({ answer: "B" })).status).toBe(404);
  });
  it("returns a safe actionable field error for malformed model output", async () => {
    const { app } = await setup({ ...provider, async generateQuestions() { throw new AiResponseFormatError(["0.knowledgePoint"]); } });
    const result = await request(app).post("/api/ai/assessments").send({ courseId: "calculus-101" });
    expect(result.status).toBe(502);
    expect(result.body.error).toContain("0.knowledgePoint");
  });
  it("records the selected option in the session without permitting a retry", async () => {
    const { app } = await setup();
    const { assessmentId } = await startAndAnswer(app);
    expect((await request(app).post(`/api/ai/assessments/${assessmentId}/retry`).send({ answer: "B" })).status).toBe(404);
    const proposal = await request(app).get(`/api/ai/assessments/${assessmentId}/proposal`);
    expect(proposal.body.files[2].after).toContain("A. 平均变化率");
  });

  it("keeps the answer on the server and grades the stored question", async () => {
    const { app } = await setup();
    const { created, answered } = await startAndAnswer(app);
    expect(created.status).toBe(201);
    expect(created.body.question).toMatchObject({ question: "导数表示什么？" });
    expect(JSON.stringify(created.body)).not.toContain('"answer":"B"');
    expect(answered.status).toBe(200);
    expect(answered.body.feedback).toMatchObject({ questionId: "q1", score: 0 });
  });

  it("previews preserved Markdown and writes it only after confirmation", async () => {
    const { app, courseRoot } = await setup();
    const { assessmentId } = await startAndAnswer(app);
    const proposal = await request(app).get(`/api/ai/assessments/${assessmentId}/proposal`);
    expect(proposal.status).toBe(200);
    expect(proposal.body.files[0]).toMatchObject({ name: "course.md", before: courseMarkdown });
    expect(proposal.body.files[0].after).toContain("## 学习记录");
    expect(await readFile(path.join(courseRoot, "course.md"), "utf8")).toBe(courseMarkdown);

    const applied = await request(app).post(`/api/ai/assessments/${assessmentId}/apply`).send({});
    expect(applied.status).toBe(200);
    expect(await readFile(path.join(courseRoot, "course.md"), "utf8")).toContain("解释瞬时变化率并举例");
    expect(await readFile(path.join(courseRoot, "course.md"), "utf8")).not.toContain("恶意替换整个文件");
    expect(await readFile(path.join(courseRoot, "reviews.md"), "utf8")).toContain("2026-09-28");
  });

  it("rejects a stale proposal without overwriting the changed file", async () => {
    const { app, courseRoot } = await setup();
    const { assessmentId } = await startAndAnswer(app);
    await request(app).get(`/api/ai/assessments/${assessmentId}/proposal`);
    await writeFile(path.join(courseRoot, "course.md"), `${courseMarkdown}\n用户新笔记\n`);
    const applied = await request(app).post(`/api/ai/assessments/${assessmentId}/apply`).send({});
    expect(applied.status).toBe(409);
    expect(await readFile(path.join(courseRoot, "course.md"), "utf8")).toContain("用户新笔记");
    expect(await readFile(path.join(courseRoot, "reviews.md"), "utf8")).toBe(reviewsMarkdown);
  });

  it("derives evidence-based stats from a confirmed assessment session", async () => {
    const { app } = await setup(provider, "real");
    const { assessmentId } = await startAndAnswer(app);
    await request(app).get(`/api/ai/assessments/${assessmentId}/proposal`);
    await request(app).post(`/api/ai/assessments/${assessmentId}/apply`).send({});
    const stats = await request(app).get("/api/stats");
    expect(stats.body).toMatchObject({ diagnosisCount: 1, evidenceBasedMastery: 0, diagnosisBeforeMastery: 0, weakPointCount: 1 });
  });

  it("archives later diagnoses without duplicating or overwriting an existing review topic", async () => {
    const { app, courseRoot } = await setup();
    for (let index = 0; index < 2; index++) {
      const { assessmentId } = await startAndAnswer(app);
      await request(app).get(`/api/ai/assessments/${assessmentId}/proposal`).expect(200);
      await request(app).post(`/api/ai/assessments/${assessmentId}/apply`).expect(200);
    }
    const reviews = await readFile(path.join(courseRoot, "reviews.md"), "utf8");
    expect(reviews.match(/\| 导数 \|/g)).toHaveLength(1);
    const mistakes = await request(app).get("/api/courses/calculus-101/mistakes").expect(200);
    expect(mistakes.body.items).toHaveLength(2);
    expect(mistakes.body.items[0].id).not.toBe(mistakes.body.items[1].id);
    expect((await request(app).get("/api/stats")).body).toMatchObject({ diagnosisCount: 0, evidenceBasedMastery: null, weakPointCount: 0 });
  });

  it("rejects a model diagnosis for another course before creating a proposal", async () => {
    const { app, courseRoot } = await setup({ ...provider, generateDiagnosis: async () => ({ ...(await provider.generateDiagnosis({ courseId: "other-course", answers: [], learningRecords: [] })), courseId: "other-course" }) });
    const { assessmentId } = await startAndAnswer(app);
    const proposal = await request(app).get(`/api/ai/assessments/${assessmentId}/proposal`);
    expect(proposal.status).toBe(502);
    expect(await readFile(path.join(courseRoot, "reviews.md"), "utf8")).toBe(reviewsMarkdown);
  });

  it("rejects an invalid next review date from the model", async () => {
    const { app } = await setup({ ...provider, generateDiagnosis: async () => ({ ...(await provider.generateDiagnosis({ courseId: "calculus-101", answers: [], learningRecords: [] })), nextReviewDate: "tomorrow" }) });
    const { assessmentId } = await startAndAnswer(app);
    expect((await request(app).get(`/api/ai/assessments/${assessmentId}/proposal`)).status).toBe(502);
  });

  it("returns a specific gateway timeout instead of the generic request failure", async () => {
    const { app } = await setup({ ...provider, generateQuestions: async () => { throw new DOMException("timed out", "TimeoutError"); } });
    const result = await request(app).post("/api/ai/assessments").send({ courseId: "calculus-101" });
    expect(result.status).toBe(504);
    expect(result.body.error).toContain("超时");
  });
  it("returns a safe 502 when a successful upstream HTTP response is missing model text", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ choices: [] }) }));
    try {
      const aiProvider = new OpenAiCompatibleProvider({ baseUrl: "https://example.invalid/v1", apiKey: "private-test-key", model: "test", maxTokens: 2000, temperature: 0.2 });
      const { app } = await setup(aiProvider);
      const result = await request(app).post("/api/ai/assessments").send({ courseId: "calculus-101" });
      expect(result.status).toBe(502); expect(result.body.error).toContain("格式"); expect(result.body.error).not.toContain("private-test-key");
    } finally { vi.unstubAllGlobals(); }
  });

  it("explains an unsupported review table instead of hiding the report error", async () => {
    const { app, courseRoot } = await setup();
    const { assessmentId } = await startAndAnswer(app);
    await writeFile(path.join(courseRoot, "reviews.md"), reviewsMarkdown.replace("| 知识点 |", "| 非复习表 |"));
    const result = await request(app).get(`/api/ai/assessments/${assessmentId}/proposal`);
    expect(result.status).toBe(422);
    expect(result.body.error).toContain("复习计划缺少知识点或主题表格");
  });
});
