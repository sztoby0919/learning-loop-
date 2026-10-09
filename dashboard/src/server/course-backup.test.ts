// @vitest-environment node
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CourseEventBus } from "./course-events.js";
import { canonicalTempRoot } from "./native-test-support.js";
import { CourseImportManager } from "./course-import-manager.js";
import { WorkspaceRepository } from "./workspace-repository.js";
import { CourseBackupService } from "./course-backup.js";
import { BackupZipCodec } from "./backup-zip.js";
import { backupFileIo } from "./native-file-io.js";
const roots: string[] = []; const managers: CourseImportManager[] = [];
vi.mock("node:fs/promises", { spy: true });
afterEach(async () => { managers.splice(0).forEach((manager) => manager.stopScheduledCleanup()); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
async function setup() {
  const root = await canonicalTempRoot("learning-loop-backup-"); roots.push(root);
  const today = () => "2026-10-02"; const repository = new WorkspaceRepository({ configPath: path.join(root, "config.json"), courses: [] }, today);
  const imports = new CourseImportManager({ root, repository, events: new CourseEventBus(), today, watchCourse: () => {} }); managers.push(imports);
  const draft = await imports.create(new TextEncoder().encode("# 教材\n\n## 第一章\n原文内容"), "book.md");
  const { courseId } = await imports.confirm(draft.id, draft.revision);
  const courseRoot = path.join(root, "learning-journal", courseId);
  return { root, repository, imports, courseId, courseRoot, service: new CourseBackupService(repository, imports, new BackupZipCodec()) };
}
describe("safe course backup snapshot", () => {
  it("backs up five files, sessions and managed source with hashes, but never external or private extras", async () => {
    const { root, courseRoot, courseId, service } = await setup();
    await writeFile(path.join(courseRoot, ".env"), "private secret");
    await writeFile(path.join(courseRoot, "other.json"), "private config");
    await writeFile(path.join(courseRoot, "sessions", "lesson.md"), `---\ncourseId: ${courseId}\n---\n# 原始记录\n`);
    const backup = await service.create();
    expect(backup.manifest.courses).toHaveLength(1);
    expect(backup.manifest.courses[0]).toMatchObject({ id: courseId, sourceIncluded: true });
    expect(backup.manifest.courses[0].files).toHaveLength(7);
    const output = path.join(root, "decoded"); const decoded = await new BackupZipCodec().decodeToDirectory(backup.bytes, output);
    expect(decoded.map((entry) => path.posix.basename(entry.path))).not.toContain(".env");
    const bytes = await readFile(path.join(output, "courses", courseId, "source.md"));
    expect(backup.manifest.courses[0].files.find((file) => file.path.endsWith("source.md"))).toMatchObject({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  });
  it("allows a manual course without source and explains missing assets", async () => {
    const { repository, courseRoot, imports, courseId } = await setup();
    const manualRoot = path.join(path.dirname(path.dirname(courseRoot)), "manual"); await mkdir(manualRoot);
    await writeFile(path.join(manualRoot, "course.md"), await readFile(path.join(courseRoot, "course.md")));
    repository.config.courses = [{ id: courseId, root: manualRoot, enabled: true }];
    const manifest = await new CourseBackupService(repository, imports, new BackupZipCodec()).preview([courseId]);
    expect(manifest.courses[0].sourceIncluded).toBe(false);
    expect(manifest.courses[0].warnings.join(" ")).toContain("原课件");
  });
  it("rejects unknown selection and more than fifty courses", async () => {
    const { repository, service, courseRoot } = await setup();
    await expect(service.preview(["unknown"])).rejects.toThrow(/未知/);
    repository.config.courses = Array.from({ length: 51 }, (_, index) => ({ id: `course-${index}`, root: courseRoot, enabled: true }));
    await expect(service.preview()).rejects.toThrow(/50|数量/);
  });
  it("rejects a file changed between native snapshot reads instead of emitting a mixed backup", async () => {
    const { courseRoot, service } = await setup();
    const target = path.join(courseRoot, "course.md"); const original = backupFileIo.readFile.bind(backupFileIo); let reads = 0;
    vi.spyOn(backupFileIo, "readFile").mockImplementation(async (filename, limit) => {
      const result = await original(filename, limit);
      if (filename === target && ++reads === 1) await writeFile(target, "changed between reads");
      return result;
    });
    await expect(service.create()).rejects.toThrow(/变化/);
  });
  it.for(["course.md", "source.md", "sessions"])("rejects linked %s rather than silently following it", async (name, context) => {
    const { root, courseRoot, service } = await setup(); const candidate = path.join(courseRoot, name);
    const outside = path.join(root, "outside"); await mkdir(outside); await writeFile(path.join(outside, "secret"), "keep");
    await rm(candidate, { recursive: name === "sessions" });
    try { await symlink(name === "sessions" ? outside : path.join(outside, "secret"), candidate, name === "sessions" ? "junction" : "file"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { context.skip(); return; } throw error; }
    await expect(service.create()).rejects.toThrow(/链接|不安全/);
    expect(await readFile(path.join(outside, "secret"), "utf8")).toBe("keep");
  });
});
