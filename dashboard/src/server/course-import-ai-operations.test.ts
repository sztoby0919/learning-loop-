import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiSuggestion, DraftEntry } from "../shared/course-import.js";
import { createBasicDraft } from "./course-import.js";
import { DraftStore } from "./course-import-store.js";
import { buildAiExcerpt } from "./course-import-excerpt.js";
import { ImportAiOperations, type ImportAiEnricher } from "./course-import-ai-operations.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) { if (!root.startsWith(path.join(tmpdir(), "learning-loop-ai-ops-"))) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); } });
async function setup(ai: ImportAiEnricher) {
  const root = await mkdtemp(path.join(tmpdir(), "learning-loop-ai-ops-")); roots.push(root);
  const store = new DraftStore(root);
  const source = { title: "Book", pageCount: 2, pages: [{ page: 1, text: "Chapter 1 text" }, { page: 2, text: "More text" }], outline: [{ title: "Chapter 1", page: 1 }], warnings: [], sourceFormat: "pdf" as const };
  const createdAt = Date.now();
  const entry: DraftEntry = { version: 1, id: randomUUID(), courseId: "course-test", revision: 0, createdAt, updatedAt: createdAt, expiresAt: createdAt + 7 * 86400000, state: "open", source, sourceExtension: ".pdf", draft: createBasicDraft(source, "book.pdf") };
  await store.create(entry, new TextEncoder().encode("%PDF-test"));
  const excerpt = buildAiExcerpt(entry, [entry.draft.stages[0].id!]);
  const input = { consent: true, expectedRevision: 0, stageIds: excerpt.stageIds, excerptHash: excerpt.excerptHash };
  return { store, entry, input, operations: new ImportAiOperations(store, () => ai) };
}
const result = (entry: DraftEntry): AiSuggestion[] => [{ stageId: entry.draft.stages[0].id!, title: "AI chapter", tasks: ["Read source"], notes: [{ title: "AI note", page: 1, content: "AI summary" }] }];

describe("AI operation lifecycle", () => {
  it("rejects unconsented, stale revision and stale hash starts before any model call", async () => {
    const ai = vi.fn(); const { operations, entry, input } = await setup(ai);
    for (const change of [{ consent: false }, { expectedRevision: 1 }, { excerptHash: "b".repeat(64) }]) await expect(operations.start(entry.id, { ...input, ...change })).rejects.toMatchObject({ status: expect.any(Number) });
    expect(ai).not.toHaveBeenCalled();
  });
  it("starts once, returns a candidate without changing draft or revision", async () => {
    let release!: (value: AiSuggestion[]) => void;
    const ai = vi.fn(() => new Promise<AiSuggestion[]>((resolve) => { release = resolve; }));
    const { operations, store, entry, input } = await setup(ai);
    const started = await operations.start(entry.id, input);
    await expect(operations.start(entry.id, input)).rejects.toMatchObject({ status: 409 });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(started.status).toBe("running");
    release(result(entry));
    await vi.waitFor(async () => expect((await operations.get(entry.id, started.id)).status).toBe("complete"));
    const saved = await store.read(entry.id);
    expect(saved.revision).toBe(0); expect(saved.draft).toEqual(entry.draft);
    expect(saved.candidate?.baseRevision).toBe(0);
    expect(saved.candidate?.suggestions[0].notes[0]).toMatchObject({ stageId: entry.draft.stages[0].id, provenance: "ai" });
  });
  it("aborts the real signal and ignores results from an upstream that ignores cancellation", async () => {
    let release!: (value: AiSuggestion[]) => void; let signal!: AbortSignal;
    const { operations, entry, store, input } = await setup(async (_excerpt, _draft, supplied) => { signal = supplied; return new Promise((resolve) => { release = resolve; }); });
    const started = await operations.start(entry.id, input);
    expect((await operations.cancel(entry.id, started.id)).status).toBe("cancelled");
    expect(signal.aborted).toBe(true);
    release(result(entry));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await operations.get(entry.id, started.id)).status).toBe("cancelled");
    expect((await store.read(entry.id)).candidate).toBeUndefined();
  });
  it("times out at ninety seconds even if upstream ignores abort, without retrying", async () => {
    const ai = vi.fn(() => new Promise<AiSuggestion[]>(() => {}));
    const { operations, entry, store, input } = await setup(ai);
    vi.useFakeTimers();
    const started = await operations.start(entry.id, input);
    await vi.advanceTimersByTimeAsync(90000);
    vi.useRealTimers();
    await vi.waitFor(async () => expect((await operations.get(entry.id, started.id)).status).toBe("failed"));
    expect((await store.read(entry.id)).operation?.error).toContain("90 秒");
    expect(ai).toHaveBeenCalledTimes(1);
  });
  it("marks a persisted running operation interrupted on restart without resending", async () => {
    const ai = vi.fn(); const { store, operations, entry } = await setup(ai);
    await store.replace({ ...entry, revision: 1, operation: { id: randomUUID(), startedAt: Date.now(), status: "running" } }, 0);
    await operations.recover();
    expect((await store.read(entry.id)).operation?.status).toBe("interrupted");
    expect((await store.read(entry.id)).revision).toBe(1);
    expect(ai).not.toHaveBeenCalled();
  });
  it("stores sanitized failure messages instead of arbitrary upstream secrets", async () => {
    const { operations, entry, store, input } = await setup(async () => { throw new Error("Authorization: Bearer private-key"); });
    const started = await operations.start(entry.id, input);
    await vi.waitFor(async () => expect((await operations.get(entry.id, started.id)).status).toBe("failed"));
    expect(JSON.stringify(await store.read(entry.id))).not.toContain("private-key");
    expect((await store.read(entry.id)).draft).toEqual(entry.draft);
  });
});
