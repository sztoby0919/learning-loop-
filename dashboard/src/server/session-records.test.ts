// @vitest-environment node

import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { buildArchiveProposal } from "./archive-proposal.js";
import type { AiProvider } from "./ai-provider.js";
import { AiService } from "./ai-service.js";
import type { DiagnosisResult } from "./ai-types.js";
import { CourseEventBus } from "./course-events.js";
import { WorkspaceRepository } from "./workspace-repository.js";

const courseMarkdown = `---\nid: calculus-101\ntitle: 微积分\naccent: "#27624B"\nupdated: 2026-09-28\n---\n# 微积分\n## 课程概览\n学习导数。\n## 学习路线\n### 导数\n- [ ] 理解导数\n## 关键知识\n导数是瞬时变化率。\n## 易错点\n暂无。\n## 学习记录\n| 日期 | 学习内容 | 掌握度 1-10 | 遇到困难 | 下一步 |\n| --- | --- | ---: | --- | --- |\n`;
const diagnosis: DiagnosisResult = { courseId: "calculus-101", weakPoints: [], remediationTasks: [], nextReviewDate: "2026-10-01", proposedChanges: { courseMarkdown: "", reviewsMarkdown: "", mistakesMarkdown: "", sessionMarkdown: "" } };
const wrongAnswer = { question: "导数表示什么？", options: ["平均变化率", "瞬时变化率", "函数值", "积分面积"], answer: "A. 平均变化率", score: 0, gap: "理解有误", correctAnswer: "B. 瞬时变化率", explanation: "导数是瞬时变化率。", knowledgePoint: "导数" };

async function courseDirectory(withSessions = true) {
  const root = await mkdtemp(path.join(tmpdir(), "learning-loop-mistakes-"));
  const courseRoot = path.join(root, "calculus-101");
  await mkdir(withSessions ? path.join(courseRoot, "sessions") : courseRoot, { recursive: true });
  await writeFile(path.join(courseRoot, "course.md"), courseMarkdown);
  return courseRoot;
}

function proposal(mode: "real" | "mock", answers = [wrongAnswer]) {
  return buildArchiveProposal({ courseRoot: "C:/unused", assessmentId: "diagnosis-1", courseMarkdown, reviewsMarkdown: null, diagnosis, answers, today: "2026-09-28", mode });
}

