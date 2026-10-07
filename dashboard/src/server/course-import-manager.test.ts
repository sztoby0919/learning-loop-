import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CourseEventBus } from "./course-events.js";
import { CourseImportManager } from "./course-import-manager.js";
import type { ExtractedDocument } from "./course-import.js";
import { WorkspaceRepository } from "./workspace-repository.js";
import { extractPdf } from "./pdf-extractor.js";
import { textPdf } from "../test/pdf-fixtures.js";

const roots: string[] = [];
const managers: CourseImportManager[] = [];
afterEach(async () => {
  managers.forEach((m) => m.stopScheduledCleanup());
  managers.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(source?: ExtractedDocument) {
  const root = await mkdtemp(path.join(os.tmpdir(), "learning-loop-import-"));
  roots.push(root);
  const repository = new WorkspaceRepository({ configPath: path.join(root, "dashboard.config.example.json"), courses: [] }, () => "2026-09-26");
  const watchCourse = vi.fn();
  const manager = new CourseImportManager({ root, repository, events: new CourseEventBus(), watchCourse, today: () => "2026-09-26", extract: async () => source ?? ({ title: "微积分", pageCount: 8, pages: [{ page: 1, text: "第一章 极限 内容" }], outline: [{ title: "第一章 极限", page: 1 }], warnings: [], sourceFormat: "pdf" }) });
  managers.push(manager);
  return { root, repository, manager, watchCourse };
}

describe("course import lifecycle", () => {
  it("imports an outline-free PDF, previews source text and preserves page ranges through saving and confirmation", async () => {
    const bytes = textPdf(["An introduction to learning from data.", "Practice helps test our understanding."]);
    const source = await extractPdf(bytes, "no-outline.pdf");
    expect(source.outline).toEqual([]);
    const { root, manager } = await setup(source);
    const preview = await manager.create(bytes, "no-outline.pdf");
    expect(preview.draft.stages[0].source).toMatchObject({ startPage: 1, endPage: 2 });
    const saved = await manager.update(preview.id, { ...preview.draft, expectedRevision: preview.revision, title: "自学课程" });
    expect(saved.draft.stages[0].source).toEqual(preview.draft.stages[0].source);
    const excerpt = await manager.aiExcerpt(saved.id, { expectedRevision: saved.revision, stageIds: [saved.draft.stages[0].id!] });
    expect(excerpt.pages.map((page) => page.page)).toEqual([1, 2]);
    expect(excerpt.text).toContain("An introduction to learning from data.");
    const result = await manager.confirm(saved.id, saved.revision);
    const markdown = await readFile(path.join(root, "learning-journal", result.courseId, "course.md"), "utf8");
    expect(markdown).toContain("阅读第 1–2 页");
    expect(markdown).toContain("页码分段不代表原书章节");
  });

  it("keeps upload out of the course list until confirmation and then registers it immediately", async () => {
    const { root, repository, manager, watchCourse } = await setup();
    const draft = await manager.create(new Uint8Array(Buffer.from("%PDF-test")), "course.pdf");
    expect((await repository.getCourses()).courses).toEqual([]);
    await manager.update(draft.id, { expectedRevision: draft.revision, title: "我的微积分", goal: "理解极限", weeklyHours: 3, stages: [{ title: "极限", tasks: ["完成第 1 页阅读"] }] });
    const preview = await manager.preview(draft.id);
    const result = await manager.confirm(draft.id, preview.revision);
    expect((await repository.getCourses()).courses[0].title).toBe("我的微积分");
    expect(await readFile(path.join(root, "learning-journal", result.courseId, "course.md"), "utf8")).toBe(preview.files["course.md"]);
    expect(await readFile(path.join(root, "learning-journal", result.courseId, "source.pdf"), "utf8")).toBe("%PDF-test");
    expect(watchCourse).toHaveBeenCalledOnce();
    await expect(manager.confirm(draft.id, preview.revision)).resolves.toEqual(result);
  });

  it("rejects stale editors and preserves server-owned stage source metadata", async () => {
    const { manager } = await setup();
    const preview = await manager.create(new Uint8Array(Buffer.from("%PDF-test")), "book.pdf");
    const input = { ...preview.draft, expectedRevision: preview.revision, title: "Saved edit" };
    const saved = await manager.update(preview.id, input);
    expect(saved.revision).toBe(1);
    expect(saved.draft.stages[0].id).toBe(preview.draft.stages[0].id);
    expect(saved.draft.stages[0].source).toEqual({ title: "第一章 极限", startPage: 1, endPage: 8 });
    await expect(manager.update(preview.id, { ...input, title: "Stale edit" })).rejects.toMatchObject({ status: 409 });
    expect((await manager.preview(preview.id)).draft.title).toBe("Saved edit");
  });

  it("recovers edited drafts and their source in a new manager without re-upload", async () => {
    const { root, repository, manager, watchCourse } = await setup();
    const preview = await manager.create(new Uint8Array(Buffer.from("%PDF-original")), "book.pdf");
    const saved = await manager.update(preview.id, { ...preview.draft, expectedRevision: preview.revision, title: "Recovered title" });
    manager.stopScheduledCleanup();
    const restarted = new CourseImportManager({ root, repository, events: new CourseEventBus(), watchCourse, today: () => "2026-09-26" });
    managers.push(restarted);
    const recovered = await restarted.preview(preview.id);
    expect(recovered.draft.title).toBe("Recovered title");
    expect(recovered.revision).toBe(saved.revision);
    expect(await restarted.list()).toMatchObject([{ id: preview.id, title: "Recovered title" }]);
    expect(await readFile(await restarted.draftSourcePath(preview.id), "utf8")).toBe("%PDF-original");
  });

  it("returns the same created course on repeated confirmation without writing another course", async () => {
    const { manager, repository } = await setup();
    const preview = await manager.create(new Uint8Array(Buffer.from("%PDF-test")), "book.pdf");
    const first = await manager.confirm(preview.id, preview.revision!);
    const second = await manager.confirm(preview.id, preview.revision!);
    expect(second).toEqual(first);
    expect((await repository.getCourses()).courses).toHaveLength(1);
  });

  it("uses unique course IDs for repeated filenames and does not leave a course on cancel", async () => {
    const { root, manager } = await setup();
    const first = await manager.create(new Uint8Array(Buffer.from("%PDF-first")), "same.pdf");
    const second = await manager.create(new Uint8Array(Buffer.from("%PDF-second")), "same.pdf");
    expect(first.courseId).not.toBe(second.courseId);
    await manager.cancel(first.id);
    await expect(manager.preview(first.id)).rejects.toMatchObject({ status: 404 });
    expect(await readdir(path.join(root, "learning-journal")).catch(() => [])).toEqual([]);
  });

  it("never invokes AI without explicit consent and preserves draft when AI fails", async () => {
    const { manager, repository } = await setup();
    const ai = vi.fn().mockRejectedValue(new Error("upstream offline"));
    manager.setAiEnricher(ai);
    const draft = await manager.create(new Uint8Array(Buffer.from("%PDF-test")), "course.pdf");
    const excerpt = await manager.aiExcerpt(draft.id, { expectedRevision: draft.revision, stageIds: [draft.draft.stages[0].id!] });
    const input = { consent: true, expectedRevision: draft.revision, stageIds: excerpt.stageIds, excerptHash: excerpt.excerptHash };
    await expect(manager.startAi(draft.id, { ...input, consent: false })).rejects.toMatchObject({ status: 400 });
    expect(ai).not.toHaveBeenCalled();
    const operation = await manager.startAi(draft.id, input);
    await vi.waitFor(async () => expect((await manager.getAi(draft.id, operation.id)).status).toBe("failed"), { timeout: 5000 });
    const failed = await manager.preview(draft.id);
    expect(failed.draft.aiStatus).toBe("not-used");
    expect(failed.operation?.error).toContain("AI 完善失败");
    expect(failed.revision).toBe(draft.revision);
    await manager.confirm(draft.id, failed.revision);
    expect((await repository.getCourses()).courses).toHaveLength(1);
  }, 15000);

  it("rejects concurrent confirmation instead of racing two writes", async () => {
    const { manager, repository } = await setup();
    const draft = await manager.create(new Uint8Array(Buffer.from("%PDF-test")), "course.pdf");
    const results = await Promise.allSettled([manager.confirm(draft.id, draft.revision), manager.confirm(draft.id, draft.revision)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([{ reason: { status: 409 } }]);
    expect((await repository.getCourses()).courses).toHaveLength(1);
  });

  it("keeps local appendix resource links after repeated AI enrichment and confirmation", async () => {
    const { root, manager } = await setup({ title: "Book", pageCount: 2,
      pages: [{ page: 1, text: "Chapter text" }, { page: 2, text: "Appendix source text" }],
      outline: [{ title: "Chapter 1", page: 1 }, { title: "Appendix A", page: 2 }], warnings: [], sourceFormat: "pdf",
    });
    manager.setAiEnricher(async (excerpt) => excerpt.stageIds.map((stageId) => ({ stageId, title: "Chapter 1", tasks: ["Read chapter"], notes: [{ title: "AI summary", page: 1, content: "Summary" }] })));
    const draft = await manager.create(new Uint8Array(Buffer.from("%PDF-test")), "book.pdf");
    for (let round = 0; round < 2; round += 1) {
      const excerpt = await manager.aiExcerpt(draft.id, { expectedRevision: draft.revision, stageIds: [draft.draft.stages[0].id!] });
      const operation = await manager.startAi(draft.id, { consent: true, expectedRevision: draft.revision, stageIds: excerpt.stageIds, excerptHash: excerpt.excerptHash });
      await vi.waitFor(async () => expect((await manager.getAi(draft.id, operation.id)).status).toBe("complete"), { timeout: 5000 });
    }
    const preview = await manager.preview(draft.id);
    expect(preview.files["resources.md"]).toContain("/source#page=2");
    const result = await manager.confirm(draft.id, preview.revision);
    expect(await readFile(path.join(root, "learning-journal", result.courseId, "resources.md"), "utf8")).toBe(preview.files["resources.md"]);
  }, 15000);

  it("keeps a registered course when post-registration watching fails", async () => {
    const { root, manager, repository, watchCourse } = await setup();
    watchCourse.mockImplementation(() => { throw new Error("watcher unavailable"); });
    const draft = await manager.create(new Uint8Array(Buffer.from("%PDF-test")), "course.pdf");
    const result = await manager.confirm(draft.id, draft.revision);
    expect((await repository.getCourses()).courses).toHaveLength(1);
    expect(await readFile(path.join(root, "learning-journal", result.courseId, "source.pdf"), "utf8")).toBe("%PDF-test");
  });

  it("blocks draft editing during generation and cancels the upstream before deleting a draft", async () => {
    const { manager } = await setup(); let signal!: AbortSignal;
    manager.setAiEnricher(async (_excerpt, _draft, supplied) => { signal = supplied; return new Promise(() => {}); });
    const draft = await manager.create(new Uint8Array(Buffer.from("%PDF-test")), "book.pdf");
    const excerpt = await manager.aiExcerpt(draft.id, { expectedRevision: draft.revision, stageIds: [draft.draft.stages[0].id!] });
    await manager.startAi(draft.id, { consent: true, expectedRevision: draft.revision, stageIds: excerpt.stageIds, excerptHash: excerpt.excerptHash });
    await expect(manager.update(draft.id, { ...draft.draft, expectedRevision: draft.revision })).rejects.toMatchObject({ status: 409 });
    await expect(manager.confirm(draft.id, draft.revision)).rejects.toMatchObject({ status: 409 });
    await manager.cancel(draft.id);
    expect(signal.aborted).toBe(true);
    await expect(manager.preview(draft.id)).rejects.toMatchObject({ status: 404 });
  });

  it("recovers a candidate and its latest undo across manager restart without overwriting later edits", async () => {
    const { manager, root, repository, watchCourse } = await setup();
    manager.setAiEnricher(async (excerpt) => excerpt.stageIds.map((stageId) => ({ stageId, title: "AI title", tasks: ["Read"], notes: [{ title: "AI note", page: 1, content: "Summary" }] })));
    const draft = await manager.create(new Uint8Array(Buffer.from("%PDF-test")), "book.pdf");
    const excerpt = await manager.aiExcerpt(draft.id, { expectedRevision: 0, stageIds: [draft.draft.stages[0].id!] });
    const operation = await manager.startAi(draft.id, { consent: true, expectedRevision: 0, stageIds: excerpt.stageIds, excerptHash: excerpt.excerptHash });
    await vi.waitFor(async () => expect((await manager.getAi(draft.id, operation.id)).status).toBe("complete"), { timeout: 5000 });
    const preview = await manager.preview(draft.id);
    const applied = await manager.applyAi(draft.id, preview.candidate!.id, { expectedRevision: 0, acceptedStageIds: excerpt.stageIds });
    await expect(manager.applyAi(draft.id, preview.candidate!.id, { expectedRevision: 1, acceptedStageIds: excerpt.stageIds })).rejects.toMatchObject({ status: 409 });
    const restarted = new CourseImportManager({ root, repository, events: new CourseEventBus(), watchCourse, today: () => "2026-09-26" }); managers.push(restarted);
    expect((await restarted.preview(draft.id)).canUndo).toBe(true);
    const undone = await restarted.undoAi(draft.id, { expectedRevision: applied.revision });
    expect(undone.draft).toEqual(draft.draft); expect(undone.revision).toBe(2);
    const nextExcerpt = await restarted.aiExcerpt(draft.id, { expectedRevision: 2, stageIds: excerpt.stageIds });
    restarted.setAiEnricher(async () => [{ stageId: excerpt.stageIds[0], title: "New AI title", tasks: ["Read"], notes: [] }]);
    const nextOperation = await restarted.startAi(draft.id, { consent: true, expectedRevision: 2, stageIds: excerpt.stageIds, excerptHash: nextExcerpt.excerptHash });
    await vi.waitFor(async () => expect((await restarted.getAi(draft.id, nextOperation.id)).status).toBe("complete"), { timeout: 5000 });
    const nextPreview = await restarted.preview(draft.id);
    await restarted.applyAi(draft.id, nextPreview.candidate!.id, { expectedRevision: 2, acceptedStageIds: excerpt.stageIds });
    const latest = await restarted.preview(draft.id);
    const edited = await restarted.update(draft.id, { ...latest.draft, expectedRevision: latest.revision, title: "My new edit" });
    await expect(restarted.undoAi(draft.id, { expectedRevision: edited.revision })).rejects.toMatchObject({ status: 409 });
    expect((await restarted.preview(draft.id)).draft.title).toBe("My new edit");
  }, 15000);

  it("rolls back before registration and allows a retry", async () => {
    const { root, manager, repository } = await setup();
    const draft = await manager.create(new Uint8Array(Buffer.from("%PDF-test")), "course.pdf");
    const original = repository.addCourse.bind(repository);
    const addCourse = vi.spyOn(repository, "addCourse").mockRejectedValueOnce(new Error("repository unavailable"));
    await expect(manager.confirm(draft.id, draft.revision)).rejects.toThrow("repository unavailable");
    expect(await readdir(path.join(root, "learning-journal"))).toEqual([]);
    addCourse.mockImplementation(original);
    await expect(manager.confirm(draft.id, (await manager.preview(draft.id)).revision)).resolves.toMatchObject({ courseId: draft.courseId });
  });
});
