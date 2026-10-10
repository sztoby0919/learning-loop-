import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BUNDLE_LIMITS, type CourseBundlePreview, type CourseBundleSummary, type CourseSourceDocument } from "../shared/course-bundle.js";
import type { DraftEntry } from "../shared/course-import.js";
import { CourseImportError, type CourseImportManager } from "./course-import-manager.js";
import type { WorkspaceRepository } from "./workspace-repository.js";
import type { CourseEventBus } from "./course-events.js";
import { buildBundleFiles, sourceDocuments, sourceFilePattern } from "./course-bundle-files.js";
import { bundleArtifacts, CourseBundleStore, safeBundleDirectory, type BundleState } from "./course-bundle-store.js";
import { parseCourseMarkdown } from "./course-parser.js";
import { batchAtomicWrite } from "./file-utils.js";
import { withCourseMutation } from "./course-mutation-lock.js";

const sha = (raw: Uint8Array | string) => createHash("sha256").update(raw).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const confirmSchema = z.object({ title: z.string().trim().min(1).max(100), expectedRevision: z.number().int().nonnegative(), drafts: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().nonnegative() })).min(1).max(10) }).strict();
async function writePlanned(directory: string, name: string, content: Uint8Array | string) {
  await safeBundleDirectory(directory);
  const target = path.join(directory, name);
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || path.dirname(await realpath(target)) !== await realpath(directory)) throw new CourseImportError("暂存文件是链接或特殊文件，未覆盖任何资料", 422);
  } catch (error) { if (!missing(error)) throw error; }
  const temporary = path.join(directory, `.file-${randomUUID()}.tmp`);
  // A destination swapped to a link is replaced as a directory entry, never followed.
  try { await writeFile(temporary, content, { flag: "wx" }); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
}

