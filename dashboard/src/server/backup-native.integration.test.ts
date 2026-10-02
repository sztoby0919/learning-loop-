// @vitest-environment node
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import multer from "multer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BoundFileIo, NativeIoError, backupFileIo } from "./native-file-io.js";
import { BackupZipCodec } from "./backup-zip.js";
import { CourseBackupService } from "./course-backup.js";
import { CourseRestoreManager } from "./course-restore.js";
import { CourseImportManager } from "./course-import-manager.js";
import { WorkspaceRepository } from "./workspace-repository.js";
import { CourseEventBus } from "./course-events.js";
import { createApp } from "./app.js";
import { loadDashboardConfig } from "./dashboard-config.js";
vi.mock("node:fs/promises", { spy: true });
const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
const methods = ["readFile", "writeFile", "lstat", "stat", "realpath", "readdir", "mkdir", "open", "rename", "rm"] as const;
function resetFs() { for (const method of methods) vi.mocked(fs[method]).mockImplementation(actualFs[method] as never); }
beforeEach(resetFs);
const roots: string[] = []; const imports: CourseImportManager[] = [];
afterEach(async () => { vi.restoreAllMocks(); resetFs(); imports.splice(0).forEach((manager) => manager.stopScheduledCleanup()); for (const root of roots.splice(0)) await actualFs.rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learning-loop-native-integration-")); roots.push(root);
  const repository = new WorkspaceRepository({ configPath: path.join(root, "config.json"), courses: [] }, () => "2026-10-02"); const events = new CourseEventBus();
  const manager = new CourseImportManager({ root, repository, events, today: () => "2026-10-02", watchCourse: () => {} }); imports.push(manager);
  const draft = await manager.create(Buffer.from("# 教材\n\n## 章节\n原文"), "book.md"); await manager.confirm(draft.id, draft.revision);
  const codec = new BackupZipCodec(); const backups = new CourseBackupService(repository, manager, codec);
  const restores = new CourseRestoreManager({ root, repository, events, codec, watchCourse: () => {} });
  return { root, repository, manager, events, backups, restores };
}
it.runIf(process.platform === "win32")("the actual ZIP pipeline never falls back to Node path IO, including publication cache registration", async () => {
  const { backups, restores, repository } = await setup();
  for (const method of methods) {
    vi.mocked(fs[method]).mockRejectedValue(new Error(`unsafe Node path IO: ${method}`));
  }
  const archive = await backups.create(); const preview = await restores.create(archive.bytes); await restores.confirm(preview.id);
  expect((await repository.getCourses()).courses).toHaveLength(2);
  const again = await backups.create([preview.courses[0].newId]); expect(again.manifest.courses[0].sourceIncluded).toBe(true);
  const cancelled = await restores.create(again.bytes); await restores.cancel(cancelled.id);
  await expect(restores.preview(cancelled.id)).rejects.toMatchObject({ status: 404 });
}, 30000);
it("an unavailable native capability disables ZIP but not course browsing or ordinary import", async () => {
  const { repository, manager, events, restores } = await setup();
  vi.spyOn(BoundFileIo.prototype, "available").mockRejectedValue(new NativeIoError("Windows 文件辅助进程不可用", 503));
  const app = createApp(repository, events, undefined, manager, "mock", restores);
  await request(app).get("/api/backups/preview").expect(503);
  await request(app).post("/api/restores").attach("file", Buffer.from("bad"), "backup.zip").expect(503);
  expect((await request(app).get("/api/courses").expect(200)).body.courses).toHaveLength(1);
  await request(app).post("/api/course-imports").attach("file", Buffer.from("# 另一个课程\n\n## 章节\n正文"), "book.md").expect(201);
}, 20000);
it("maps ZIP upload-limit errors to the ZIP limit, not the ordinary PDF limit", async () => {
  const { repository, manager, events, restores } = await setup();
  // Exercise our HTTP error mapping with the real upstream error type; this is
  // not a claim that we physically uploaded a 251 MiB archive here.
  vi.spyOn(restores, "create").mockRejectedValue(new multer.MulterError("LIMIT_FILE_SIZE"));
  const response = await request(createApp(repository, events, undefined, manager, "mock", restores)).post("/api/restores").attach("file", Buffer.from("small fixture"), "backup.zip").expect(413);
  expect(response.body.error).toContain("250 MiB"); expect(response.body.error).not.toContain("100 MB");
}, 20000);
it("unavailable restore recovery does not stop healthy imported course discovery", async () => {
  const { root } = await setup(); await fs.writeFile(path.join(root, "config.json"), '{"courses":[]}');
  const unknownRestore = path.join(root, "learning-journal", "restored-unverified"); await fs.mkdir(unknownRestore);
  await fs.writeFile(path.join(unknownRestore, "course.md"), "must not be parsed or discovered");
  vi.spyOn(BoundFileIo.prototype, "available").mockRejectedValue(new NativeIoError("文件辅助进程不可用", 503));
  const config = await loadDashboardConfig(path.join(root, "config.json"), path.join(root, "learning-journal"));
  expect(config.courses).toHaveLength(1); expect(config.courses[0].id).not.toBe("restored-unverified");
}, 20000);
it.each(["notes.md", "source.md", "manifest.json"])("rejects extracted %s changed before copying into the verified staging snapshot", async (name) => {
  const { backups, restores, repository } = await setup(); const archive = await backups.create();
  const original = backupFileIo.readFile.bind(backupFileIo); let changed = false;
  vi.spyOn(backupFileIo, "readFile").mockImplementation(async (filename, limit) => {
    if (!changed && filename.includes(`${path.sep}extracted${path.sep}`) && filename.endsWith(`${path.sep}${name}`)) {
      changed = true; const raw = await actualFs.readFile(filename);
      await actualFs.writeFile(filename, name === "manifest.json" ? JSON.stringify({ ...JSON.parse(raw.toString()), exportedAt: "changed after extraction" }) : Buffer.concat([raw, Buffer.from("\nchanged after extraction\n")]));
    }
    return original(filename, limit);
  });
  await expect(restores.create(archive.bytes)).rejects.toThrow(/SHA|校验|变化/); expect(changed).toBe(true); expect(repository.config.courses).toHaveLength(1);
}, 20000);
