// @vitest-environment node
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { CourseImportManager } from "./course-import-manager.js";
import { canonicalTempRoot } from "./native-test-support.js";
import { CourseEventBus } from "./course-events.js";
import { WorkspaceRepository } from "./workspace-repository.js";
import { CourseBackupService } from "./course-backup.js";
import { CourseRestoreManager } from "./course-restore.js";
import { BackupZipCodec } from "./backup-zip.js";
import { createHash } from "node:crypto";
import { remapCourseFiles } from "./course-id-remap.js";
import { courseMatterEngines } from "./safe-course-matter.js";
const roots: string[] = []; const imports: CourseImportManager[] = [];
afterEach(async () => { imports.splice(0).forEach((manager) => manager.stopScheduledCleanup()); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
async function setup() {
  const root = await canonicalTempRoot("learning-loop-restore-"); roots.push(root);
  const today = () => "2026-10-02"; const repository = new WorkspaceRepository({ configPath: path.join(root, "config.json"), courses: [] }, today); const events = new CourseEventBus();
  const manager = new CourseImportManager({ root, repository, events, today, watchCourse: () => {} }); imports.push(manager);
  const draft = await manager.create(new TextEncoder().encode("# 教材\n\n## 章节\n正文"), "book.md"); const { courseId } = await manager.confirm(draft.id, draft.revision);
  const codec = new BackupZipCodec(); const backup = await new CourseBackupService(repository, manager, codec).create();
  const restores = new CourseRestoreManager({ root, repository, events, codec, watchCourse: () => {} });
  return { root, repository, manager, courseId, backup, restores, events, codec };
}
describe("verified restore as new courses", () => {
  it.each(["course.md", "notes.md", "sessions/plain.md"])("rejects executable frontmatter before any engine invocation in %s", async (file) => {
    const { backup, restores, courseId } = await setup();
    const zip = await JSZip.loadAsync(backup.bytes); const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    // Stub the unsafe engine: this defensive test never executes uploaded code.
    const engine = vi.spyOn(courseMatterEngines.javascript, "parse").mockReturnValue({});
    const content = `---javascript\n{}\n---\n# ${file}\n`;
    const name = `courses/${courseId}/${file}`; zip.file(name, content, { createFolders: false });
    manifest.courses[0].files = manifest.courses[0].files.filter((entry: { path: string }) => entry.path !== name);
    manifest.courses[0].files.push({ path: name, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") });
    zip.file("manifest.json", JSON.stringify(manifest));
    await expect(restores.create(await zip.generateAsync({ type: "uint8array" }))).rejects.toThrow(/YAML|frontmatter/);
    expect(engine).not.toHaveBeenCalled();
  });
  it.each(["invalid-course", "cross-association", "optional-missing"])("validates Markdown beyond checksum: %s", async (kind) => {
    const { backup, restores, courseId, repository } = await setup();
    const zip = await JSZip.loadAsync(backup.bytes); const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    const name = `courses/${courseId}/${kind === "invalid-course" ? "course.md" : "notes.md"}`;
    if (kind === "optional-missing") { zip.remove(name); manifest.courses[0].files = manifest.courses[0].files.filter((file: { path: string }) => file.path !== name); }
    else {
      const original = await zip.file(name)!.async("string");
      const modified = kind === "invalid-course" ? original.replace(/^title:.*$/m, "title: ''") : original.replace(/^courseId:.*$/m, "courseId: other-course");
      zip.file(name, modified); const entry = manifest.courses[0].files.find((file: { path: string }) => file.path === name);
      entry.bytes = Buffer.byteLength(modified); entry.sha256 = createHash("sha256").update(modified).digest("hex");
    }
    zip.file("manifest.json", JSON.stringify(manifest)); const bytes = await zip.generateAsync({ type: "uint8array" });
    if (kind === "optional-missing") {
      const preview = await restores.create(bytes); expect(preview.courses[0].warnings.join(" ")).toContain("缺少 notes.md");
      await restores.confirm(preview.id); expect(repository.config.courses).toHaveLength(2);
    } else { await expect(restores.create(bytes)).rejects.toThrow(/课程|title|不一致/); expect(repository.config.courses).toHaveLength(1); }
  });
  it("restores the full fifty-course archive as new IDs in one batch", async () => {
    const { backup, restores, courseId, repository } = await setup();
    const original = await JSZip.loadAsync(backup.bytes); const manifest = JSON.parse(await original.file("manifest.json")!.async("string"));
    const originalCourse = manifest.courses[0]; const zip = new JSZip(); manifest.courses = [];
    const markdown: Record<string, string> = {};
    for (const file of originalCourse.files) if (!file.path.endsWith("/source.md")) markdown[file.path.slice(`courses/${courseId}/`.length)] = await original.file(file.path)!.async("string");
    const source = await original.file(`courses/${courseId}/source.md`)!.async("uint8array");
    for (let index = 0; index < 50; index++) {
      const id = `sample-${index}`; const files = [];
      for (const [name, value] of Object.entries(remapCourseFiles(markdown, courseId, id))) {
        const content = Buffer.from(value); const nameInZip = `courses/${id}/${name}`;
        zip.file(nameInZip, content, { createFolders: false }); files.push({ path: nameInZip, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
      }
      const sourcePath = `courses/${id}/source.md`; zip.file(sourcePath, source, { createFolders: false });
      files.push({ path: sourcePath, bytes: source.length, sha256: createHash("sha256").update(source).digest("hex") });
      manifest.courses.push({ ...originalCourse, id, files });
    }
    zip.file("manifest.json", JSON.stringify(manifest), { createFolders: false });
    const preview = await restores.create(await zip.generateAsync({ type: "uint8array" }));
    expect(preview.courses).toHaveLength(50); expect(new Set(preview.courses.map((course) => course.newId)).size).toBe(50);
    await restores.confirm(preview.id); expect(repository.config.courses).toHaveLength(51);
  }, 30000);
  it("previews without publication, persists across manager restart and confirms idempotently without changing original", async () => {
    const { root, repository, events, codec, courseId, backup, restores } = await setup();
    const before = await readFile(path.join(root, "learning-journal", courseId, "course.md"), "utf8");
    const preview = await restores.create(backup.bytes);
    expect(repository.config.courses).toHaveLength(1);
    expect(preview.courses[0]).toMatchObject({ originalId: courseId, sourceIncluded: true, fileCount: 6 });
    expect(preview.courses[0].newId).not.toBe(courseId);
    const restarted = new CourseRestoreManager({ root, repository, events, codec, watchCourse: () => {} });
    expect(await restarted.preview(preview.id)).toEqual(preview);
    const result = await restarted.confirm(preview.id);
    expect(result.courseIds).toEqual([preview.courses[0].newId]);
    expect(await restarted.confirm(preview.id)).toEqual(result);
    expect(repository.config.courses).toHaveLength(2);
    expect(await readFile(path.join(root, "learning-journal", courseId, "course.md"), "utf8")).toBe(before);
    expect(await readFile(path.join(root, "learning-journal", result.courseIds[0], "source.md"))).toEqual(await readFile(path.join(root, "learning-journal", courseId, "source.md")));
  });
  it.each(["checksum", "version", "association", "missing-core"])("rejects invalid archive %s without publication", async (kind) => {
    const { root, repository, backup, restores, courseId } = await setup();
    const zip = await JSZip.loadAsync(backup.bytes); const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    if (kind === "checksum") manifest.courses[0].files[0].sha256 = "0".repeat(64);
    if (kind === "version") manifest.version = 2;
    if (kind === "association") manifest.courses[0].id = "wrong-course";
    if (kind === "missing-core") zip.remove(`courses/${courseId}/course.md`);
    zip.file("manifest.json", JSON.stringify(manifest));
    await expect(restores.create(await zip.generateAsync({ type: "uint8array" }))).rejects.toThrow(/校验|版本|课程|manifest|文件/);
    expect(repository.config.courses).toHaveLength(1);
    expect(await readdir(path.join(root, "learning-journal"))).toEqual([courseId]);
  });
  it("cancels and expires only its own preview after twenty-four hours", async () => {
    const { root, repository, backup, events, codec } = await setup(); let now = Date.now();
    const restores = new CourseRestoreManager({ root, repository, events, codec, now: () => now, watchCourse: () => {} });
    const preview = await restores.create(backup.bytes); expect(preview.expiresAt).toBe(now + 86400000);
    now += 86400000;
    await expect(restores.confirm(preview.id)).rejects.toMatchObject({ status: 410 });
    await restores.cleanupExpired(); expect(repository.config.courses).toHaveLength(1);
    now = Date.now(); const cancelled = await restores.create(backup.bytes); await restores.cancel(cancelled.id);
    await expect(restores.preview(cancelled.id)).rejects.toMatchObject({ status: 404 });
  });
  it("rolls back the whole batch when registration fails, and preserves old courses", async () => {
    const { root, repository, backup, restores, courseId } = await setup();
    const preview = await restores.create(backup.bytes);
    vi.spyOn(repository, "addCourses").mockRejectedValueOnce(new Error("registration failed"));
    await expect(restores.confirm(preview.id)).rejects.toThrow(/registration/);
    expect(await readdir(path.join(root, "learning-journal"))).toEqual([courseId]);
    expect(repository.config.courses).toHaveLength(1);
  });
});
