// @vitest-environment node
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CourseImportManager } from "./course-import-manager.js";
import { WorkspaceRepository } from "./workspace-repository.js";
import { CourseEventBus } from "./course-events.js";
import { CourseBackupService } from "./course-backup.js";
import { BackupZipCodec } from "./backup-zip.js";
import { CourseRestoreManager } from "./course-restore.js";
import { loadDashboardConfig } from "./dashboard-config.js";
import { readRestoreState, writeRestoreState, stagedDirectory, publishedDirectory, recoverRestoreTransactions } from "./course-restore-recovery.js";
import { backupFileIo } from "./native-file-io.js";
vi.mock("node:fs/promises", { spy: true });
const roots: string[] = []; const imports: CourseImportManager[] = [];
afterEach(async () => { vi.restoreAllMocks(); imports.splice(0).forEach((manager) => manager.stopScheduledCleanup()); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learning-loop-restore-recovery-")); roots.push(root);
  await fs.writeFile(path.join(root, "config.json"), '{"courses":[]}');
  const repository = new WorkspaceRepository({ configPath: path.join(root, "config.json"), courses: [] }, () => "2026-10-02");
  const events = new CourseEventBus(); const codec = new BackupZipCodec();
  const manager = new CourseImportManager({ root, repository, events, today: () => "2026-10-02", watchCourse: () => {} }); imports.push(manager);
  for (const title of ["课程一", "课程二"]) { const draft = await manager.create(new TextEncoder().encode(`# ${title}\n\n## 章节\n原文`), "book.md"); await manager.confirm(draft.id, draft.revision); }
  const restores = new CourseRestoreManager({ root, repository, events, codec, watchCourse: () => {} });
  const preview = await restores.create((await new CourseBackupService(repository, manager, codec).create()).bytes);
  return { root, repository, preview, restores };
}
describe("durable whole-batch restore publication", () => {
  it("cleans an interrupted preparation without blocking healthy course discovery", async () => {
    const { root, preview } = await fixture(); const state = await readRestoreState(root, preview.id);
    await writeRestoreState(root, { ...state, phase: "preparing", courses: [] });
    await recoverRestoreTransactions(root);
    expect((await loadDashboardConfig(path.join(root, "config.json"), path.join(root, "learning-journal"))).courses).toHaveLength(2);
    await expect(readRestoreState(root, preview.id)).rejects.toMatchObject({ status: 404 });
  });
  it("excludes every pending course before discovery and rolls an interrupted first rename back on restart", async () => {
    const { root, preview } = await fixture(); const state = await readRestoreState(root, preview.id);
    await writeRestoreState(root, { ...state, phase: "publishing" });
    await fs.rename(stagedDirectory(root, state, state.courses[0].newId), publishedDirectory(root, state.courses[0].newId));
    expect((await loadDashboardConfig(path.join(root, "config.json"), path.join(root, "learning-journal"))).courses).toHaveLength(2);
    await recoverRestoreTransactions(root);
    expect(await fs.readdir(path.join(root, "learning-journal"))).toHaveLength(2);
    expect((await readRestoreState(root, preview.id)).phase).toBe("open");
  });
  it("moves the first new course back when the second publish rename fails and allows retry", async () => {
    const { root, repository, preview, restores } = await fixture();
    const actual = backupFileIo.moveDirectory.bind(backupFileIo);
    const failure = vi.spyOn(backupFileIo, "moveDirectory").mockImplementation(async (from, to, owner) => {
      if (from.endsWith(preview.courses[1].newId) && to.includes("learning-journal")) throw new Error("second publish failed");
      return actual(from, to, owner);
    });
    await expect(restores.confirm(preview.id)).rejects.toThrow("second publish failed");
    expect(await fs.readdir(path.join(root, "learning-journal"))).toHaveLength(2);
    expect(repository.config.courses).toHaveLength(2);
    failure.mockRestore(); await restores.confirm(preview.id);
    expect(repository.config.courses).toHaveLength(4);
  });
  it("keeps a committed batch on restart and permits normal later note edits", async () => {
    const { root, preview, restores } = await fixture(); await restores.confirm(preview.id);
    const note = path.join(root, "learning-journal", preview.courses[0].newId, "notes.md");
    await fs.writeFile(note, (await fs.readFile(note, "utf8")) + "\n用户正常编辑\n");
    await recoverRestoreTransactions(root);
    const config = await loadDashboardConfig(path.join(root, "config.json"), path.join(root, "learning-journal"));
    expect(config.courses).toHaveLength(4); expect(await fs.readFile(note, "utf8")).toContain("用户正常编辑");
  });
  it("does not roll back committed courses when watcher registration throws", async () => {
    const { root, preview, restores } = await fixture();
    restores.options.watchCourse = () => { throw new Error("watcher unavailable"); };
    await expect(restores.confirm(preview.id)).resolves.toEqual({ courseIds: preview.courses.map((course) => course.newId) });
    expect(await fs.readdir(path.join(root, "learning-journal"))).toHaveLength(4);
  });
});
