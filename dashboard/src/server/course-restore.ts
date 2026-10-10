import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { BACKUP_LIMITS, type RestorePreview, type ZipCodec } from "../shared/course-backup.js";
import type { WorkspaceRepository } from "./workspace-repository.js";
import type { CourseEventBus } from "./course-events.js";
import { BackupError, archiveFileLimit, validateArchivePath } from "./backup-zip.js";
import { readBackupFile } from "./course-backup.js";
import { remapCourseFiles } from "./course-id-remap.js";
import { parseCourseMarkdown } from "./course-parser.js";
import { parseNotesMarkdown, parseResourcesMarkdown, parseReviewsMarkdown, parseScheduleMarkdown } from "./artifact-parser.js";
import { validateSessionMarkdown } from "./session-records.js";
import { safeCourseMatter } from "./safe-course-matter.js";
import { cleanupRestorePreviews, ensureRestoreDirectory, directoryExists, writeBackupFile, restoreOwner, publicRestorePreview, publishedDirectory, readRestoreState, recoverRestoreTransactions, restoreDirectory, restoreHome, rollbackRestore, sha256, stagedDirectory, verifyRestoreCourse, withRestoreLock, writeRestoreState, type RestoreState } from "./course-restore-recovery.js";
import { backupFileIo } from "./native-file-io.js";
import { sourceDocuments, sourceFilePattern } from "./course-bundle-files.js";

const manifestSchema = z.object({ format: z.literal("learning-loop-backup"), version: z.literal(1), exportedAt: z.string().max(100), courses: z.array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/), title: z.string().max(10000), sourceIncluded: z.boolean(), warnings: z.array(z.string().max(10000)).max(100), files: z.array(z.object({ path: z.string().max(400), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(1999) }).strict()).min(1).max(50) }).strict();

function validateMarkdown(files: Record<string, string>, courseId: string): string[] {
  for (const raw of Object.values(files)) safeCourseMatter(raw);
  const warnings: string[] = [];
  const course = parseCourseMarkdown(files["course.md"], "course.md");
  if (course.id !== courseId) throw new BackupError("课程 ID 与归档不一致");
  warnings.push(...course.warnings);
  for (const name of ["notes", "reviews", "resources", "schedule"] as const) {
    if (files[`${name}.md`] === undefined) { warnings.push(`缺少 ${name}.md，按手工课程保留为空`); continue; }
    const parser = { notes: parseNotesMarkdown, reviews: (raw: string, file: string) => parseReviewsMarkdown(raw, file, "1970-01-01"), resources: parseResourcesMarkdown, schedule: parseScheduleMarkdown }[name];
    const parsed = parser(files[`${name}.md`], `${name}.md`);
    if (parsed.courseId !== courseId) throw new BackupError(`${name} courseId 与课程不一致`);
    warnings.push(...parsed.warnings);
  }
  for (const [file, raw] of Object.entries(files)) if (file.startsWith("sessions/")) validateSessionMarkdown(raw, file.slice(9), courseId);
  return warnings.slice(0, 100);
}

