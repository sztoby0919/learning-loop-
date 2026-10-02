import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type { DraftEntry, DraftSummary } from "../shared/course-import.js";

const AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOT_BYTES = 32 * 1024 * 1024;
const uuid = z.string().uuid();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ext = z.enum([".pdf", ".docx", ".md", ".txt", ".markdown", ".html", ".htm"]);
const format = z.enum(["pdf", "docx", "text"]);
const title = z.string().trim().min(1).max(100);
const pageNumber = z.number().int().min(1).max(10000);
const quality = z.object({ version: z.literal(1), noTextPages: z.array(pageNumber).max(1000), sideNotePages: z.array(pageNumber).max(1000), complexPages: z.array(pageNumber).max(1000) }).strict();
const sourceSchema = z.object({
  title: z.string().max(10000), pageCount: pageNumber, sourceFormat: format,
  pages: z.array(z.object({ page: pageNumber, text: z.string() }).strict()).max(10000),
  outline: z.array(z.object({ title: z.string().max(10000), page: pageNumber }).strict()).max(10000),
  warnings: z.array(z.string().max(2000)).max(1000), quality: quality.optional(),
}).strict();
const stageSchema = z.object({ id: uuid, title, tasks: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  source: z.object({ title, startPage: pageNumber, endPage: pageNumber }).strict().optional(),
}).strict();
const noteSchema = z.object({ title, page: pageNumber, content: z.string().max(1500), stageId: uuid.optional(), provenance: z.enum(["source", "ai"]).optional() }).strict();
const draftSchema = z.object({
  title, originalFilename: z.string().min(1).max(1000), pageCount: pageNumber, goal: z.string().max(500), weeklyHours: z.number().int().min(1).max(80).nullable(),
  stages: z.array(stageSchema).min(1).max(60),
  notes: z.array(noteSchema).max(60),
  references: z.array(z.object({ title, page: pageNumber }).strict()).max(10000).optional(),
  warnings: z.array(z.string().max(2000)).max(1000), aiStatus: z.enum(["not-used", "complete", "failed"]), sourceFormat: format,
  deadlines: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), page: pageNumber, type: z.string().max(100), title }).strict()).max(10000).optional(),
  quality: quality.optional(),
}).strict();
const suggestionSchema = z.object({ stageId: uuid, title, tasks: z.array(z.string().trim().min(1).max(300)).min(1).max(20), notes: z.array(noteSchema.extend({ stageId: uuid, provenance: z.literal("ai") })).max(60) }).strict();
const candidateSchema = z.object({ id: uuid, baseRevision: z.number().int().nonnegative(), suggestions: z.array(suggestionSchema).min(1).max(60) }).strict();
const operationSchema = z.object({ id: uuid, status: z.enum(["running", "complete", "cancelled", "failed", "interrupted"]), startedAt: z.number().int().nonnegative(), candidate: candidateSchema.optional(), error: z.string().max(500).optional() }).strict();
const entrySchema = z.object({
  version: z.literal(1), id: uuid, courseId: z.string().regex(/^course-[a-z0-9-]+$/), revision: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  state: z.enum(["open", "committing", "committed"]), draft: draftSchema, source: sourceSchema, sourceExtension: ext,
  candidate: candidateSchema.optional(), operation: operationSchema.optional(), undo: z.object({ appliedRevision: z.number().int().nonnegative(), before: draftSchema }).strict().optional(),
}).strict().superRefine((entry, context) => {
  const invalid = () => context.addIssue({ code: "custom", message: "草稿来源、时间或页码不一致" });
  if (entry.expiresAt !== entry.createdAt + AGE_MS || entry.updatedAt < entry.createdAt || entry.updatedAt >= entry.expiresAt) invalid();
  if (entry.draft.pageCount !== entry.source.pageCount || entry.draft.sourceFormat !== entry.source.sourceFormat) invalid();
  if (entry.source.sourceFormat === "pdf" && (entry.source.pageCount > 1000 || entry.sourceExtension !== ".pdf")) invalid();
  if (entry.source.sourceFormat === "docx" && entry.sourceExtension !== ".docx") invalid();
  if (entry.source.sourceFormat === "text" && [".pdf", ".docx"].includes(entry.sourceExtension)) invalid();
  const count = entry.source.pageCount;
  if ([...entry.source.pages, ...entry.source.outline, ...entry.draft.notes, ...(entry.draft.references ?? []), ...(entry.draft.deadlines ?? [])].some((item) => item.page > count)) invalid();
  if (new Set(entry.source.pages.map((item) => item.page)).size !== entry.source.pages.length) invalid();
  const stageIds = new Set(entry.draft.stages.map((item) => item.id));
  if (stageIds.size !== entry.draft.stages.length || entry.draft.notes.some((note) => note.stageId && !stageIds.has(note.stageId))) invalid();
  if (entry.draft.stages.some((stage) => stage.source && (stage.source.startPage > stage.source.endPage || stage.source.endPage > count))) invalid();
  if (entry.operation && (entry.operation.startedAt < entry.createdAt || entry.operation.startedAt >= entry.expiresAt)) invalid();
  if (entry.undo && (entry.undo.appliedRevision !== entry.revision || entry.undo.before.pageCount !== count || entry.undo.before.sourceFormat !== entry.source.sourceFormat)) invalid();
  if (entry.candidate) {
    const ids = entry.candidate.suggestions.map((item) => item.stageId);
    if (entry.candidate.baseRevision !== entry.revision || new Set(ids).size !== ids.length || ids.some((id) => !stageIds.has(id)) || entry.candidate.suggestions.reduce((sum, item) => sum + item.notes.length, 0) > 60) invalid();
    if (entry.candidate.suggestions.some((item) => { const stage = entry.draft.stages.find((stage) => stage.id === item.stageId); return !stage?.source || item.notes.some((note) => note.stageId !== item.stageId || note.page < stage.source!.startPage || note.page > Math.min(stage.source!.endPage, stage.source!.startPage + 1)); })) invalid();
  }
  if (entry.operation?.candidate && !isDeepStrictEqual(entry.operation.candidate, entry.candidate)) invalid();
  for (const report of [entry.source.quality, entry.draft.quality]) {
    if (report && (entry.source.sourceFormat !== "pdf" || [report.noTextPages, report.sideNotePages, report.complexPages].some((pages) => pages.some((page) => page > count) || new Set(pages).size !== pages.length))) invalid();
  }
});

