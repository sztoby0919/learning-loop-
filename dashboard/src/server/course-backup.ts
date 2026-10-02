import { createHash } from "node:crypto";
import path from "node:path";
import { BACKUP_LIMITS, type BackupEntry, type BackupManifest, type ZipCodec } from "../shared/course-backup.js";
import type { WorkspaceRepository } from "./workspace-repository.js";
import type { CourseImportManager } from "./course-import-manager.js";
import { BackupError, archiveFileLimit, validateArchivePath } from "./backup-zip.js";
import { parseCourseMarkdown } from "./course-parser.js";
import { backupFileIo } from "./native-file-io.js";
import { safeCourseMatter } from "./safe-course-matter.js";
const markdownNames = ["course.md", "notes.md", "reviews.md", "resources.md", "schedule.md"];
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const changed = () => new BackupError("备份期间课程文件发生变化，请停止编辑后重试", 409);

/** The actual bounded read and all ancestor locks belong to the same worker. */
export async function readBackupFile(filename: string, limit: number): Promise<{ bytes: Uint8Array; identity: string }> {
  return backupFileIo.readFile(filename, limit);
}

export class CourseBackupService {
  constructor(private readonly repository: WorkspaceRepository, private readonly imports: CourseImportManager, private readonly codec: ZipCodec) {}
  private async snapshot(courseIds?: string[]): Promise<{ manifest: BackupManifest; entries: BackupEntry[] }> {
    await backupFileIo.available();
    const configured = [...this.repository.config.courses];
    const selected = courseIds === undefined ? configured : courseIds.map((id) => { const course = configured.find((item) => item.id === id); if (!course) throw new BackupError("未知课程，无法备份", 404); return course; });
    if (!selected.length || selected.length > BACKUP_LIMITS.courses || new Set(selected.map((course) => course.id)).size !== selected.length) throw new BackupError("备份课程数量须为 1 到 50，且不能重复", 413);
    const manifest: BackupManifest = { format: "learning-loop-backup", version: 1, exportedAt: new Date().toISOString(), courses: [] };
    const entries: BackupEntry[] = [];
    const observations: Array<{ filename: string; fingerprint: string; sha256: string; limit: number }> = [];
    const listings: Array<{ dir: string; identity: string; names: string }> = [];
    let total = 0;
    for (const course of selected) {
      const listing = await backupFileIo.listDirectory(course.root);
      const names = listing.entries.map((entry) => entry.name).sort();
      listings.push({ dir: course.root, identity: listing.identity, names: JSON.stringify(names) });
      const sourceNames = names.filter((name) => /^source\.(pdf|docx|html|htm|md|markdown|txt)$/.test(name));
      if (sourceNames.length > 1) throw new BackupError("每门课程最多包含一个受管来源文件");
      for (const name of sourceNames) if (listing.entries.find((entry) => entry.name === name)?.kind !== "file") throw new BackupError("来源文件是链接或特殊文件，拒绝备份");
      const managed = path.dirname(path.resolve(course.root)).toLowerCase() === path.resolve(this.imports.managedCourseRoot).toLowerCase();
      const source = managed && sourceNames.length ? path.join(course.root, sourceNames[0]) : null;
      const candidates = markdownNames.filter((name) => names.includes(name));
      if (!candidates.includes("course.md")) throw new BackupError("课程缺少 course.md，无法备份");
      if (source) candidates.push(path.basename(source));
      if (names.includes("sessions")) {
        const dir = path.join(course.root, "sessions"); const sessionListing = await backupFileIo.listDirectory(dir);
        const sessions = sessionListing.entries.map((entry) => entry.name).sort();
        listings.push({ dir, identity: sessionListing.identity, names: JSON.stringify(sessions) });
        candidates.push(...sessions.filter((name) => name.endsWith(".md")).map((name) => `sessions/${name}`));
      }
      const files: BackupManifest["courses"][number]["files"] = [];
      let title = "";
      for (const name of candidates) {
        const archivePath = validateArchivePath(`courses/${course.id}/${name}`);
        const limit = archiveFileLimit(archivePath);
        const filename = path.join(course.root, ...name.split("/"));
        const content = await readBackupFile(filename, limit);
        total += content.bytes.length;
        if (entries.length >= BACKUP_LIMITS.files - 1 || total > BACKUP_LIMITS.totalBytes - BACKUP_LIMITS.manifestBytes) throw new BackupError("备份大小或文件数量超限，请分课程备份", 413);
        if (name === "course.md") { const raw = Buffer.from(content.bytes).toString("utf8"); safeCourseMatter(raw); const parsed = parseCourseMarkdown(raw, filename); if (parsed.id !== course.id) throw new BackupError("课程 ID 与配置不一致"); title = parsed.title; }
        const sha256 = hash(content.bytes);
        entries.push({ path: archivePath, bytes: content.bytes });
        files.push({ path: archivePath, bytes: content.bytes.length, sha256 });
        observations.push({ filename, fingerprint: content.identity, sha256, limit });
      }
      manifest.courses.push({ id: course.id, title, sourceIncluded: Boolean(source), warnings: source ? ["只包含受管原课件，不包含其他外部资源。"] : ["未包含原课件或外部资源；这不是整个工作区的完整备份。"], files });
    }
    for (const file of observations) { const checked = await readBackupFile(file.filename, file.limit); if (checked.identity !== file.fingerprint || hash(checked.bytes) !== file.sha256) throw changed(); }
    for (const listing of listings) { const current = await backupFileIo.listDirectory(listing.dir); if (current.identity !== listing.identity || JSON.stringify(current.entries.map((entry) => entry.name).sort()) !== listing.names) throw changed(); }
    if (JSON.stringify(configured) !== JSON.stringify(this.repository.config.courses)) throw changed();
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    if (manifestBytes.length > BACKUP_LIMITS.manifestBytes) throw new BackupError("备份 manifest 超限", 413);
    entries.unshift({ path: "manifest.json", bytes: manifestBytes });
    return { manifest, entries };
  }
  async preview(courseIds?: string[]): Promise<BackupManifest> { return (await this.snapshot(courseIds)).manifest; }
  async create(courseIds?: string[]): Promise<{ bytes: Uint8Array; manifest: BackupManifest }> {
    const snapshot = await this.snapshot(courseIds);
    return { manifest: snapshot.manifest, bytes: await this.codec.encode((async function* () { yield* snapshot.entries; })()) };
  }
}
