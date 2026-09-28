// @vitest-environment node

import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { AiProvider } from "./ai-provider.js";
import { AiService } from "./ai-service.js";
import { createApp } from "./app.js";
import { CourseEventBus } from "./course-events.js";
import { AiResponseFormatError } from "./openai-compatible-provider.js";
import { renderAttemptSession, readMistakes } from "./session-records.js";
import { WorkspaceRepository } from "./workspace-repository.js";

const courseMarkdown = `---
id: calculus-101
title: 微积分基础
accent: "#27624B"
updated: 2026-09-28
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
暂无。
## 学习记录
| 日期 | 学习内容 | 掌握度 1-10 | 遇到困难 | 下一步 |
| --- | --- | ---: | --- | --- |
`;
const provider: AiProvider = {
  async generateQuestions() {
    return [{ id: "q-new", question: "切线斜率表示什么？", options: ["平均变化率", "瞬时变化率", "函数值", "积分"], answer: "B", explanation: "斜率是该点的瞬时变化率。", knowledgePoint: "导数" }];
  },
  async submitAnswer() { throw new Error("选择题不调用模型评分"); },
  async generateDiagnosis() { throw new Error("练习不生成诊断"); },
  async generateFeynmanExplanation() { return { explanation: "", analogy: "", examples: [] }; },
  async generateRemediationTasks() { return []; },
};

async function setup(aiProvider: AiProvider = provider, mode: "real" | "mock" = "real") {
  const root = await mkdtemp(path.join(tmpdir(), "learning-loop-practice-api-"));
  const courseRoot = path.join(root, "calculus-101");
  await mkdir(path.join(courseRoot, "sessions"), { recursive: true });
  await writeFile(path.join(courseRoot, "course.md"), courseMarkdown);
  await writeFile(path.join(courseRoot, "reviews.md"), "手工复习计划\n");
  await writeFile(path.join(courseRoot, "sessions", "old.md"), renderAttemptSession({
    kind: "targeted-practice", courseId: "calculus-101", confirmedAt: "2026-09-27", mode: "real",
    question: { question: "导数表示什么？", options: ["平均变化率", "瞬时变化率", "函数值", "积分"], selected: "A", correct: "B", explanation: "导数是瞬时变化率。", knowledgePoint: "导数" },
  }));
  const repository = new WorkspaceRepository({ configPath: path.join(root, "config.json"), courses: [{ id: "calculus-101", root: courseRoot, enabled: true }] }, () => "2026-09-28");
  const events = new CourseEventBus();
  const app = createApp(repository, events, new AiService({ provider: aiProvider, maxRetries: 0 }), undefined, mode);
  const mistakeId = (await readMistakes(courseRoot, "calculus-101")).items[0].id;
  return { app, courseRoot, events, mistakeId };
}

describe("targeted practice API", () => {
  it("does not leak the answer before submission and returns 0/100 feedback exactly once", async () => {
    const { app, mistakeId } = await setup();
    const created = await request(app).post("/api/practice-sessions").send({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" }).expect(201);
    expect(created.body).toMatchObject({ mode: "real", question: { id: "q-new", options: ["平均变化率", "瞬时变化率", "函数值", "积分"] } });
    expect(Object.keys(created.body).sort()).toEqual(["mode", "question", "sessionId"]);
    expect(JSON.stringify(created.body)).not.toContain('"answer":"B"');
    expect(JSON.stringify(created.body)).not.toContain("斜率是该点");
    const url = `/api/practice-sessions/${created.body.sessionId}/answer`;
    await request(app).post(url).send({ questionId: "wrong", choice: "A" }).expect(409);
    const answered = await request(app).post(url).send({ questionId: "q-new", choice: "A" }).expect(200);
    expect(answered.body.feedback).toMatchObject({ questionId: "q-new", isCorrect: false, score: 0, correctPart: "B. 瞬时变化率" });
    await request(app).post(url).send({ questionId: "q-new", choice: "B" }).expect(409);
  });

  it.each(["real", "mock"] as const)("confirms a %s record, publishes an update, and rejects repeated confirmation", async (mode) => {
    const { app, courseRoot, events, mistakeId } = await setup(provider, mode);
    const published = vi.spyOn(events, "publish");
    const created = await request(app).post("/api/practice-sessions").send({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" }).expect(201);
    if (mode === "mock") expect(created.body.question.question).toContain("离线演示");
    const confirmUrl = `/api/practice-sessions/${created.body.sessionId}/confirm`;
    await request(app).post(confirmUrl).send({}).expect(409);
    await request(app).post(`/api/practice-sessions/${created.body.sessionId}/answer`).send({ questionId: "q-new", choice: "A" }).expect(200);
    const confirmed = await request(app).post(confirmUrl).send({}).expect(200);
    expect(confirmed.body).toMatchObject({ courseId: "calculus-101", mode });
    expect(published).toHaveBeenCalledWith("journal-updated", { courseId: "calculus-101", artifact: "sessions" });
    await request(app).post(confirmUrl).send({}).expect(409);
    const names = (await readdir(path.join(courseRoot, "sessions"))).filter((name) => name !== "old.md");
    expect(names).toHaveLength(1);
    const content = await readFile(path.join(courseRoot, "sessions", names[0]), "utf8");
    expect(content).toContain(`mode: ${mode}`);
    if (mode === "mock") expect(content).toContain("离线演示");
    expect(await readFile(path.join(courseRoot, "reviews.md"), "utf8")).toBe("手工复习计划\n");
    expect(await readFile(path.join(courseRoot, "course.md"), "utf8")).toBe(courseMarkdown);
    const mistakes = await request(app).get("/api/courses/calculus-101/mistakes").expect(200);
    expect(mistakes.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ mode, question: expect.stringContaining("切线斜率") })]));
  });

  it("rejects invalid requests and missing sessions with suitable status codes", async () => {
    const { app, mistakeId } = await setup();
    await request(app).post("/api/practice-sessions").send({ courseId: "../bad", mistakeId, kind: "targeted-practice" }).expect(400);
    await request(app).post("/api/practice-sessions").send({ courseId: "calculus-101", mistakeId, kind: "review-attempt" }).expect(400);
    await request(app).post("/api/practice-sessions").send({ courseId: "calculus-101", mistakeId: "missing", kind: "targeted-practice" }).expect(404);
    await request(app).post("/api/practice-sessions/missing/answer").send({ questionId: "q-new", choice: "A" }).expect(404);
    await request(app).post("/api/practice-sessions/missing/confirm").send({}).expect(404);
    const created = await request(app).post("/api/practice-sessions").send({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" }).expect(201);
    await request(app).post(`/api/practice-sessions/${created.body.sessionId}/answer`).send({ questionId: "q-new", choice: "E" }).expect(400);
  });

  it("returns a 502 model error without creating a practice session", async () => {
    const { app, mistakeId } = await setup({ ...provider, async generateQuestions() { throw new AiResponseFormatError(["0.options"]); } });
    const result = await request(app).post("/api/practice-sessions").send({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" }).expect(502);
    expect(result.body.error).toContain("0.options");
  });

  it("treats a provider outage as a retryable generation error", async () => {
    const { app, mistakeId } = await setup({ ...provider, async generateQuestions() { throw new Error("private provider detail"); } });
    const result = await request(app).post("/api/practice-sessions").send({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" }).expect(502);
    expect(result.body.error).toContain("生成练习题失败");
    expect(result.body.error).not.toContain("private provider detail");
  });
});
