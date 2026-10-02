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
import { AiRequestError } from "./ai-request.js";
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
  return { app, courseRoot, events, mistakeId, repository };
}

describe("targeted practice API", () => {
  it("keeps all four real/mock correct/wrong attempts under the original mistake after restart", async () => {
    const { courseRoot, repository, mistakeId } = await setup();
    for (const mode of ["real", "mock"] as const) {
      const app = createApp(new WorkspaceRepository(repository.config, () => "2026-09-28"), new CourseEventBus(), new AiService({ provider, maxRetries: 0 }), undefined, mode);
      for (const choice of ["A", "B"]) {
        const created = await request(app).post("/api/practice-sessions").send({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" }).expect(201);
        await request(app).post(`/api/practice-sessions/${created.body.sessionId}/answer`).send({ questionId: "q-new", choice }).expect(200);
        await request(app).post(`/api/practice-sessions/${created.body.sessionId}/confirm`).expect(200);
      }
    }
    const restarted = createApp(new WorkspaceRepository(repository.config, () => "2026-09-28"), new CourseEventBus());
    const result = await request(restarted).get("/api/courses/calculus-101/mistakes").expect(200);
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0].id).toBe(mistakeId);
    expect(result.body.items[0].attempts).toHaveLength(4);
    expect(result.body.items[0].attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: "real", isCorrect: false }),
      expect.objectContaining({ mode: "real", isCorrect: true }),
      expect.objectContaining({ mode: "mock", isCorrect: false }),
      expect.objectContaining({ mode: "mock", isCorrect: true }),
    ]));
    expect(await readdir(path.join(courseRoot, "sessions"))).toHaveLength(5);
  });
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
    expect(mistakes.body.items).toHaveLength(1);
    expect(mistakes.body.items[0].attempts).toEqual([expect.objectContaining({ mode, question: expect.stringContaining("切线斜率") })]);
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

  it("preserves a safe timeout cause when targeted practice generation times out", async () => {
    const { app, mistakeId } = await setup({ ...provider, async generateQuestions() { throw new AiRequestError("模型服务请求超时，已中止本地请求", 504); } });
    const result = await request(app).post("/api/practice-sessions").send({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" });
    expect(result.status).toBe(504); expect(result.body.error).toContain("超时");
  });
});

const reviewsMarkdown = `---
courseId: calculus-101
updated: 2026-09-20
---
# 手工计划

| 知识点 | 上次复习 | 下次复习 | 掌握度 1-10 | 复习证据 |
| --- | --- | --- | ---: | --- |
| 导数 | 2026-09-20 | 2026-09-21 | 6 | 手工证据 |
| 积分 | 2026-09-20 | 2026-10-20 | 8 | 保留这一行 |

手写备注，必须保留。
`;

async function setupReview(mode: "real" | "mock" = "real") {
  const setupResult = await setup(provider, mode);
  await writeFile(path.join(setupResult.courseRoot, "reviews.md"), reviewsMarkdown);
  return setupResult;
}

async function answerReview(app: ReturnType<typeof createApp>, choice = "B") {
  const created = await request(app).post("/api/practice-sessions").send({ courseId: "calculus-101", topic: "导数", kind: "review-attempt" }).expect(201);
  expect(created.body.question).not.toHaveProperty("answer");
  expect(created.body.question).not.toHaveProperty("explanation");
  await request(app).post(`/api/practice-sessions/${created.body.sessionId}/answer`).send({ questionId: "q-new", choice }).expect(200);
  return created.body.sessionId as string;
}