export class CourseRestoreManager {
  private cleanupTimer?: ReturnType<typeof setInterval>;
  constructor(readonly options: { root: string; repository: WorkspaceRepository; events: CourseEventBus; watchCourse: (root: string) => void; codec: ZipCodec; now?: () => number }) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  async initialize(): Promise<void> {
    await recoverRestoreTransactions(this.options.root); await this.cleanupExpired();
    if (!this.cleanupTimer) { this.cleanupTimer = setInterval(() => { void this.cleanupExpired().catch(() => {}); }, 3600000); this.cleanupTimer.unref(); }
  }
  stopScheduledCleanup(): void { if (this.cleanupTimer) clearInterval(this.cleanupTimer); this.cleanupTimer = undefined; }
  async create(bytes: Uint8Array): Promise<RestorePreview> {
    await backupFileIo.available();
    return withRestoreLock(this.options.root, () => this.prepare(bytes));
  }
  private async prepare(bytes: Uint8Array): Promise<RestorePreview> {
    const { root, codec } = this.options; const id = randomUUID(); const token = randomUUID();
    await ensureRestoreDirectory(restoreHome(root)); const directory = restoreDirectory(root, id);
    const owner = { id, token, newId: id }; await backupFileIo.createOwnedDirectory(directory, owner); let complete = false;
    try {
      const createdAt = this.now();
      await writeRestoreState(root, { version: 1, id, token, createdAt, expiresAt: createdAt + 86400000, phase: "preparing", courses: [] });
      const extracted = path.join(directory, "extracted"); const decoded = await codec.decodeToDirectory(bytes, extracted, BACKUP_LIMITS, { ...owner, newId: "extracted" });
      const rawManifest = (await readBackupFile(path.join(extracted, "manifest.json"), BACKUP_LIMITS.manifestBytes)).bytes;
      const manifestEntry = decoded.find((entry) => entry.path === "manifest.json");
      if (!manifestEntry || rawManifest.length !== manifestEntry.bytes || sha256(rawManifest) !== manifestEntry.sha256) throw new BackupError("manifest 在解压后发生变化，SHA-256 校验失败");
      let manifest;
      try { manifest = manifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawManifest))); }
      catch { throw new BackupError("manifest 文件或备份版本校验失败"); }
      if (new Set(manifest.courses.map((course) => course.id)).size !== manifest.courses.length) throw new BackupError("manifest 课程重复");
      const actual = new Map(decoded.map((entry) => [entry.path, entry])); const claimed = new Set(["manifest.json"]);
      const state: RestoreState = { version: 1, id, token, createdAt, expiresAt: createdAt + 86400000, phase: "open", courses: [] };
      await backupFileIo.ensureDirectory(path.join(directory, "courses"));
      for (const course of manifest.courses) {
        const originals: Record<string, string> = {}; const newId = `restored-${randomUUID()}`;
        const output = path.join(directory, "courses", newId); await backupFileIo.createOwnedDirectory(output, { ...owner, newId }); await backupFileIo.ensureDirectory(path.join(output, "sessions"));
        const sources: string[] = [];
        for (const entry of course.files) {
          const name = validateArchivePath(entry.path);
          if (!name.startsWith(`courses/${course.id}/`) || claimed.has(name)) throw new BackupError("manifest 课程文件关联或重复校验失败");
          const found = actual.get(name);
          if (!found || found.bytes !== entry.bytes || found.sha256 !== entry.sha256) throw new BackupError("归档文件长度或 SHA-256 校验失败");
          claimed.add(name); const relative = name.slice(`courses/${course.id}/`.length);
          if (sourceFilePattern.test(relative)) { sources.push(relative); continue; }
          const content = (await readBackupFile(path.join(extracted, ...name.split("/")), BACKUP_LIMITS.markdownBytes)).bytes;
          if (content.length !== entry.bytes || sha256(content) !== entry.sha256) throw new BackupError("解压后的 Markdown 发生变化，SHA-256 校验失败");
          originals[relative] = new TextDecoder("utf-8", { fatal: true }).decode(content);
        }
        if (!originals["course.md"]) throw new BackupError("课程缺少 course.md 文件");
        if (course.sourceIncluded !== (sources.length > 0)) throw new BackupError("manifest 来源文件状态不一致");
        const declared = sourceDocuments(originals["course.md"]);
        if (declared.length ? declared.length !== sources.length || declared.some((doc) => !sources.includes(doc.storedName)) : sources.length > 1) throw new BackupError("课件来源清单与归档不一致");
        const warnings = validateMarkdown(originals, course.id);
        const mapped = remapCourseFiles(originals, course.id, newId); validateMarkdown(mapped, newId);
        const files: RestoreState["courses"][number]["files"] = [];
        for (const [name, text] of Object.entries(mapped)) {
          const content = new TextEncoder().encode(text);
          if (content.length > BACKUP_LIMITS.markdownBytes) throw new BackupError("重映射后的 Markdown 大小超限", 413);
          await writeBackupFile(path.join(output, ...name.split("/")), content, BACKUP_LIMITS.markdownBytes);
          files.push({ path: name, bytes: content.length, sha256: sha256(content) });
        }
        for (const source of sources) {
          const name = `courses/${course.id}/${source}`;
          const sourceBytes = (await readBackupFile(path.join(extracted, ...name.split("/")), archiveFileLimit(name))).bytes;
          if (sourceBytes.length !== actual.get(name)!.bytes || sha256(sourceBytes) !== actual.get(name)!.sha256) throw new BackupError("解压后的来源文件发生变化，SHA-256 校验失败");
          await writeBackupFile(path.join(output, source), sourceBytes, archiveFileLimit(name));
          files.push({ path: source, bytes: actual.get(name)!.bytes, sha256: actual.get(name)!.sha256 });
        }
        state.courses.push({ originalId: course.id, newId, title: parseCourseMarkdown(mapped["course.md"], "course.md").title, fileCount: files.length, sourceIncluded: sources.length > 0, warnings: [...course.warnings, ...warnings].slice(0, 100), files });
      }
      if (claimed.size !== decoded.length || [...actual.keys()].some((name) => !claimed.has(name))) throw new BackupError("归档包含 manifest 未声明的文件");
      await writeRestoreState(root, state); await backupFileIo.removeDirectory(extracted, { ...owner, newId: "extracted" }); complete = true;
      return publicRestorePreview(state);
    } catch (error) {
      if (error instanceof BackupError) throw error;
      throw new BackupError(`课程文件校验失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally { if (!complete) await backupFileIo.removeDirectory(directory, owner); }
  }
  private async active(id: string): Promise<RestoreState> {
    await backupFileIo.available();
    const state = await readRestoreState(this.options.root, id);
    if (state.expiresAt <= this.now()) throw new BackupError("恢复预览已过期，请重新上传备份", 410);
    if (state.phase === "preparing") throw new BackupError("恢复文件仍在校验，尚未生成预览", 409);
    return state;
  }
  async preview(id: string): Promise<RestorePreview> { return publicRestorePreview(await this.active(id)); }
  async confirm(id: string): Promise<{ courseIds: string[] }> {
    const { root, repository, events, watchCourse } = this.options;
    return withRestoreLock(root, async () => {
      const state = await this.active(id);
      if (state.phase === "committed") return { courseIds: state.courses.map((course) => course.newId) };
      if (state.phase !== "open") throw new BackupError("恢复事务处理中或需启动恢复，请勿重复确认", 409);
      await ensureRestoreDirectory(path.join(root, "learning-journal"));
      for (const course of state.courses) {
        await verifyRestoreCourse(stagedDirectory(root, state, course.newId), state, course);
        const collision = await directoryExists(publishedDirectory(root, course.newId));
        if (collision || repository.config.courses.some((item) => item.id === course.newId)) throw new BackupError("恢复目标已存在，不会覆盖，请重新上传", 409);
      }
      const configured = state.courses.map((course) => ({ id: course.newId, root: publishedDirectory(root, course.newId), enabled: true as const }));
      await writeRestoreState(root, { ...state, phase: "publishing" });
      try {
        for (const course of state.courses) await backupFileIo.moveDirectory(stagedDirectory(root, state, course.newId), publishedDirectory(root, course.newId), restoreOwner(state, course.newId));
        const snapshots = new Map<string, Record<string, string>>();
        for (const course of state.courses) snapshots.set(course.newId, await verifyRestoreCourse(publishedDirectory(root, course.newId), state, course));
        await repository.addCourses(configured, snapshots);
        await writeRestoreState(root, { ...state, phase: "committed" });
      } catch (error) {
        repository.removeCourses(configured);
        await rollbackRestore(root, state);
        throw error;
      }
      for (const course of configured) {
        // The transaction is durable; watcher/client failures cannot undo it.
        try { watchCourse(course.root); events.publish("journal-updated", { courseId: course.id, artifact: "course" }); }
        catch { /* next list refresh/startup discovers committed courses */ }
      }
      return { courseIds: configured.map((course) => course.id) };
    });
  }
  async cancel(id: string): Promise<void> {
    const { root } = this.options;
    await withRestoreLock(root, async () => {
      const state = await this.active(id);
      if (state.phase !== "open") throw new BackupError("恢复已提交或仍在处理，不能取消", 409);
      await backupFileIo.removeDirectory(restoreDirectory(root, id), restoreOwner(state));
    });
  }
  async cleanupExpired(): Promise<void> { await cleanupRestorePreviews(this.options.root, this.now()); }
}