export class DraftStoreError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const unsafe = () => new DraftStoreError("草稿存储路径或内容不安全，无法恢复", 422);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** All paths are derived from trusted IDs; a snapshot can never choose a path. */
export class DraftStore {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly projectRoot: string;
  constructor(root: string, private readonly now: () => number = Date.now) { this.projectRoot = path.resolve(root); }

  private validateId(id: string): void {
    if (!uuidPattern.test(id)) throw new DraftStoreError("草稿 ID 无效", 400);
  }

  private async directory(candidate: string, create = false): Promise<string> {
    if (create) await fs.mkdir(candidate).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const details = await fs.lstat(candidate);
    if (details.isSymbolicLink() || !details.isDirectory()) throw unsafe();
    const actual = await fs.realpath(candidate);
    const parent = await fs.realpath(path.dirname(candidate));
    if (path.dirname(actual) !== parent) throw unsafe();
    return candidate;
  }

  private async base(create = false): Promise<string> {
    // Reject an intermediate junction, not just a symlink on the last file.
    await this.directory(this.projectRoot);
    await this.directory(path.join(this.projectRoot, ".learning-loop"), create);
    return this.directory(path.join(this.projectRoot, ".learning-loop", "imports"), create);
  }

  private async draftDirectory(id: string): Promise<string> {
    this.validateId(id);
    return this.directory(path.join(await this.base(), id));
  }

  private async file(candidate: string, maxBytes: number): Promise<void> {
    const details = await fs.lstat(candidate);
    if (!details.isFile() || details.isSymbolicLink() || details.size > maxBytes || path.dirname(await fs.realpath(candidate)) !== await fs.realpath(path.dirname(candidate))) throw unsafe();
  }

  private validate(entry: DraftEntry): DraftEntry {
    const result = entrySchema.safeParse(entry);
    if (!result.success || Buffer.byteLength(JSON.stringify(result.data)) > SNAPSHOT_BYTES) throw new DraftStoreError("草稿快照格式无效或超过 32 MiB，无法保存或恢复", 422);
    return result.data;
  }

