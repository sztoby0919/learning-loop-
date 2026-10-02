// @vitest-environment node
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createApp } from "./app.js";
import { CourseEventBus } from "./course-events.js";
import { CourseImportManager } from "./course-import-manager.js";
import { createCourseImportAi } from "./course-import-ai.js";
import { WorkspaceRepository } from "./workspace-repository.js";
import { loadDashboardConfig } from "./dashboard-config.js";
import { textPdf, imageOnlyPdf } from "../test/pdf-fixtures.js";

const roots: string[] = [];
const managers: CourseImportManager[] = [];
afterEach(async () => {
  managers.forEach((m) => m.stopScheduledCleanup());
  managers.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(realPdf = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "learning-loop-api-import-"));
  roots.push(root);
  const events = new CourseEventBus();
  const repository = new WorkspaceRepository({ configPath: path.join(root, "config.json"), courses: [] }, () => "2026-09-26");
  const manager = new CourseImportManager({ root, repository, events, watchCourse: () => {}, today: () => "2026-09-26", ...(realPdf ? {} : { extract: async () => ({ title: "微积分", pageCount: 1, pages: [{ page: 1, text: "第一章 极限与导数" }], outline: [{ title: "第一章 极限", page: 1 }], warnings: [], sourceFormat: "pdf" as const }) }) });
  managers.push(manager);
  return { app: createApp(repository, events, undefined, manager), repository, manager, root };
}