describe("diagnostic session records", () => {
  it("records option choices, knowledge point and actual runtime mode without losing the old visible lines", () => {
    const session = proposal("real")[2].after;
    expect(session).toContain("mode: real");
    expect(session).toContain("知识点：导数");
    expect(session).toContain("选项：A. 平均变化率");
    expect(session).toContain("B. 瞬时变化率");
    expect(session).toContain("问题：导数表示什么？");
    expect(session).toContain("选择：A. 平均变化率");
    expect(session).toContain("正确答案：B. 瞬时变化率");
    expect(session).toContain("解析：导数是瞬时变化率。");
  });

  it("indexes only wrong answers from a confirmed new diagnosis with stable IDs", async () => {
    const { readMistakes } = await import("./session-records.js");
    const courseRoot = await courseDirectory();
    await writeFile(path.join(courseRoot, "sessions", "2026-09-28-diagnosis-1.md"), proposal("mock", [wrongAnswer, { ...wrongAnswer, question: "2 + 2 = ?", answer: "B. 4", correctAnswer: "B. 4", score: 100 }])[2].after);
    const first = await readMistakes(courseRoot, "calculus-101");
    const second = await readMistakes(courseRoot, "calculus-101");
    expect(first.warnings).toEqual([]);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ courseId: "calculus-101", question: "导数表示什么？", selected: "A. 平均变化率", correct: "B. 瞬时变化率", explanation: "导数是瞬时变化率。", knowledgePoint: "导数", date: "2026-09-28", sourceSession: "2026-09-28-diagnosis-1.md", mode: "mock" });
    expect(first.items[0].id).toBe(second.items[0].id);
  });

  it("treats old sessions as unknown mode and tolerates a malformed neighbor", async () => {
    const { readMistakes } = await import("./session-records.js");
    const courseRoot = await courseDirectory();
    const legacy = `---\nkind: ai-assessment\ncourseId: calculus-101\nupdated: 2026-09-26\n---\n# 诊断记录\n\n## 第 1 题\n\n问题：极限是什么？\n\n选择：A. 函数值\n\n得分：0/100\n\n正确答案：B. 趋近值\n\n解析：看趋近过程。\n\n## 补救任务\n`;
    await writeFile(path.join(courseRoot, "sessions", "2026-09-26-legacy.md"), legacy);
    await writeFile(path.join(courseRoot, "sessions", "2026-09-27-broken.md"), "---\nkind: ai-assessment\ncourseId: calculus-101\n---\n## 第 1 题\n问题：缺少选择和答案");
    const result = await readMistakes(courseRoot, "calculus-101");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ knowledgePoint: null, mode: "unknown", question: "极限是什么？" });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("2026-09-27-broken.md");
  });

  it("renders one confirmed practice attempt for the same mistake reader", async () => {
    const { readMistakes, renderAttemptSession } = await import("./session-records.js");
    const courseRoot = await courseDirectory();
    const markdown = renderAttemptSession({ kind: "targeted-practice", courseId: "calculus-101", confirmedAt: "2026-09-28", mode: "real", question: { question: "极限是什么？", options: ["函数值", "趋近值", "积分", "斜率"], selected: "A", correct: "B", explanation: "极限描述趋近过程。", knowledgePoint: "极限" } });
    await writeFile(path.join(courseRoot, "sessions", "2026-09-28-practice.md"), markdown);
    const result = await readMistakes(courseRoot, "calculus-101");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ question: "极限是什么？", selected: "A. 函数值", correct: "B. 趋近值", mode: "real", knowledgePoint: "极限" });
  });

  it.each(["targeted-practice", "review-attempt"] as const)("does not index an unconfirmed %s even when updated is present", async (kind) => {
    const { readMistakes, renderAttemptSession } = await import("./session-records.js");
    const courseRoot = await courseDirectory();
    const markdown = renderAttemptSession({ kind, courseId: "calculus-101", confirmedAt: "2026-09-28", mode: "real", question: { question: "极限是什么？", options: ["函数值", "趋近值", "积分", "斜率"], selected: "A", correct: "B", explanation: "极限描述趋近过程。", knowledgePoint: "极限" } }).replace("confirmedAt: 2026-09-28\n", "");
    await writeFile(path.join(courseRoot, "sessions", `${kind}.md`), markdown);
    const result = await readMistakes(courseRoot, "calculus-101");
    expect(result.items).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining(`${kind}.md`)]);
  });

  it("refuses a sessions directory symlink outside the configured course root", async () => {
    const { readMistakes } = await import("./session-records.js");
    const courseRoot = await courseDirectory(false);
    const externalRoot = await mkdtemp(path.join(tmpdir(), "learning-loop-external-sessions-"));
    const externalSessions = path.join(externalRoot, "sessions");
    await mkdir(externalSessions);
    await writeFile(path.join(externalSessions, "outside.md"), proposal("real")[2].after);
    await symlink(externalSessions, path.join(courseRoot, "sessions"), "junction");
    const result = await readMistakes(courseRoot, "calculus-101");
    expect(result.items).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("sessions");
  });

  it("rejects impossible scores instead of indexing them as mistakes", async () => {
    const { readMistakes } = await import("./session-records.js");
    const courseRoot = await courseDirectory();
    await writeFile(path.join(courseRoot, "sessions", "bad-score.md"), proposal("mock")[2].after.replace("得分：0/100", "得分：101/100"));
    const result = await readMistakes(courseRoot, "calculus-101");
    expect(result.items).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("bad-score.md")]);
  });

  it("serves configured course mistakes and never exposes a proposed or unsubmitted answer", async () => {
    const courseRoot = await courseDirectory();
    const repository = new WorkspaceRepository({ configPath: path.join(path.dirname(courseRoot), "dashboard.config.json"), courses: [{ id: "calculus-101", root: courseRoot, enabled: true }] }, () => "2026-09-28");
    const app = createApp(repository, new CourseEventBus());
    const pending = await request(app).get("/api/courses/calculus-101/mistakes");
    expect(pending.status).toBe(200);
    expect(pending.body).toEqual({ items: [], warnings: [] });
    await request(app).get("/api/courses/not-configured/mistakes").expect(404);
    await writeFile(path.join(courseRoot, "sessions", "2026-09-28-diagnosis-1.md"), proposal("real")[2].after);
    const confirmed = await request(app).get("/api/courses/calculus-101/mistakes");
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.items).toHaveLength(1);
    expect(confirmed.body.items[0]).toMatchObject({ correct: "B. 瞬时变化率", mode: "real" });
  });

  it("does not index a generated answer until apply and preserves real runtime provenance", async () => {
    const courseRoot = await courseDirectory();
    const repository = new WorkspaceRepository({ configPath: path.join(path.dirname(courseRoot), "dashboard.config.json"), courses: [{ id: "calculus-101", root: courseRoot, enabled: true }] }, () => "2026-09-28");
    const provider: AiProvider = {
      async generateQuestions() { return [{ id: "q1", question: "导数表示什么？", options: wrongAnswer.options, answer: "B", explanation: wrongAnswer.explanation, knowledgePoint: "导数" }]; },
      async submitAnswer() { throw new Error("单选题不调用模型评分"); },
      async generateDiagnosis() { return diagnosis; },
      async generateFeynmanExplanation() { return { explanation: "", analogy: "", examples: [] }; },
      async generateRemediationTasks() { return []; },
    };
    const app = createApp(repository, new CourseEventBus(), new AiService({ provider, maxRetries: 0 }), undefined, "real");
    const created = await request(app).post("/api/ai/assessments").send({ courseId: "calculus-101" }).expect(201);
    expect(JSON.stringify(created.body)).not.toContain("正确答案");
    expect(JSON.stringify(created.body)).not.toContain('"answer":"B"');
    expect((await request(app).get("/api/courses/calculus-101/mistakes")).body.items).toEqual([]);
    const id = created.body.assessmentId as string;
    await request(app).post(`/api/ai/assessments/${id}/answers`).send({ questionId: "q1", answer: "A" }).expect(200);
    await request(app).get(`/api/ai/assessments/${id}/proposal`).expect(200);
    expect((await request(app).get("/api/courses/calculus-101/mistakes")).body.items).toEqual([]);
    await request(app).post(`/api/ai/assessments/${id}/apply`).send({}).expect(200);
    const confirmed = await request(app).get("/api/courses/calculus-101/mistakes").expect(200);
    expect(confirmed.body.items).toHaveLength(1);
    expect(confirmed.body.items[0]).toMatchObject({ knowledgePoint: "导数", mode: "real", selected: "A. 平均变化率" });
  });
});
