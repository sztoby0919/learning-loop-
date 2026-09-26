import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { CourseEventBus } from "./course-events.js";
import { buildCourseFiles, createBasicDraft, type ExtractedPdf, type ImportDraft } from "./course-import.js";
import { parseCourseMarkdown } from "./course-parser.js";
import { extractPdf } from "./pdf-extractor.js";
import type { WorkspaceRepository } from "./workspace-repository.js";

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const updateSchema = z.object({
  title: z.string().trim().min(1).max(100),
  goal: z.string().trim().max(500),
  weeklyHours: z.number().int().min(1).max(80).nullable(),
  stages: z.array(z.object({ title: z.string().trim().min(1).max(100), tasks: z.array(z.string().trim().min(1).max(300)).min(1).max(20) })).min(1).max(60),
});

export class CourseImportError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

interface PendingDraft { id: string; courseId: string; draft: ImportDraft; source: ExtractedPdf; pdfPath: string; createdAt: number; state: "open" | "committing" | "committed"; }
type AiEnricher = (excerpt: string, draft: ImportDraft) => Promise<Pick<ImportDraft, "stages" | "notes">>;

export class CourseImportManager {
  private readonly pending = new Map<string, PendingDraft>();
  private aiEnricher?: AiEnricher;

  constructor(private readonly options: {
    root: string;
    repository: WorkspaceRepository;
    events: CourseEventBus;
    watchCourse: (root: string) => void;
    today: () => string;
    extract?: typeof extractPdf;
    aiEnricher?: AiEnricher;
  }) { this.aiEnricher = options.aiEnricher; }

  setAiEnricher(enricher: AiEnricher): void { this.aiEnricher = enricher; }

  private get(id: string): PendingDraft {
    const entry = this.pending.get(id);
    if (!entry) throw new CourseImportError("导入草稿不存在或已过期，请重新上传", 404);
    if (entry.state === "committed") throw new CourseImportError("这份草稿已经创建为课程，不能重复提交", 409);
    if (entry.state === "committing") throw new CourseImportError("这份草稿正在创建课程，请稍候或刷新后再试", 409);
    if (Date.now() - entry.createdAt > MAX_AGE_MS) throw new CourseImportError("导入草稿已过期，请重新上传", 410);
    return entry;
  }

  private tempRoot(): string { return path.join(this.options.root, ".learning-loop", "imports"); }
  private courseRoot(): string { return path.join(this.options.root, "learning-journal"); }

  async cleanupExpired(): Promise<void> {
    await mkdir(this.tempRoot(), { recursive: true });
    for (const filename of await readdir(this.tempRoot())) {
      if (!/^[0-9a-f-]{36}\.pdf$/.test(filename)) continue;
      const filePath = path.join(this.tempRoot(), filename);
      const details = await stat(filePath).catch(() => null);
      if (details && Date.now() - details.mtimeMs > MAX_AGE_MS) await rm(filePath, { force: true });
    }
    for (const [id, entry] of this.pending) if (Date.now() - entry.createdAt > MAX_AGE_MS) this.pending.delete(id);
  }

  async create(bytes: Uint8Array, originalFilename: string) {
    if (bytes.length > MAX_BYTES) throw new CourseImportError("PDF 超过 100 MB，请压缩或拆分后导入", 413);
    if (!/\.pdf$/i.test(originalFilename)) throw new CourseImportError("请选择 PDF 文件", 400);
    const source = await (this.options.extract ?? extractPdf)(bytes, originalFilename);
    const id = randomUUID();
    const courseId = `course-${id.slice(0, 8)}`;
    await this.cleanupExpired();
    const pdfPath = path.join(this.tempRoot(), `${id}.pdf`);
    await writeFile(pdfPath, bytes, { flag: "wx" });
    this.pending.set(id, { id, courseId, draft: createBasicDraft(source, originalFilename), source, pdfPath, createdAt: Date.now(), state: "open" });
    return this.preview(id);
  }

  update(id: string, input: unknown) {
    const entry = this.get(id);
    const parsed = updateSchema.safeParse(input);
    if (!parsed.success) throw new CourseImportError("草稿内容无效：请检查课程名、学习时间和阶段任务", 400);
    entry.draft = { ...entry.draft, ...parsed.data };
    return this.preview(id);
  }

