// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "./app.js";
import { CourseEventBus } from "./course-events.js";
import { CourseImportManager } from "./course-import-manager.js";
import { createCourseImportAi } from "./course-import-ai.js";
import { WorkspaceRepository } from "./workspace-repository.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "learning-loop-api-import-"));
  roots.push(root);
  const events = new CourseEventBus();
  const repository = new WorkspaceRepository({ configPath: path.join(root, "config.json"), courses: [] }, () => "2026-09-26");
  const manager = new CourseImportManager({ root, repository, events, watchCourse: () => {}, today: () => "2026-09-26", extract: async () => ({ title: "微积分", pageCount: 1, pages: [{ page: 1, text: "第一章 极限与导数" }], outline: [{ title: "第一章 极限", page: 1 }], warnings: [] }) });
  return { app: createApp(repository, events, undefined, manager), repository, manager };
}

describe("PDF import HTTP flow", () => {
  it("uploads, previews, edits, confirms and serves the original PDF", async () => {
    const { app } = await setup();
    const uploaded = await request(app).post("/api/course-imports").attach("file", Buffer.from("%PDF-test"), "course.pdf").expect(201);
    expect(uploaded.body.draft.title).toBe("微积分");
    const id = uploaded.body.id as string;
    const edited = await request(app).patch(`/api/course-imports/${id}`).send({ title: "我的微积分", goal: "理解极限", weeklyHours: 2, stages: [{ title: "极限", tasks: ["完成练习"] }] }).expect(200);
    expect(edited.body.files["course.md"]).toContain("我的微积分");
    await request(app).post(`/api/course-imports/${id}/enrich`).send({ consent: false }).expect(400);
    const saved = await request(app).post(`/api/course-imports/${id}/confirm`).expect(201);
    const courseId = saved.body.courseId as string;
    expect((await request(app).get("/api/courses").expect(200)).body.courses[0].title).toBe("我的微积分");
    await request(app).get(`/api/courses/${courseId}/source`).expect("Content-Type", /pdf/).expect(200);
    await request(app).post(`/api/course-imports/${id}/confirm`).expect(409);
  });

  it("rejects missing and non-PDF uploads without creating a course", async () => {
    const { app } = await setup();
    await request(app).post("/api/course-imports").expect(400);
    await request(app).post("/api/course-imports").attach("file", Buffer.from("text"), "notes.txt").expect(400);
    expect((await request(app).get("/api/courses")).body.courses).toEqual([]);
  });

  it("preserves a Chinese PDF filename sent by a browser multipart upload", async () => {
    const { app } = await setup();
    const uploaded = await request(app).post("/api/course-imports").attach("file", Buffer.from("%PDF-test"), "微积分.pdf").expect(201);
    expect(uploaded.body.draft.originalFilename).toBe("微积分.pdf");
  });

  it("returns an actionable upstream AI error while keeping the basic draft", async () => {
    const { app, manager } = await setup();
    manager.setAiEnricher(createCourseImportAi({ baseUrl: "https://example.com/v1", apiKey: "test-secret", model: "model", maxTokens: 4000, temperature: 0.7 }, async () => ({ ok: false, status: 400 }) as Response));
    const uploaded = await request(app).post("/api/course-imports").attach("file", Buffer.from("%PDF-test"), "course.pdf").expect(201);
    const id = uploaded.body.id as string;
    const failed = await request(app).post(`/api/course-imports/${id}/enrich`).send({ consent: true }).expect(502);
    expect(failed.body.error).toContain("HTTP 400");
    expect(failed.body.error).not.toContain("test-secret");
    const draft = await request(app).get(`/api/course-imports/${id}`).expect(200);
    expect(draft.body.draft.aiStatus).toBe("failed");
    expect(draft.body.draft.stages).toEqual(uploaded.body.draft.stages);
  });
});
