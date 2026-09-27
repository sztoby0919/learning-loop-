import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CourseEventBus } from "./course-events.js";
import { CourseImportManager } from "./course-import-manager.js";
import { WorkspaceRepository } from "./workspace-repository.js";

const roots: string[] = [];
const managers: CourseImportManager[] = [];
afterEach(async () => {
  managers.forEach((m) => m.stopScheduledCleanup());
  managers.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "learning-loop-import-"));
  roots.push(root);
  const repository = new WorkspaceRepository({ configPath: path.join(root, "dashboard.config.example.json"), courses: [] }, () => "2026-09-26");
  const watchCourse = vi.fn();
  const manager = new CourseImportManager({ root, repository, events: new CourseEventBus(), watchCourse, today: () => "2026-09-26", extract: async () => ({ title: "微积分", pageCount: 8, pages: [{ page: 1, text: "第一章 极限 内容" }], outline: [{ title: "第一章 极限", page: 1 }], warnings: [], sourceFormat: "pdf" }) });
  managers.push(manager);
  return { root, repository, manager, watchCourse };
}

describe("course import lifecycle", () => {
  it("keeps upload out of the course list until confirmation and then registers it immediately", async () => {
    const { root, repository, manager, watchCourse } = await setup();
    const draft = await manager.create(new Uint8Array(Buffer.from("%PDF-test")), "course.pdf");
    expect((await repository.getCourses()).courses).toEqual([]);
    await manager.update(draft.id, { title: "我的微积分", goal: "理解极限", weeklyHours: 3, stages: [{ title: "极限", tasks: ["完成第 1 页阅读"] }] });
    const preview = manager.preview(draft.id);
    const result = await manager.confirm(draft.id);
    expect((await repository.getCourses()).courses[0].title).toBe("我的微积分");
    expect(await readFile(path.join(root, "learning-journal", result.courseId, "course.md"), "utf8")).toBe(preview.files["course.md"]);
    expect(await readFile(path.join(root, "learning-journal", result.courseId, "source.pdf"), "utf8")).toBe("%PDF-test");
    expect(watchCourse).toHaveBeenCalledOnce();
    await expect(manager.confirm(draft.id)).rejects.toMatchObject({ status: 409 });
  });

  it("uses unique course IDs for repeated filenames and does not leave a course on cancel", async () => {
    const { root, manager } = await setup();
    const first = await manager.create(new Uint8Array(Buffer.from("%PDF-first")), "same.pdf");
    const second = await manager.create(new Uint8Array(Buffer.from("%PDF-second")), "same.pdf");
    expect(first.courseId).not.toBe(second.courseId);
    await manager.cancel(first.id);
    expect(() => manager.preview(first.id)).toThrowError();
    expect(await readdir(path.join(root, "learning-journal")).catch(() => [])).toEqual([]);
  });

  it("never invokes AI without explicit consent and preserves draft when AI fails", async () => {
    const { manager, repository } = await setup();
    const ai = vi.fn().mockRejectedValue(new Error("upstream offline"));
    manager.setAiEnricher(ai);
    const draft = await manager.create(new Uint8Array(Buffer.from("%PDF-test")), "course.pdf");
    await expect(manager.enrich(draft.id, false)).rejects.toMatchObject({ status: 400 });
    expect(ai).not.toHaveBeenCalled();
    await expect(manager.enrich(draft.id, true)).rejects.toThrow("upstream offline");
    expect(manager.preview(draft.id).draft.aiStatus).toBe("failed");
    await manager.confirm(draft.id);
    expect((await repository.getCourses()).courses).toHaveLength(1);
  });

  it("rejects concurrent confirmation instead of racing two writes", async () => {
    const { manager, repository } = await setup();
    const draft = await manager.create(new Uint8Array(Buffer.from("%PDF-test")), "course.pdf");
    const results = await Promise.allSettled([manager.confirm(draft.id), manager.confirm(draft.id)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([{ reason: { status: 409 } }]);
    expect((await repository.getCourses()).courses).toHaveLength(1);
  });

  it("keeps a registered course when post-registration watching fails", async () => {
    const { root, manager, repository, watchCourse } = await setup();
    watchCourse.mockImplementation(() => { throw new Error("watcher unavailable"); });
    const draft = await manager.create(new Uint8Array(Buffer.from("%PDF-test")), "course.pdf");
    const result = await manager.confirm(draft.id);
    expect((await repository.getCourses()).courses).toHaveLength(1);
    expect(await readFile(path.join(root, "learning-journal", result.courseId, "source.pdf"), "utf8")).toBe("%PDF-test");
  });

  it("rolls back before registration and allows a retry", async () => {
    const { root, manager, repository } = await setup();
    const draft = await manager.create(new Uint8Array(Buffer.from("%PDF-test")), "course.pdf");
    const original = repository.addCourse.bind(repository);
    const addCourse = vi.spyOn(repository, "addCourse").mockRejectedValueOnce(new Error("repository unavailable"));
    await expect(manager.confirm(draft.id)).rejects.toThrow("repository unavailable");
    expect(await readdir(path.join(root, "learning-journal"))).toEqual([]);
    addCourse.mockImplementation(original);
    await expect(manager.confirm(draft.id)).resolves.toMatchObject({ courseId: draft.courseId });
  });
});