export class CourseBundles {
  private store: CourseBundleStore;
  private initialized?: Promise<void>;
  private errors = new Map<string, string>();
  constructor(private imports: CourseImportManager, private repository: WorkspaceRepository, private events: CourseEventBus) { this.store = new CourseBundleStore(path.resolve(imports.projectRoot)); }
  private mutationKey(state: BundleState) { return path.resolve(this.repository.config.courses.find((course) => course.id === state.courseId)?.root ?? path.join(this.imports.managedCourseRoot, state.courseId)); }
  initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      for (const state of await this.store.list()) {
        if (state.phase !== "committing") continue;
        try { await withCourseMutation(this.mutationKey(state), () => this.publish(state)); }
        catch { this.errors.set(state.id, "追加或建课中断后尚未恢复：文件版本不一致，恢复资料已保留。请备份并检查课程后重试。"); }
      }
    })();
  }
  private async target(id: string) {
    const course = this.repository.config.courses.find((item) => item.id === id);
    if (!course) throw new CourseImportError("未知课程，无法追加课件", 404);
    await safeBundleDirectory(course.root);
    return course;
  }
  private async existing(id: string) {
    const target = await this.target(id); const files: Record<string, string | null> = {};
    for (const name of bundleArtifacts) {
      const file = path.join(target.root, name);
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 10 * 1048576 || path.dirname(await realpath(file)) !== await realpath(target.root)) throw new CourseImportError("课程档案路径或大小不安全", 422);
        files[name] = await readFile(file, "utf8");
      } catch (error) { if (!missing(error)) throw error; files[name] = null; }
    }
    if (files["course.md"] === null || parseCourseMarkdown(files["course.md"], "course.md").id !== id) throw new CourseImportError("课程档案缺失或 ID 不一致", 422);
    return { target, files, hashes: Object.fromEntries(Object.entries(files).map(([name, raw]) => [name, raw === null ? null : sha(raw)])) };
  }
  async create(files: Array<{ bytes: Uint8Array; filename: string }>, targetCourseId?: string): Promise<CourseBundlePreview> {
    await this.initialize();
    if (!files.length || files.length > BUNDLE_LIMITS.files) throw new CourseImportError("每批请选择 1 到 10 个文件", 400);
    if (files.reduce((sum, file) => sum + file.bytes.length, 0) > BUNDLE_LIMITS.totalBytes) throw new CourseImportError("整批文件超过 200 MB，请分批追加", 413);
    if (files.some((file) => !/\.(pdf|docx|md|txt|markdown|html|htm)$/i.test(file.filename))) throw new CourseImportError("批次包含不支持的文件，请只选择 PDF、Word、Markdown、TXT 或 HTML", 400);
    const base = targetCourseId ? await this.existing(targetCourseId) : null;
    const id = randomUUID(); const createdAt = Date.now();
    const children: DraftEntry[] = [];
    try {
      for (const file of files) { const preview = await this.imports.create(file.bytes, file.filename, id); children.push(await this.imports.readBundleDraft(preview.id)); }
      const title = base ? parseCourseMarkdown(base.files["course.md"]!, "course.md").title.slice(0, 100) : children[0].draft.title;
      const state: BundleState = { version: 1, id, courseId: targetCourseId ?? `course-${id.slice(0, 8)}`, ...(targetCourseId ? { targetCourseId } : {}), title, revision: 0, createdAt, expiresAt: createdAt + 7 * 86400000, draftIds: children.map((entry) => entry.id), phase: "open", baseHashes: base?.hashes ?? {} };
      await this.store.create(state); return this.preview(id);
    } catch (error) {
      for (const child of children) await this.imports.cancel(child.id, id).catch(() => {});
      await this.store.remove(id).catch(() => {}); throw error;
    }
  }
  async list(): Promise<CourseBundleSummary[]> {
    await this.initialize(); const states = await this.store.list();
    return [...states.filter((state) => state.expiresAt > Date.now() || state.phase === "committing").map((state) => ({ id: state.id, title: state.title, targetCourseId: state.targetCourseId, expiresAt: state.expiresAt, ...(this.errors.has(state.id) ? { warning: this.errors.get(state.id) } : {}) })), ...[...this.store.recoveryWarnings].map(([id, warning]) => ({ id, title: "无法恢复的课件草稿", expiresAt: 0, warning }))];
  }
  private async legacy(id: string, existing: Record<string, string | null>): Promise<CourseSourceDocument | undefined> {
    if (sourceDocuments(existing["course.md"]!).some((doc) => doc.id === "legacy")) return undefined;
    const filename = await this.imports.sourcePath(id);
    if (!filename || !/^source\./.test(path.basename(filename))) return undefined;
    const ext = path.extname(filename);
    const originalName = parseCourseMarkdown(existing["course.md"]!, "course.md").overviewMarkdown.match(/^来源：(.*?)（\d+ /m)?.[1];
    return { id: "legacy", filename: originalName ?? path.basename(filename), storedName: path.basename(filename), sourceFormat: ext === ".pdf" ? "pdf" : ext === ".docx" ? "docx" : "text" };
  }
  async preview(id: string): Promise<CourseBundlePreview> {
    await this.initialize(); const state = await this.store.read(id);
    if (state.phase !== "open") throw new CourseImportError(this.errors.get(id) ?? "此批课件已确认或正在写入，请返回课程查看", 409);
    const entries = await Promise.all(state.draftIds.map((id) => this.imports.readBundleDraft(id)));
    const base = state.targetCourseId ? await this.existing(state.targetCourseId) : null;
    if (entries.some((entry) => entry.bundleId !== state.id)) throw new CourseImportError("批次课件关联错误", 422);
    return { id, revision: state.revision, title: state.title, courseId: state.courseId, targetCourseId: state.targetCourseId, expiresAt: state.expiresAt, documents: await Promise.all(state.draftIds.map((id) => this.imports.preview(id))), files: buildBundleFiles(entries, state.courseId, state.title, this.imports.currentDate(), base?.files, base ? await this.legacy(state.courseId, base.files) : undefined) };
  }
  async updateTitle(id: string, input: unknown): Promise<CourseBundlePreview> {
    await this.initialize(); const state = await this.store.read(id);
    await withCourseMutation(this.mutationKey(state), async () => {
      const current = await this.store.read(id);
      const data = z.object({ title: z.string().trim().min(1).max(100), expectedRevision: z.number().int().nonnegative() }).strict().safeParse(input);
      if (!data.success) throw new CourseImportError("请填写有效课程名称和草稿版本", 400);
      if (current.phase !== "open" || data.data.expectedRevision !== current.revision) throw new CourseImportError("合并草稿已变化，请重新加载", 409);
      await this.store.write({ ...current, title: current.targetCourseId ? current.title : data.data.title, revision: current.revision + 1 });
    });
    return this.preview(id);
  }
  async confirm(id: string, input: unknown): Promise<{ courseId: string }> {
    await this.initialize();
    const original = await this.store.read(id);
    return withCourseMutation(this.mutationKey(original), async () => {
      let state = await this.store.read(id);
      if (state.phase === "committed") return { courseId: state.courseId };
      if (state.phase === "committing") { await this.publish(state); return { courseId: state.courseId }; }
      const parsed = confirmSchema.safeParse(input);
      if (!parsed.success) throw new CourseImportError("请选择有效课程名称并携带所有课件修订号", 400);
      const data = parsed.data;
      if (state.revision !== data.expectedRevision || data.drafts.length !== state.draftIds.length || new Set(data.drafts.map((entry) => entry.id)).size !== state.draftIds.length || state.draftIds.some((id) => !data.drafts.some((entry) => entry.id === id))) throw new CourseImportError("合并草稿已变化，请重新加载", 409);
      await this.imports.withBundleDrafts(state.draftIds, async (entries) => {
        if (entries.some((entry) => entry.bundleId !== state.id || entry.revision !== data.drafts.find((item) => item.id === entry.id)?.revision)) throw new CourseImportError("课件草稿已在其他页面修改，请重新加载合并预览", 409);
        const base = state.targetCourseId ? await this.existing(state.targetCourseId) : null;
        if (base && JSON.stringify(base.hashes) !== JSON.stringify(state.baseHashes)) throw new CourseImportError("课程已被修改，未覆盖原数据。请重新上传追加课件并合并修改", 409);
        const planned = buildBundleFiles(entries, state.courseId, state.targetCourseId ? state.title : data.title, this.imports.currentDate(), base?.files, base ? await this.legacy(state.courseId, base.files) : undefined);
        parseCourseMarkdown(planned["course.md"], "course.md");
        const directory = path.join(await this.store.directory(id), "planned"); await safeBundleDirectory(directory, true);
        if (!state.targetCourseId) await safeBundleDirectory(path.join(directory, "sessions"), true);
        const plannedHashes: Record<string, string> = {};
        for (const [name, content] of Object.entries(planned)) { if (Buffer.byteLength(content) > 10 * 1048576) throw new CourseImportError("合并后的档案超过 10 MiB，请拆分课程", 413); await writePlanned(directory, name, content); plannedHashes[name] = sha(content); }
        for (const entry of entries) {
          const content = await readFile(await this.imports.draftSourcePath(entry.id)); const name = `source-${entry.id}${entry.sourceExtension}`;
          await writePlanned(directory, name, content); plannedHashes[name] = sha(content);
        }
        await writePlanned(directory, ".learning-loop-bundle.json", JSON.stringify({ id, courseId: state.courseId }));
        state = { ...state, title: state.targetCourseId ? state.title : data.title, phase: "committing", revision: state.revision + 1, plannedHashes };
        await this.store.write(state); await this.publish(state);
      });
      return { courseId: state.courseId };
    });
  }
  private async publish(state: BundleState) {
    const planned = path.join(await this.store.directory(state.id), "planned");
    const courseRoot = state.targetCourseId ? (await this.target(state.targetCourseId)).root : path.join(this.imports.managedCourseRoot, state.courseId);
    const verify = async (root: string, name: string, expected: string) => {
      const file = path.join(root, name); const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || path.dirname(await realpath(file)) !== await realpath(root) || sha(await readFile(file)) !== expected) throw new CourseImportError("事务资料损坏或发生变化，未覆盖现有数据", 409);
    };
    if (!state.targetCourseId) {
      await safeBundleDirectory(this.imports.managedCourseRoot, true);
      const exists = await lstat(courseRoot).then(() => true, (error) => { if (!missing(error)) throw error; return false; });
      if (!exists) { await safeBundleDirectory(planned); for (const [name, expected] of Object.entries(state.plannedHashes!)) await verify(planned, name, expected!); await rename(planned, courseRoot); }
      await safeBundleDirectory(courseRoot);
      const owner = JSON.parse(await readFile(path.join(courseRoot, ".learning-loop-bundle.json"), "utf8"));
      if (owner.id !== state.id || owner.courseId !== state.courseId) throw new CourseImportError("课程 ID 已存在，未覆盖原目录", 409);
      for (const [name, expected] of Object.entries(state.plannedHashes!)) await verify(courseRoot, name, expected!);
      if (!this.repository.config.courses.some((course) => course.id === state.courseId)) await this.repository.addCourse({ id: state.courseId, root: courseRoot, enabled: true });
    } else {
      await safeBundleDirectory(planned);
      const current = await this.existing(state.courseId);
      const operations = [];
      for (const name of bundleArtifacts) {
        const actual = current.hashes[name]; const expected = state.plannedHashes![name];
        if (actual !== expected && actual !== state.baseHashes[name]) throw new CourseImportError("课程文件版本冲突，恢复资料已保留", 409);
        await verify(planned, name, expected!);
        if (actual !== expected) operations.push({ filePath: path.join(courseRoot, name), content: await readFile(path.join(planned, name), "utf8"), expectedHash: actual });
      }
      for (const [name, expected] of Object.entries(state.plannedHashes!)) {
        if (!sourceFilePattern.test(name)) continue;
        await verify(planned, name, expected!);
        try { await writeFile(path.join(courseRoot, name), await readFile(path.join(planned, name)), { flag: "wx" }); }
        catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error; await verify(courseRoot, name, expected!); }
      }
      const written = await batchAtomicWrite(operations);
      if (!written.success) throw new CourseImportError(written.conflict ? "课程已变化，未覆盖修改" : `追加保存失败：${written.error}`, written.conflict ? 409 : 500);
      for (const name of bundleArtifacts) await this.repository.refresh(state.courseId, name.slice(0, -3) as "course" | "notes" | "reviews" | "resources" | "schedule");
    }
    await this.store.write({ ...state, phase: "committed", revision: state.revision + 1 });
    for (const id of state.draftIds) await this.imports.finishBundleDraft(id, state.id).catch(() => {});
    this.errors.delete(state.id);
    try { this.imports.watch(courseRoot); this.events.publish("journal-updated", { courseId: state.courseId, artifact: "course" }); } catch { /* Refresh remains available. */ }
  }
  async cancel(id: string) {
    await this.initialize(); const state = await this.store.read(id, true);
    return withCourseMutation(this.mutationKey(state), async () => {
      const current = await this.store.read(id, true);
      if (current.phase !== "open") throw new CourseImportError("已确认或恢复中的课件不能作为草稿删除", 409);
      for (const child of current.draftIds) await this.imports.cancel(child, id).catch((error) => { if (![404, 410].includes(error.status)) throw error; });
      await this.store.remove(id);
    });
  }
}