  preview(id: string) {
    const entry = this.get(id);
    return { id, courseId: entry.courseId, draft: entry.draft, files: buildCourseFiles(entry.draft, entry.courseId, this.options.today()), aiAvailable: Boolean(this.aiEnricher), excerptChars: this.excerpt(entry).length };
  }

  private excerpt(entry: PendingDraft): string {
    const selectedPages = new Set<number>([1, ...entry.source.outline.map((item) => item.page)]);
    const parts = entry.source.pages.filter((page) => selectedPages.has(page.page)).map((page) => `[第 ${page.page} 页]\n${page.text.slice(0, 1200)}`);
    return [`目录：\n${entry.source.outline.map((item) => `${item.title}（第 ${item.page} 页）`).join("\n")}`, ...parts].join("\n\n").slice(0, 24000);
  }

  async enrich(id: string, consent: boolean) {
    const entry = this.get(id);
    if (!consent) throw new CourseImportError("请先确认同意将 PDF 摘录发送给模型服务", 400);
    if (!this.aiEnricher) throw new CourseImportError("未配置真实模型 API，仍可创建基础课程", 503);
    try {
      const result = await this.aiEnricher(this.excerpt(entry), entry.draft);
      const candidate = updateSchema.safeParse({ ...entry.draft, stages: result.stages });
      if (!candidate.success || !Array.isArray(result.notes) || result.notes.some((note) => !note.title || !Number.isInteger(note.page) || note.page < 1 || note.page > entry.source.pageCount || typeof note.content !== "string")) {
        throw new CourseImportError("模型返回的课程草稿格式不正确", 502);
      }
      entry.draft = { ...entry.draft, stages: candidate.data.stages, notes: result.notes, aiStatus: "complete" };
      return this.preview(id);
    } catch (error) {
      entry.draft.aiStatus = "failed";
      throw error;
    }
  }

  async confirm(id: string): Promise<{ courseId: string }> {
    const entry = this.get(id);
    // Claim synchronously before the first await so a concurrent confirm cannot race past get().
    entry.state = "committing";
    const courseRoot = path.join(this.courseRoot(), entry.courseId);
    const staged = path.join(this.options.root, ".learning-loop", `staged-${id}`);
    let moved = false;
    let registered = false;
    try {
      if (this.options.repository.config.courses.some((course) => course.id === entry.courseId) || await stat(courseRoot).then(() => true, () => false)) {
        throw new CourseImportError("课程 ID 已存在，请重新上传", 409);
      }
      const files = buildCourseFiles(entry.draft, entry.courseId, this.options.today());
      parseCourseMarkdown(files["course.md"], path.join(courseRoot, "course.md"));
      await mkdir(this.courseRoot(), { recursive: true });
      await mkdir(staged, { recursive: false });
      for (const [name, content] of Object.entries(files)) await writeFile(path.join(staged, name), content, { flag: "wx" });
      await mkdir(path.join(staged, "sessions"));
      await writeFile(path.join(staged, "source.pdf"), await readFile(entry.pdfPath), { flag: "wx" });
      await rename(staged, courseRoot);
      moved = true;
      await this.options.repository.addCourse({ id: entry.courseId, root: courseRoot, enabled: true });
      registered = true;
      entry.state = "committed";
      try { this.options.watchCourse(courseRoot); } catch { /* The registered course remains usable without the watcher. */ }
      await rm(entry.pdfPath, { force: true }).catch(() => { /* Expiry cleanup will retry. */ });
      try { this.options.events.publish("journal-updated", { courseId: entry.courseId, artifact: "course" }); } catch { /* Clients can refresh the course list. */ }
      return { courseId: entry.courseId };
    } catch (error) {
      if (moved && !registered) await rm(courseRoot, { recursive: true, force: true });
      if (entry.state === "committing") entry.state = "open";
      throw error;
    } finally {
      await rm(staged, { recursive: true, force: true }).catch(() => { /* A later cleanup can remove stale staging files. */ });
    }
  }

  async cancel(id: string): Promise<void> {
    const entry = this.get(id);
    this.pending.delete(id);
    await rm(entry.pdfPath, { force: true });
  }

  sourcePath(courseId: string): string | null {
    const configured = this.options.repository.config.courses.find((course) => course.id === courseId);
    const managedRoot = path.resolve(this.courseRoot());
    if (!configured || path.dirname(path.resolve(configured.root)) !== managedRoot) return null;
    return path.join(configured.root, "source.pdf");
  }
}
