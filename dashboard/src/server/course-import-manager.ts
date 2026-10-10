import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { CourseEventBus } from "./course-events.js";
import { buildCourseFiles, createBasicDraft, type ExtractedDocument, type ImportDraft } from "./course-import.js";
import { DocxImportError, extractDocx } from "./docx-extractor.js";
import { parseCourseMarkdown } from "./course-parser.js";
import { extractHtml, HtmlImportError } from "./html-extractor.js";
import { extractPdf } from "./pdf-extractor.js";
import { extractText } from "./text-extractor.js";
import type { WorkspaceRepository } from "./workspace-repository.js";
import type { DraftEntry, DraftSummary } from "../shared/course-import.js";
import { DraftStore } from "./course-import-store.js";
import { finishImportCommit, recoverImportCommits, rollbackImportCommit, stageImportCourse, type ImportCommit, type ImportRecoveryIssue } from "./course-import-recovery.js";
import { ImportAiOperations, type ImportAiEnricher } from "./course-import-ai-operations.js";
import { buildAiExcerpt } from "./course-import-excerpt.js";
import { applyAiSuggestions, undoAiSuggestions } from "./course-import-suggestions.js";
import { sourceDocuments } from "./course-bundle-files.js";

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_DOCX_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_HTML_BYTES = 20 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const updateSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(100),
  goal: z.string().trim().max(500),
  weeklyHours: z.number().int().min(1).max(80).nullable(),
  stages: z.array(z.object({ id: z.string().uuid().optional(), title: z.string().trim().min(1).max(100), tasks: z.array(z.string().trim().min(1).max(300)).min(1).max(20) })).min(1).max(60),
});

export class CourseImportError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

type AiEnricher = ImportAiEnricher;

export class CourseImportManager {
  private readonly store: DraftStore;
  private readonly active = new Set<string>();
  private readonly aiOperations: ImportAiOperations;
  private initialized?: Promise<void>;
  private aiEnricher?: AiEnricher;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private recoveryIssues: ImportRecoveryIssue[] = [];