  private async atomicWrite(dir: string, entry: DraftEntry): Promise<void> {
    const temporary = path.join(dir, `.state-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(entry), { flag: "wx" });
      await fs.rename(temporary, path.join(dir, "state.json"));
    } finally { await fs.unlink(temporary).catch((error) => { if (!missing(error)) throw error; }); }
  }

  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.locks.set(id, next);
    void next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id); }).catch(() => {});
    return next;
  }

  async create(entry: DraftEntry, bytes: Uint8Array): Promise<void> {
    this.validateId(entry.id);
    const valid = this.validate(entry);
    const sizes: Record<string, number> = { ".pdf": 100, ".docx": 50, ".html": 20, ".htm": 20, ".md": 10, ".txt": 10, ".markdown": 10 };
    if (bytes.length > sizes[entry.sourceExtension] * 1024 * 1024) throw new DraftStoreError("原文件超过该格式的大小限制", 413);
    await this.serial(entry.id, async () => {
      const dir = path.join(await this.base(true), entry.id);
      await fs.mkdir(dir); // exclusive ownership; never overwrite another draft
      try {
        await fs.writeFile(path.join(dir, `source${entry.sourceExtension}`), bytes, { flag: "wx" });
        await this.atomicWrite(dir, valid);
      } catch (error) {
        await this.removeDirectory(dir).catch(() => {});
        throw error;
      }
    });
  }

  async read(id: string, options: { includeExpired?: boolean } = {}): Promise<DraftEntry> {
    this.validateId(id);
    try {
      const dir = await this.draftDirectory(id);
      const snapshot = path.join(dir, "state.json");
      await this.file(snapshot, SNAPSHOT_BYTES);
      let entry: DraftEntry;
      try { entry = this.validate(JSON.parse(await fs.readFile(snapshot, "utf8"))); }
      catch (error) { if (error instanceof DraftStoreError) throw error; throw new DraftStoreError("草稿快照损坏，无法恢复，请删除后重新上传", 422); }
      if (entry.id !== id) throw unsafe();
      if (!options.includeExpired && this.now() >= entry.expiresAt) throw new DraftStoreError("导入草稿已过期，请重新上传", 410);
      return entry;
    } catch (error) {
      if (missing(error)) throw new DraftStoreError("导入草稿不存在或来源文件缺失", 404);
      throw error;
    }
  }

  async list(): Promise<DraftSummary[]> {
    let base: string;
    try { base = await this.base(); } catch (error) { if (missing(error)) return []; throw error; }
    const summaries: DraftSummary[] = [];
    for (const name of await fs.readdir(base)) {
      if (!uuidPattern.test(name)) continue;
      try {
        const entry = await this.read(name);
        if (entry.state === "committed") continue;
        await this.sourcePath(name);
        summaries.push({ id: name, title: entry.draft.title, updatedAt: entry.updatedAt, expiresAt: entry.expiresAt, status: "ready" });
      } catch (error) {
        if (error instanceof DraftStoreError && error.status === 410) continue;
        const details = await fs.lstat(path.join(base, name));
        summaries.push({ id: name, title: "无法恢复的草稿", updatedAt: details.mtimeMs, expiresAt: details.mtimeMs + AGE_MS, status: "invalid", warning: "快照或来源文件损坏，不能创建课程；可删除后重新上传。" });
      }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async replace(entry: DraftEntry, expectedRevision: number, options: { includeExpired?: boolean; metadataOnly?: boolean } = {}): Promise<void> {
    this.validateId(entry.id);
    const valid = this.validate(entry);
    await this.serial(entry.id, async () => {
      const existing = await this.read(entry.id, options);
      if (existing.revision !== expectedRevision) throw new DraftStoreError("草稿已在其他页面更新，请重新载入后再试", 409);
      if (entry.revision !== expectedRevision + (options.metadataOnly ? 0 : 1) || entry.courseId !== existing.courseId || entry.createdAt !== existing.createdAt || entry.expiresAt !== existing.expiresAt || entry.sourceExtension !== existing.sourceExtension || !isDeepStrictEqual(entry.source, existing.source)) throw unsafe();
      if (options.metadataOnly && (entry.state !== existing.state || !isDeepStrictEqual(entry.draft, existing.draft))) throw unsafe();
      await this.atomicWrite(await this.draftDirectory(entry.id), valid);
    });
  }

  private async removeDirectory(dir: string): Promise<void> {
    await this.directory(dir);
    if (!uuidPattern.test(path.basename(dir)) || path.dirname(dir) !== await this.base()) throw unsafe();
    const names = await fs.readdir(dir);
    for (const name of names) {
      const target = path.join(dir, name);
      const details = await fs.lstat(target);
      if (details.isDirectory() && !details.isSymbolicLink()) throw unsafe();
    }
    // unlink removes a file link itself, never follows it to outside content.
    for (const name of names) await fs.unlink(path.join(dir, name));
    await fs.rmdir(dir);
  }

  async delete(id: string): Promise<void> {
    this.validateId(id);
    await this.serial(id, async () => this.removeDirectory(await this.draftDirectory(id)));
  }

  async cleanupExpired(preserveIds: ReadonlySet<string> = new Set()): Promise<void> {
    const base = await this.base(true);
    for (const name of await fs.readdir(base)) {
      if (preserveIds.has(name)) continue;
      const target = path.join(base, name);
      const details = await fs.lstat(target);
      if (details.isSymbolicLink()) continue;
      if (details.isFile() && /^[0-9a-f-]{36}\.(pdf|docx|md|txt|markdown|html|htm)$/.test(name)) {
        if (this.now() - details.mtimeMs >= 24 * 60 * 60 * 1000) await fs.unlink(target);
        continue;
      }
      if (!details.isDirectory() || !uuidPattern.test(name)) continue;
      try { await this.read(name); }
      catch (error) {
        if ((error instanceof DraftStoreError && error.status === 410) || this.now() - details.mtimeMs >= AGE_MS) await this.delete(name);
      }
    }
  }

  async sourcePath(id: string): Promise<string> {
    const entry = await this.read(id);
    const candidate = path.join(await this.draftDirectory(id), `source${entry.sourceExtension}`);
    const sizes: Record<string, number> = { ".pdf": 100, ".docx": 50, ".html": 20, ".htm": 20, ".md": 10, ".txt": 10, ".markdown": 10 };
    try { await this.file(candidate, sizes[entry.sourceExtension] * 1024 * 1024); }
    catch (error) { if (missing(error)) throw new DraftStoreError("草稿原文件缺失，请重新上传", 404); throw error; }
    return candidate;
  }
}
