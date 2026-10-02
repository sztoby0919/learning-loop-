import type { AiExcerpt, AiOperation, AiSuggestion, ImportDraft } from "../shared/course-import.js";
import type { DraftStore } from "./course-import-store.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { buildAiExcerpt } from "./course-import-excerpt.js";
import { CourseImportAiError, validateAiSuggestions } from "./course-import-ai.js";
import type { DraftEntry } from "../shared/course-import.js";
export type ImportAiEnricher = (excerpt: AiExcerpt, draft: ImportDraft, signal: AbortSignal) => Promise<AiSuggestion[]>;
const startSchema = z.object({ expectedRevision: z.number().int().nonnegative(), stageIds: z.array(z.string().uuid()).min(1).max(60), excerptHash: z.string().regex(/^[a-f0-9]{64}$/), consent: z.literal(true) }).strict();
export class ImportAiOperations {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly controllers = new Map<string, { operationId: string; controller: AbortController }>();
  constructor(private readonly store: DraftStore, private readonly enricher: () => ImportAiEnricher | undefined) {}
  isLocked(id: string): boolean { return this.locks.has(id); }

  async withLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.locks.set(id, current);
    try { return await current; } finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }
  assertEditable(entry: DraftEntry): void {
    if (entry.state !== "open" || entry.operation?.status === "running") throw new CourseImportAiError("草稿正在处理，请先等待或取消 AI 请求", 409);
  }
  async start(id: string, input: unknown): Promise<AiOperation> {
    return this.withLock(id, async () => {
      const parsed = startSchema.safeParse(input);
      if (!parsed.success) throw new CourseImportAiError("请先查看发送范围并明确同意，再提交有效的修订号与摘录 hash", 400);
      const entry = await this.store.read(id); this.assertEditable(entry);
      if (entry.revision !== parsed.data.expectedRevision) throw new CourseImportAiError("草稿已更新，请重新查看发送范围", 409);
      const excerpt = buildAiExcerpt(entry, parsed.data.stageIds);
      if (excerpt.excerptHash !== parsed.data.excerptHash) throw new CourseImportAiError("发送摘录已变化，请重新查看并同意", 409);
      const ai = this.enricher();
      if (!ai) throw new CourseImportAiError("未配置真实模型 API，仍可创建基础课程", 503);
      const operation: AiOperation = { id: randomUUID(), startedAt: Date.now(), status: "running" };
      await this.store.replace({ ...entry, candidate: undefined, operation, updatedAt: Date.now() }, entry.revision, { metadataOnly: true });
      const controller = new AbortController();
      this.controllers.set(id, { operationId: operation.id, controller });
      void this.run(entry, excerpt, operation, controller, ai).catch(() => { /* Storage failure is visible as running until cancellation/restart; never log upstream secrets. */ });
      return operation;
    });
  }

  private async run(entry: DraftEntry, excerpt: AiExcerpt, operation: AiOperation, controller: AbortController, ai: ImportAiEnricher): Promise<void> {
    const timer = setTimeout(() => controller.abort(new CourseImportAiError("模型服务请求超时（90 秒），草稿已保留，可主动重试", 504)), 90000);
    timer.unref?.();
    let abortListener: (() => void) | undefined;
    let suggestions: AiSuggestion[] | undefined;
    let error: string | undefined;
    try {
      const abort = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(controller.signal.reason ?? new DOMException("Aborted", "AbortError"));
        controller.signal.addEventListener("abort", abortListener, { once: true });
        if (controller.signal.aborted) abortListener();
      });
      suggestions = validateAiSuggestions(await Promise.race([Promise.resolve().then(() => ai(excerpt, entry.draft, controller.signal)), abort]), excerpt);
    } catch (cause) {
      error = cause instanceof CourseImportAiError ? cause.message : "AI 完善失败，草稿已保留；请检查模型服务后主动重试";
    } finally {
      clearTimeout(timer);
      if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      if (this.controllers.get(entry.id)?.operationId === operation.id) this.controllers.delete(entry.id);
    }
    await this.withLock(entry.id, async () => {
      const current = await this.store.read(entry.id);
      if (current.operation?.id !== operation.id || current.operation.status !== "running") return;
      if (current.revision !== excerpt.revision) { error = "草稿修订已变化，候选未保存，请重新请求"; suggestions = undefined; }
      const candidate = suggestions && !controller.signal.aborted ? { id: randomUUID(), baseRevision: current.revision, suggestions } : undefined;
      const finished: AiOperation = { ...operation, status: candidate ? "complete" : "failed", ...(candidate ? { candidate } : { error: error ?? "请求已中断，草稿已保留" }) };
      await this.store.replace({ ...current, operation: finished, candidate, updatedAt: Date.now() }, current.revision, { metadataOnly: true });
    });
  }
  async get(id: string, operationId: string): Promise<AiOperation> {
    const entry = await this.store.read(id);
    if (!entry.operation || entry.operation.id !== operationId) throw new CourseImportAiError("AI 操作不存在或已被新的操作替代", 404);
    return entry.operation;
  }
  async cancel(id: string, operationId: string): Promise<AiOperation> {
    return this.withLock(id, async () => {
      const entry = await this.store.read(id);
      if (entry.operation?.id !== operationId) throw new CourseImportAiError("AI 操作不存在或已被替代", 404);
      if (entry.operation.status !== "running") return entry.operation;
      const cancelled: AiOperation = { ...entry.operation, status: "cancelled", error: "模型请求已取消；不保证上游停止计费" };
      await this.store.replace({ ...entry, operation: cancelled, candidate: undefined, updatedAt: Date.now() }, entry.revision, { metadataOnly: true });
      this.controllers.get(id)?.controller.abort();
      return cancelled;
    });
  }
  async recover(): Promise<void> {
    for (const summary of await this.store.list()) {
      if (summary.status !== "ready") continue;
      const entry = await this.store.read(summary.id);
      if (entry.operation?.status === "running") await this.store.replace({ ...entry, candidate: undefined, operation: { ...entry.operation, status: "interrupted", error: "服务重启导致请求中断，请主动重试；不会自动重新调用模型" }, updatedAt: Date.now() }, entry.revision, { metadataOnly: true });
    }
  }
}