  constructor(private readonly options: {
    root: string;
    repository: WorkspaceRepository;
    events: CourseEventBus;
    watchCourse: (root: string) => void;
    today: () => string;
    extract?: typeof extractPdf;
    aiEnricher?: AiEnricher;
  }) {
    this.store = new DraftStore(options.root);
    this.aiEnricher = options.aiEnricher;
    this.aiOperations = new ImportAiOperations(this.store, () => this.aiEnricher);
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired().catch(() => { /* best-effort */ });
    }, CLEANUP_INTERVAL_MS);
  }

  stopScheduledCleanup(): void {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  setAiEnricher(enricher: AiEnricher): void { this.aiEnricher = enricher; }

  initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      this.recoveryIssues = await recoverImportCommits(this.options.root);
      await this.store.cleanupExpired(new Set(this.recoveryIssues.map((issue) => issue.id)));
      await this.aiOperations.recover();
    })();
  }

  async list(): Promise<DraftSummary[]> {
    await this.initialize();
    const drafts: DraftSummary[] = [];
    for (const summary of await this.store.list()) {
      const entry = summary.status === "ready" ? await this.store.read(summary.id) : null;
      if (!entry?.bundleId) drafts.push(summary);
    }
    for (const issue of this.recoveryIssues) {
      const existing = drafts.find((draft) => draft.id === issue.id);
      if (existing) { existing.status = "invalid"; existing.warning = issue.warning; }
      else drafts.push({ id: issue.id, title: `恢复失败：${issue.courseId}`, status: "invalid", warning: issue.warning, updatedAt: Date.now(), expiresAt: Date.now() });
    }
    return drafts;
  }

  private async get(id: string): Promise<DraftEntry> {
    await this.initialize();
    const entry = await this.store.read(id);
    if (entry.state === "committed") throw new CourseImportError("这份草稿已经创建为课程，不能重复提交", 409);
    if (entry.state === "committing") throw new CourseImportError("这份草稿正在创建课程，请稍候或刷新后再试", 409);
    return entry;
  }

  private courseRoot(): string { return path.join(this.options.root, "learning-journal"); }

  async cleanupExpired(): Promise<void> {
    await this.initialize();
    await this.store.cleanupExpired(new Set(this.recoveryIssues.map((issue) => issue.id)));
  }

  async create(bytes: Uint8Array, originalFilename: string, bundleId?: string) {
    const isPdf = /\.pdf$/i.test(originalFilename);
    const isDocx = /\.docx$/i.test(originalFilename);
    const isText = /\.(md|txt|markdown)$/i.test(originalFilename);
    const isHtml = /\.html?$/i.test(originalFilename);
    if (!isPdf && !isDocx && !isText && !isHtml) throw new CourseImportError("请选择 PDF、Word (.docx)、Markdown (.md/.txt) 或 HTML 文件", 400);
    const maxBytes = isPdf ? MAX_PDF_BYTES : isDocx ? MAX_DOCX_BYTES : isHtml ? MAX_HTML_BYTES : MAX_TEXT_BYTES;
    const maxLabel = isPdf ? "100 MB" : isDocx ? "50 MB" : isHtml ? "20 MB" : "10 MB";
    if (bytes.length > maxBytes) throw new CourseImportError(`文件超过 ${maxLabel}，请压缩或拆分后导入`, 413);
    let source: ExtractedDocument;
    if (isDocx) {
      source = await extractDocx(bytes, originalFilename);
    } else if (isHtml) {
      source = await extractHtml(bytes, originalFilename);
    } else if (isText) {
      source = await extractText(bytes, originalFilename);
    } else {
      source = await (this.options.extract ?? extractPdf)(bytes, originalFilename);
    }
    const id = randomUUID();
    const courseId = `course-${id.slice(0, 8)}`;
    await this.initialize();
    const extension = path.extname(originalFilename).toLowerCase();
    const now = Date.now();
    await this.store.create({ version: 1, id, courseId, revision: 0, ...(bundleId ? { bundleId } : {}), draft: createBasicDraft(source, originalFilename), source, sourceExtension: extension, createdAt: now, updatedAt: now, expiresAt: now + MAX_AGE_MS, state: "open" }, bytes);
    return this.preview(id);
  }

  async update(id: string, input: unknown) {
    await this.initialize();
    return this.aiOperations.withLock(id, () => this.updateLocked(id, input));
  }

  private async updateLocked(id: string, input: unknown) {
    const entry = await this.get(id);
    this.aiOperations.assertEditable(entry);
    if (this.active.has(id)) throw new CourseImportError("草稿正在处理，请稍后再试", 409);
    const parsed = updateSchema.safeParse(input);
    if (!parsed.success) throw new CourseImportError("草稿内容无效：请检查课程名、学习时间和阶段任务", 400);
    if (parsed.data.expectedRevision !== entry.revision) throw new CourseImportError("草稿已在其他页面更新，请重新载入", 409);
    const ids = parsed.data.stages.filter((stage) => stage.id).map((stage) => stage.id);
    if (new Set(ids).size !== ids.length || ids.some((stageId) => !entry.draft.stages.some((stage) => stage.id === stageId))) throw new CourseImportError("阶段 ID 无效，请重新载入草稿", 400);
    const stages = parsed.data.stages.map((stage) => {
      const existing = entry.draft.stages.find((item) => item.id === stage.id);
      return { ...stage, id: stage.id ?? randomUUID(), ...(existing?.source ? { source: existing.source } : {}) };
    });
    const stageIds = new Set(stages.map((stage) => stage.id));
    const notes = entry.draft.notes.map((note) => {
      if (!note.stageId || stageIds.has(note.stageId)) return note;
      const { stageId: _removed, ...retained } = note;
      return retained;
    });
    const { expectedRevision: _revision, ...editable } = parsed.data;
    await this.store.replace({ ...entry, candidate: undefined, undo: undefined, operation: entry.operation ? { ...entry.operation, candidate: undefined } : undefined, revision: entry.revision + 1, updatedAt: Date.now(), draft: { ...entry.draft, ...editable, stages, notes } }, entry.revision);
    return this.preview(id);
  }

  async preview(id: string) {
    const entry = await this.get(id);
    return { id, courseId: entry.courseId, revision: entry.revision, expiresAt: entry.expiresAt, sourceUrl: `/api/course-imports/${id}/source`, draft: entry.draft, files: buildCourseFiles(entry.draft, entry.courseId, this.options.today()), aiAvailable: Boolean(this.aiEnricher), excerptChars: 24000, candidate: entry.candidate, operation: entry.operation, canUndo: Boolean(entry.undo && entry.undo.appliedRevision === entry.revision) };
  }

  async draftSourcePath(id: string): Promise<string> { await this.get(id); return this.store.sourcePath(id); }

  async aiExcerpt(id: string, input: unknown) {
    const entry = await this.get(id);
    const parsed = z.object({ expectedRevision: z.number().int().nonnegative(), stageIds: z.array(z.string().uuid()).min(1).max(60) }).strict().safeParse(input);
    if (!parsed.success) throw new CourseImportError("请选择章节并携带已保存修订号", 400);
    if (parsed.data.expectedRevision !== entry.revision) throw new CourseImportError("草稿已更新，请重新加载发送范围", 409);
    return buildAiExcerpt(entry, parsed.data.stageIds);
  }
  async startAi(id: string, input: unknown) { await this.initialize(); return this.aiOperations.start(id, input); }
  async getAi(id: string, operationId: string) { await this.initialize(); return this.aiOperations.get(id, operationId); }
  async cancelAi(id: string, operationId: string) { await this.initialize(); return this.aiOperations.cancel(id, operationId); }
  async applyAi(id: string, candidateId: string, input: unknown) {
    await this.initialize();
    return this.aiOperations.withLock(id, async () => {
      const entry = await this.get(id);
      const parsed = z.object({ expectedRevision: z.number().int().nonnegative(), acceptedStageIds: z.array(z.string().uuid()).min(1).max(60) }).strict().safeParse(input);
      if (!parsed.success) throw new CourseImportError("请携带修订号和接受章节 ID", 400);
      await this.store.replace(applyAiSuggestions(entry, candidateId, parsed.data.acceptedStageIds, parsed.data.expectedRevision), entry.revision);
      return this.preview(id);
    });
  }
  async rejectAi(id: string, candidateId: string, input: unknown) {
    await this.initialize();
    return this.aiOperations.withLock(id, async () => {
      const entry = await this.get(id); this.aiOperations.assertEditable(entry);
      if (!entry.candidate || entry.candidate.id !== candidateId || (input as { expectedRevision?: number })?.expectedRevision !== entry.revision) throw new CourseImportError("候选已变化或修订过时，请重新加载", 409);
      await this.store.replace({ ...entry, candidate: undefined, operation: entry.operation ? { ...entry.operation, candidate: undefined } : undefined, updatedAt: Date.now() }, entry.revision, { metadataOnly: true });
      return this.preview(id);
    });
  }
  async undoAi(id: string, input: unknown) {
    await this.initialize();
    return this.aiOperations.withLock(id, async () => {
      const entry = await this.get(id);
      const parsed = z.object({ expectedRevision: z.number().int().nonnegative() }).strict().safeParse(input);
      if (!parsed.success) throw new CourseImportError("请携带修订号", 400);
      await this.store.replace(undoAiSuggestions(entry, parsed.data.expectedRevision), entry.revision);
      return this.preview(id);
    });
  }

  async confirm(id: string, expectedRevision: number): Promise<{ courseId: string }> {
    await this.initialize();
    if (this.aiOperations.isLocked(id)) throw new CourseImportError("草稿正在处理，请稍后再试", 409);
    return this.aiOperations.withLock(id, () => this.confirmLocked(id, expectedRevision));
  }
  private async confirmLocked(id: string, expectedRevision: number): Promise<{ courseId: string }> {
    const entry = await this.store.read(id);
    if (entry.bundleId) throw new CourseImportError("这份课件属于多文件草稿，请在合并预览中确认", 409);
    if (entry.state === "committed") return { courseId: entry.courseId };
    this.aiOperations.assertEditable(entry);
    if (entry.state === "committing" || this.active.has(id)) throw new CourseImportError("这份草稿正在创建课程，请稍候", 409);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new CourseImportError("请携带已保存草稿的修订号", 400);
    if (entry.revision !== expectedRevision) throw new CourseImportError("草稿已更新，请重新载入后确认", 409);
    this.active.add(id);
    const courseRoot = path.join(this.courseRoot(), entry.courseId);
    let transaction: ImportCommit | undefined;
    let claimed = false;
    let registered = false;
    try {
      if (this.options.repository.config.courses.some((course) => course.id === entry.courseId) || await lstat(courseRoot).then(() => true, () => false)) {
        throw new CourseImportError("课程 ID 已存在，请重新上传", 409);
      }
      const files = buildCourseFiles(entry.draft, entry.courseId, this.options.today());
      parseCourseMarkdown(files["course.md"], path.join(courseRoot, "course.md"));
      await this.store.replace({ ...entry, candidate: undefined, undo: undefined, operation: entry.operation ? { ...entry.operation, candidate: undefined } : undefined, state: "committing", revision: entry.revision + 1, updatedAt: Date.now() }, entry.revision);
      claimed = true;
      transaction = await stageImportCourse(this.options.root, entry, files, new Uint8Array(await readFile(await this.store.sourcePath(id))));
      await mkdir(this.courseRoot(), { recursive: true });
      const courseRootDetails = await lstat(this.courseRoot());
      if (courseRootDetails.isSymbolicLink() || !courseRootDetails.isDirectory() || path.dirname(await realpath(this.courseRoot())) !== await realpath(this.options.root)) throw new CourseImportError("课程目录不安全", 422);
      await rename(transaction.stagedPath, courseRoot);
      await this.options.repository.addCourse({ id: entry.courseId, root: courseRoot, enabled: true });
      registered = true;
      await finishImportCommit(this.options.root, transaction);
      try { this.options.watchCourse(courseRoot); } catch { /* The registered course remains usable without the watcher. */ }
      try { this.options.events.publish("journal-updated", { courseId: entry.courseId, artifact: "course" }); } catch { /* Clients can refresh the course list. */ }
      return { courseId: entry.courseId };
    } catch (error) {
      // addCourse may register before a later cache refresh fails. Never erase it.
      registered ||= this.options.repository.config.courses.some((course) => course.id === entry.courseId && path.resolve(course.root) === path.resolve(courseRoot));
      if (registered) return { courseId: entry.courseId }; // startup settles its durable journal
      if (transaction) await rollbackImportCommit(this.options.root, transaction);
      else if (claimed) {
        const current = await this.store.read(id);
        await this.store.replace({ ...current, state: "open", revision: current.revision + 1, updatedAt: Date.now() }, current.revision);
      }
      throw error;
    } finally {
      this.active.delete(id);
    }
  }

  async cancel(id: string, bundleId?: string): Promise<void> {
    await this.initialize();
    if (this.recoveryIssues.some((issue) => issue.id === id)) throw new CourseImportError("该草稿存在未决建课事务，已保留恢复数据。请先备份并处理恢复失败，不能直接删除。", 409);
    const current = await this.store.read(id).catch(() => null);
    if (current?.bundleId && current.bundleId !== bundleId) throw new CourseImportError("请从多文件草稿中取消整批导入", 409);
    if (current?.operation?.status === "running") await this.aiOperations.cancel(id, current.operation.id);
    return this.aiOperations.withLock(id, () => this.cancelLocked(id));
  }
  private async cancelLocked(id: string): Promise<void> {
    if (this.active.has(id)) throw new CourseImportError("草稿正在处理，请稍后再删除", 409);
    const entry = await this.store.read(id).catch((error) => { if ((error as { status?: number }).status === 422) return null; throw error; });
    if (entry) this.aiOperations.assertEditable(entry);
    if (entry?.state === "committed") throw new CourseImportError("这份草稿已经创建为课程，不能删除课程数据", 409);
    await this.store.delete(id);
  }

  async sourcePath(courseId: string, sourceId?: string): Promise<string | null> {
    const configured = this.options.repository.config.courses.find((course) => course.id === courseId);
    const managedRoot = path.resolve(this.courseRoot());
    if (!configured) return null;
    const root = configured.root;
    try {
      const documents = sourceDocuments(await readFile(path.join(root, "course.md"), "utf8"));
      if (sourceId !== undefined || documents.length) {
        const source = sourceId === undefined ? documents.find((doc) => doc.id === "legacy") ?? documents[0] : documents.find((doc) => doc.id === sourceId);
        if (!source) return null;
        return path.join(root, source.storedName);
      }
    } catch { return null; }
    if (sourceId !== undefined || path.dirname(path.resolve(configured.root)) !== managedRoot) return null;
    for (const ext of [".pdf", ".docx", ".md", ".txt", ".markdown", ".html", ".htm"]) {
      const candidate = path.join(root, `source${ext}`);
      try { await stat(candidate); return candidate; } catch { /* try next extension */ }
    }
    return null;
  }
  get managedCourseRoot(): string { return this.courseRoot(); }
  get projectRoot(): string { return this.options.root; }
  currentDate(): string { return this.options.today(); }
  watch(root: string): void { this.options.watchCourse(root); }
  readBundleDraft(id: string): Promise<DraftEntry> { return this.get(id); }
  async withBundleDrafts<T>(ids: string[], action: (entries: DraftEntry[]) => Promise<T>): Promise<T> {
    const sorted = [...ids].sort();
    const acquire = (index: number): Promise<T> => index === sorted.length ? Promise.all(ids.map((id) => this.get(id))).then((entries) => {
      for (const entry of entries) this.aiOperations.assertEditable(entry);
      return action(entries);
    }) : this.aiOperations.withLock(sorted[index], () => acquire(index + 1));
    return acquire(0);
  }
  async finishBundleDraft(id: string, bundleId: string): Promise<void> {
    const entry = await this.store.read(id, { includeExpired: true });
    if (entry.bundleId !== bundleId || entry.state === "committed") return;
    await this.store.replace({ ...entry, state: "committed", revision: entry.revision + 1, updatedAt: Math.min(Date.now(), entry.expiresAt - 1) }, entry.revision, { includeExpired: true });
  }
}