describe("Document import HTTP flow", () => {
  it("previews a chapter request without calls, then applies, undoes and rejects persisted candidates", async () => {
    const { app, manager } = await setup();
    const ai = vi.fn(async (excerpt: import("../shared/course-import.js").AiExcerpt) => excerpt.stageIds.map((stageId) => ({ stageId, title: "AI chapter", tasks: ["AI task"], notes: [{ title: "AI note", page: 1, content: "AI content" }] })));
    manager.setAiEnricher(ai);
    const uploaded = await request(app).post("/api/course-imports").attach("file", Buffer.from("%PDF-test"), "book.pdf").expect(201);
    const original = uploaded.body;
    const excerpt = await request(app).post(`/api/course-imports/${original.id}/ai-excerpt`).send({ expectedRevision: 0, stageIds: [original.draft.stages[0].id] }).expect(200);
    expect(ai).not.toHaveBeenCalled();
    const start = async (revision: number) => {
      const sending = await request(app).post(`/api/course-imports/${original.id}/ai-excerpt`).send({ expectedRevision: revision, stageIds: excerpt.body.stageIds }).expect(200);
      const operation = await request(app).post(`/api/course-imports/${original.id}/ai-operations`).send({ consent: true, expectedRevision: revision, stageIds: sending.body.stageIds, excerptHash: sending.body.excerptHash }).expect(202);
      await vi.waitFor(async () => expect((await request(app).get(`/api/course-imports/${original.id}/ai-operations/${operation.body.id}`).expect(200)).body.status).toBe("complete"), { timeout: 5000 });
      return (await request(app).get(`/api/course-imports/${original.id}`).expect(200)).body;
    };
    const candidate = await start(0);
    expect(candidate.draft).toEqual(original.draft); expect(candidate.revision).toBe(0);
    const applied = await request(app).post(`/api/course-imports/${original.id}/ai-candidates/${candidate.candidate.id}/apply`).send({ expectedRevision: 0, acceptedStageIds: excerpt.body.stageIds }).expect(200);
    expect(applied.body.draft.stages[0].title).toBe("AI chapter"); expect(applied.body.revision).toBe(1);
    await request(app).post(`/api/course-imports/${original.id}/ai-candidates/${candidate.candidate.id}/apply`).send({ expectedRevision: 1, acceptedStageIds: excerpt.body.stageIds }).expect(409);
    const undone = await request(app).post(`/api/course-imports/${original.id}/ai-undo`).send({ expectedRevision: 1 }).expect(200);
    expect(undone.body.draft).toEqual(original.draft); expect(undone.body.revision).toBe(2);
    const next = await start(2);
    const rejected = await request(app).delete(`/api/course-imports/${original.id}/ai-candidates/${next.candidate.id}`).send({ expectedRevision: 2 }).expect(200);
    expect(rejected.body.candidate).toBeUndefined(); expect(rejected.body.draft).toEqual(original.draft); expect(rejected.body.revision).toBe(2);
    expect(ai).toHaveBeenCalledTimes(2);
  }, 15000);
  it("lists resumable drafts, rejects revision conflicts and serves only their own source", async () => {
    const { app } = await setup(true);
    const bytes = Buffer.from(textPdf(["Chapter 1 Source text", ""]));
    const upload = await request(app).post("/api/course-imports").attach("file", bytes, "book.pdf").expect(201);
    const current = upload.body;
    expect(current.revision).toBe(0);
    expect(current.sourceUrl).toBe(`/api/course-imports/${current.id}/source`);
    expect(current.draft.quality.noTextPages).toEqual([2]);
    expect((await request(app).get("/api/course-imports").expect(200)).body).toMatchObject([{ id: current.id, status: "ready" }]);
    expect((await request(app).get(current.sourceUrl).expect(200)).body).toEqual(bytes);
    const edited = { ...current.draft, expectedRevision: 0, title: "Saved title" };
    await request(app).patch(`/api/course-imports/${current.id}`).send(edited).expect(200);
    await request(app).patch(`/api/course-imports/${current.id}`).send({ ...edited, title: "Stale title" }).expect(409);
    await request(app).post(`/api/course-imports/${current.id}/confirm`).expect(400);
    await request(app).delete(`/api/course-imports/${current.id}`).expect(204);
    await request(app).get(current.sourceUrl).expect(404);
  });
  it.each([
    ["damaged.pdf", () => Buffer.from("%PDF-1.4\ncorrupt"), "损坏"],
    ["encrypted.pdf", () => Buffer.from(textPdf(["Protected lesson"], true)), "密码"],
    ["scan.pdf", () => Buffer.from(imageOnlyPdf()), "扫描版"],
  ])("rejects %s without leaving a draft or half-created course", async (filename, bytes, reason) => {
    const { app, root } = await setup(true);
    const response = await request(app).post("/api/course-imports").attach("file", bytes(), filename).expect(422);
    expect(response.body.error).toContain(reason);
    expect((await request(app).get("/api/courses")).body.courses).toEqual([]);
    expect(await readdir(path.join(root, ".learning-loop", "imports")).catch(() => [])).toEqual([]);
    expect(await readdir(path.join(root, "learning-journal")).catch(() => [])).toEqual([]);
  });

  it("keeps same-name imports separate and reloads courses and sources after restart", async () => {
    const { app, root, manager } = await setup(true);
    const ids: string[] = [];
    for (const text of ["Chapter 1 Original lesson", "Chapter 1 Second lesson"]) {
      const upload = await request(app).post("/api/course-imports").attach("file", Buffer.from(textPdf([text])), "same.pdf").expect(201);
      const saved = await request(app).post(`/api/course-imports/${upload.body.id}/confirm`).send({ expectedRevision: upload.body.revision }).expect(201);
      ids.push(saved.body.courseId);
      const repeated = await request(app).post(`/api/course-imports/${upload.body.id}/confirm`).send({ expectedRevision: upload.body.revision }).expect(201);
      expect(repeated.body.courseId).toBe(saved.body.courseId);
    }
    expect(new Set(ids).size).toBe(2);
    manager.stopScheduledCleanup();
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ courses: [] }));
    const config = await loadDashboardConfig(configPath, path.join(root, "learning-journal"));
    const repository = new WorkspaceRepository(config, () => "2026-09-27");
    const events = new CourseEventBus();
    const restarted = new CourseImportManager({ root, repository, events, today: () => "2026-09-27", watchCourse: () => {} });
    managers.push(restarted);
    const restartedApp = createApp(repository, events, undefined, restarted);
    expect((await request(restartedApp).get("/api/courses").expect(200)).body.courses.map((course: { id: string }) => course.id).sort()).toEqual([...ids].sort());
    for (const [index, id] of ids.entries()) {
      const source = await request(restartedApp).get(`/api/courses/${id}/source`).expect(200);
      expect(Buffer.from(source.body)).toEqual(Buffer.from(textPdf([index === 0 ? "Chapter 1 Original lesson" : "Chapter 1 Second lesson"])));
      const course = await request(restartedApp).get(`/api/courses/${id}`).expect(200);
      expect(JSON.stringify(course.body)).toContain(index === 0 ? "Original lesson" : "Second lesson");
    }
  });

  it("accepts exactly 100 MiB and rejects one byte more at the HTTP upload boundary", async () => {
    const { app, root } = await setup();
    // Extraction is intentionally stubbed here: this isolates Multer's byte boundary.
    const bytes = Buffer.alloc(100 * 1024 * 1024, 32);
    bytes.write("%PDF-test");
    const accepted = await request(app).post("/api/course-imports").attach("file", bytes, "limit.pdf").expect(201);
    await request(app).delete(`/api/course-imports/${accepted.body.id}`).expect(204);
    const rejected = await request(app).post("/api/course-imports").attach("file", Buffer.concat([bytes, Buffer.from(" ")]), "over-limit.pdf").expect(413);
    expect(rejected.body.error).toContain("100 MB");
    expect((await request(app).get("/api/courses")).body.courses).toEqual([]);
    expect(await readdir(path.join(root, ".learning-loop", "imports"))).toEqual([]);
  }, 30_000);

  it("uploads, previews, edits, confirms and serves the original PDF", async () => {
    const { app } = await setup();
    const uploaded = await request(app).post("/api/course-imports").attach("file", Buffer.from("%PDF-test"), "course.pdf").expect(201);
    expect(uploaded.body.draft.title).toBe("微积分");
    const id = uploaded.body.id as string;
    const edited = await request(app).patch(`/api/course-imports/${id}`).send({ expectedRevision: uploaded.body.revision, title: "我的微积分", goal: "理解极限", weeklyHours: 2, stages: [{ title: "极限", tasks: ["完成练习"] }] }).expect(200);
    expect(edited.body.files["course.md"]).toContain("我的微积分");
    await request(app).post(`/api/course-imports/${id}/enrich`).send({ consent: false }).expect(410);
    const saved = await request(app).post(`/api/course-imports/${id}/confirm`).send({ expectedRevision: edited.body.revision }).expect(201);
    const courseId = saved.body.courseId as string;
    expect((await request(app).get("/api/courses").expect(200)).body.courses[0].title).toBe("我的微积分");
    await request(app).get(`/api/courses/${courseId}/source`).expect("Content-Type", /pdf/).expect(200);
    const repeated = await request(app).post(`/api/course-imports/${id}/confirm`).send({ expectedRevision: edited.body.revision }).expect(201);
    expect(repeated.body.courseId).toBe(courseId);
  });

  it("rejects missing and non-supported uploads without creating a course", async () => {
    const { app } = await setup();
    await request(app).post("/api/course-imports").expect(400);
    await request(app).post("/api/course-imports").attach("file", Buffer.from("text"), "notes.txt").expect(422);
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
    const excerpt = await request(app).post(`/api/course-imports/${id}/ai-excerpt`).send({ expectedRevision: uploaded.body.revision, stageIds: [uploaded.body.draft.stages[0].id] }).expect(200);
    const started = await request(app).post(`/api/course-imports/${id}/ai-operations`).send({ consent: true, expectedRevision: uploaded.body.revision, stageIds: excerpt.body.stageIds, excerptHash: excerpt.body.excerptHash }).expect(202);
    await vi.waitFor(async () => {
      const failed = await request(app).get(`/api/course-imports/${id}/ai-operations/${started.body.id}`).expect(200);
      expect(failed.body.status).toBe("failed");
      expect(failed.body.error).toContain("HTTP 400");
      expect(failed.body.error).not.toContain("test-secret");
    }, { timeout: 5000 });
    const draft = await request(app).get(`/api/course-imports/${id}`).expect(200);
    expect(draft.body.draft.aiStatus).toBe("not-used");
    expect(draft.body.draft.stages).toEqual(uploaded.body.draft.stages);
  });

  it("rejects an invalid .docx file with a clear error", async () => {
    const { app } = await setup();
    // A file with .docx extension but invalid ZIP content
    const invalidDocx = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00]);
    const uploaded = await request(app).post("/api/course-imports").attach("file", invalidDocx, "教学大纲.docx").expect(422);
    expect(uploaded.body.error).toContain("Word");
  });

  it("rejects unsupported extensions before parsing", async () => {
    const { app } = await setup();
    // Verify multer accepts .docx extension
    const noFile = await request(app).post("/api/course-imports").attach("file", Buffer.from("not a zip"), "data.csv").expect(400);
    expect(noFile.body.error).toBe("请选择文件");
  });

  it("accepts .md file and routes to text extraction path", async () => {
    const { app } = await setup();
    const mdContent = Buffer.from("# 课程标题\n## 第一章\n内容");
    const uploaded = await request(app).post("/api/course-imports").attach("file", mdContent, "notes.md").expect(201);
    expect(uploaded.body.draft.title).toBe("课程标题");
    expect(uploaded.body.draft.sourceFormat).toBe("text");
  });

  it("accepts .html file and routes to html extraction path", async () => {
    const { app } = await setup();
    const htmlContent = Buffer.from("<html><body><h1>HTML 课程</h1><p>内容</p></body></html>");
    const uploaded = await request(app).post("/api/course-imports").attach("file", htmlContent, "page.html").expect(201);
    expect(uploaded.body.draft.title).toBe("HTML 课程");
    expect(uploaded.body.draft.sourceFormat).toBe("text");
  });

  it("keeps the original HTML extension and serves the source as HTML", async () => {
    const { app, repository } = await setup();
    const source = "<html><body><h1>网页教程</h1><h2>第一章</h2><p>课程内容</p></body></html>";
    const uploaded = await request(app).post("/api/course-imports").attach("file", Buffer.from(source), "course.html").expect(201);
    const result = await request(app).post(`/api/course-imports/${uploaded.body.id}/confirm`).send({ expectedRevision: uploaded.body.revision }).expect(201);
    const root = repository.config.courses.find((course) => course.id === result.body.courseId)?.root;
    expect(await readFile(path.join(root!, "source.html"), "utf8")).toBe(source);
    const opened = await request(app).get(`/api/courses/${result.body.courseId}/source`).expect("Content-Type", /html/).expect(200);
    expect(opened.headers["content-security-policy"]).toContain("sandbox");
    expect(opened.headers["x-content-type-options"]).toBe("nosniff");
  });
});
