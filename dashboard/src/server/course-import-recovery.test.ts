// @vitest-environment node
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DraftEntry } from "../shared/course-import.js";
import { buildCourseFiles, createBasicDraft } from "./course-import.js";
import { DraftStore } from "./course-import-store.js";
import { recoverImportCommits, stageImportCourse } from "./course-import-recovery.js";
import { loadDashboardConfig } from "./dashboard-config.js";
import { CourseImportManager } from "./course-import-manager.js";
import { CourseEventBus } from "./course-events.js";
import { WorkspaceRepository } from "./workspace-repository.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learning-loop-commit-recovery-")); roots.push(root);
  const id = randomUUID(); const now = Date.now();
  const source = { title: "Book", pageCount: 1, pages: [{ page: 1, text: "Chapter text" }], outline: [{ title: "Chapter 1", page: 1 }], sourceFormat: "pdf" as const, warnings: [] };
  const entry: DraftEntry = { version: 1, id, courseId: `course-${id.slice(0, 8)}`, revision: 0, createdAt: now, updatedAt: now, expiresAt: now + 7 * 86400000, state: "open", draft: createBasicDraft(source, "book.pdf"), source, sourceExtension: ".pdf" };
  const store = new DraftStore(root); const bytes = new Uint8Array(Buffer.from("%PDF-original"));
  await store.create(entry, bytes);
  const committing: DraftEntry = { ...entry, revision: 1, state: "committing" };
  await store.replace(committing, 0);
  return { root, store, entry: committing, bytes, files: buildCourseFiles(entry.draft, entry.courseId, "2026-10-01") };
}

describe("interrupted course import recovery", () => {
  it.each([[true, "broken"], [false, "broken"], [true, "missing"], [false, "missing"]] as const)("isolates a damaged snapshot with a valid journal (published=%s, snapshot=%s) and keeps its data", async (published, damage) => {
    const { root, store, entry, bytes, files } = await setup();
    const transaction = await stageImportCourse(root, entry, files, bytes);
    await fs.mkdir(path.join(root, "learning-journal"));
    if (published) await fs.rename(transaction.stagedPath, transaction.coursePath);
    const snapshot = path.join(root, ".learning-loop", "imports", entry.id, "state.json");
    if (damage === "broken") await fs.writeFile(snapshot, "{broken");
    else await fs.unlink(snapshot);
    const healthyId = randomUUID();
    await store.create({ ...entry, id: healthyId, courseId: `course-${healthyId}`, revision: 0, state: "open" }, bytes);
    const configPath = path.join(root, "config.json");
    await fs.writeFile(configPath, JSON.stringify({ courses: [] }));
    const healthy = path.join(root, "learning-journal", "healthy-course");
    await fs.mkdir(healthy);
    await fs.writeFile(path.join(healthy, "course.md"), "---\nid: healthy-course\n---\n# Healthy course\n");
    const issues = await recoverImportCommits(root);
    expect(issues).toEqual([expect.objectContaining({ id: entry.id, courseId: entry.courseId })]);
    const config = await loadDashboardConfig(configPath, path.join(root, "learning-journal"));
    expect(config.courses.map((course) => course.id)).toEqual(["healthy-course"]);
    expect(await fs.readFile(transaction.journalPath, "utf8")).toContain(entry.id);
    expect(await fs.readFile(path.join(published ? transaction.coursePath : transaction.stagedPath, "source.pdf"), "utf8")).toBe("%PDF-original");
    const today = () => "2026-10-02";
    const manager = new CourseImportManager({ root, repository: new WorkspaceRepository(config, today), events: new CourseEventBus(), today, watchCourse: () => {} });
    try {
      await manager.initialize();
      expect(await manager.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: healthyId, status: "ready" }),
        expect.objectContaining({ id: entry.id, status: "invalid", warning: expect.stringContaining("恢复失败") }),
      ]));
      await expect(manager.preview(healthyId)).resolves.toMatchObject({ id: healthyId });
      await expect(manager.cancel(entry.id)).rejects.toMatchObject({ status: 409 });
      expect(await fs.readFile(transaction.journalPath, "utf8")).toContain(entry.id);
    } finally { manager.stopScheduledCleanup(); }
  });

  it("rolls back an unpublished stage and reopens the existing draft", async () => {
    const { root, store, entry, bytes, files } = await setup();
    const transaction = await stageImportCourse(root, entry, files, bytes);
    await recoverImportCommits(root);
    expect((await store.read(entry.id)).state).toBe("open");
    expect(await fs.readFile(await store.sourcePath(entry.id), "utf8")).toBe("%PDF-original");
    await expect(fs.stat(transaction.stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(path.join(root, "learning-journal")).catch(() => [])).toEqual([]);
  });

  it("keeps a fully published course after a crash before repository registration", async () => {
    const { root, store, entry, bytes, files } = await setup();
    const transaction = await stageImportCourse(root, entry, files, bytes);
    await fs.mkdir(path.join(root, "learning-journal"));
    await fs.rename(transaction.stagedPath, transaction.coursePath);
    await recoverImportCommits(root);
    expect((await store.read(entry.id)).state).toBe("committed");
    expect(await fs.readFile(path.join(transaction.coursePath, "course.md"), "utf8")).toBe(files["course.md"]);
    expect(await fs.readFile(path.join(transaction.coursePath, "source.pdf"), "utf8")).toBe("%PDF-original");
    await recoverImportCommits(root);
    expect(await fs.readdir(path.join(root, "learning-journal"))).toEqual([entry.courseId]);
  });

  it("never deletes or claims a pre-existing course with the same ID", async () => {
    const { root, store, entry, bytes, files } = await setup();
    const transaction = await stageImportCourse(root, entry, files, bytes);
    await fs.mkdir(transaction.coursePath, { recursive: true });
    await fs.writeFile(path.join(transaction.coursePath, "keep.txt"), "existing user data");
    await recoverImportCommits(root);
    expect(await fs.readFile(path.join(transaction.coursePath, "keep.txt"), "utf8")).toBe("existing user data");
    expect((await store.read(entry.id)).state).toBe("open");
  });

  it("reopens a claiming snapshot interrupted before any stage was created", async () => {
    const { root, store, entry } = await setup();
    await recoverImportCommits(root);
    expect((await store.read(entry.id)).state).toBe("open");
  });
});