describe("review completion API", () => {
  it("accepts a registered topic and rejects an unknown course, topic, or empty topic", async () => {
    const { app } = await setupReview();
    for (const [courseId, topic, status] of [["unknown", "导数", 404], ["calculus-101", "伪造主题", 404], ["calculus-101", "  ", 400]] as const) {
      await request(app).post("/api/practice-sessions").send({ courseId, topic, kind: "review-attempt" }).expect(status);
    }
    await answerReview(app);
  });

  it("atomically saves real evidence and one review row, refreshes calendar/due data, and survives restart", async () => {
    const { app, repository, courseRoot, events } = await setupReview();
    const published = vi.spyOn(events, "publish");
    const id = await answerReview(app);
    const confirmed = await request(app).post(`/api/practice-sessions/${id}/confirm`).expect(200);
    expect(confirmed.body).toMatchObject({ advanced: true, mode: "real" });
    const raw = await readFile(path.join(courseRoot, "reviews.md"), "utf8");
    expect(raw).toContain("| 积分 | 2026-09-20 | 2026-10-20 | 8 | 保留这一行 |");
    expect(raw).toContain("手写备注，必须保留。");
    expect(raw).toContain(confirmed.body.sessionFile);
    expect(raw).toContain("答对");
    expect(await readFile(path.join(courseRoot, "course.md"), "utf8")).toBe(courseMarkdown);
    const session = await readFile(path.join(courseRoot, "sessions", confirmed.body.sessionFile), "utf8");
    expect(session).toContain("kind: review-attempt");
    expect(session).toContain("completedAt:");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const next = new Date(Date.parse(`${today}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10);
    const restarted = createApp(new WorkspaceRepository(repository.config, () => today), new CourseEventBus(), new AiService({ provider }), undefined, "real");
    const reviews = await request(restarted).get("/api/reviews").expect(200);
    expect(reviews.body).toContainEqual(expect.objectContaining({ topic: "导数", lastReviewed: today, nextReview: next, mastery: 6 }));
    const calendar = await request(restarted).get(`/api/calendar?month=${next.slice(0, 7)}`).expect(200);
    expect(calendar.body).toContainEqual(expect.objectContaining({ title: "复习：导数", date: next }));
    const due = await request(restarted).get("/api/reviews/due").expect(200);
    expect(due.body).toContainEqual(expect.objectContaining({ topic: "导数", nextReviewDate: next }));
    expect(published).toHaveBeenCalledWith("journal-updated", { courseId: "calculus-101", artifact: "reviews" });
    await request(app).post(`/api/practice-sessions/${id}/confirm`).expect(409);
    expect(await readdir(path.join(courseRoot, "sessions"))).toHaveLength(2);
  });

  it("saves a marked Mock session without advancing any review dates", async () => {
    const { app, courseRoot } = await setupReview("mock");
    const id = await answerReview(app);
    const saved = await request(app).post(`/api/practice-sessions/${id}/confirm`).expect(200);
    expect(saved.body).toMatchObject({ mode: "mock", advanced: false });
    expect(await readFile(path.join(courseRoot, "reviews.md"), "utf8")).toBe(reviewsMarkdown);
    const raw = await readFile(path.join(courseRoot, "sessions", saved.body.sessionFile), "utf8");
    expect(raw).toContain("mode: mock");
    expect(raw).toContain("离线演示");
  });

  it("keeps both files unchanged when the review snapshot conflicts with a manual edit", async () => {
    const { app, courseRoot } = await setupReview();
    const id = await answerReview(app);
    const edited = `${reviewsMarkdown}\n新增人工备注\n`;
    await writeFile(path.join(courseRoot, "reviews.md"), edited);
    const result = await request(app).post(`/api/practice-sessions/${id}/confirm`).expect(409);
    expect(result.body.error).toMatch(/冲突|修改/);
    expect(await readFile(path.join(courseRoot, "reviews.md"), "utf8")).toBe(edited);
    expect(await readdir(path.join(courseRoot, "sessions"))).toEqual(["old.md"]);
  });

  it("rejects a colliding session filename before changing either file", async () => {
    const { app, courseRoot } = await setupReview();
    const id = await answerReview(app);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const file = path.join(courseRoot, "sessions", `${today}-${id}.md`);
    await writeFile(file, "已有内容");
    await request(app).post(`/api/practice-sessions/${id}/confirm`).expect(409);
    expect(await readFile(file, "utf8")).toBe("已有内容");
    expect(await readFile(path.join(courseRoot, "reviews.md"), "utf8")).toBe(reviewsMarkdown);
  });

  it("serializes competing confirmations so only one matching snapshot can advance", async () => {
    const { app, courseRoot } = await setupReview();
    const first = await answerReview(app, "B");
    const second = await answerReview(app, "A");
    const results = await Promise.all([first, second].map((id) => request(app).post(`/api/practice-sessions/${id}/confirm`)));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await readdir(path.join(courseRoot, "sessions"))).toHaveLength(2);
    const saved = results.find((result) => result.status === 200)!;
    expect(await readFile(path.join(courseRoot, "reviews.md"), "utf8")).toContain(saved.body.sessionFile);
  });
});
