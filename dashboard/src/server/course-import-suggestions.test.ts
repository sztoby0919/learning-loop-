import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DraftEntry } from "../shared/course-import.js";
import { createBasicDraft } from "./course-import.js";
import { applyAiSuggestions, undoAiSuggestions } from "./course-import-suggestions.js";

function entry(): DraftEntry {
  const source = { title: "Book", pageCount: 3, sourceFormat: "pdf" as const, pages: [{ page: 1, text: "Chapter 1 original" }, { page: 2, text: "Chapter 2 original" }, { page: 3, text: "Appendix original" }], outline: [{ title: "Chapter 1", page: 1 }, { title: "Chapter 2", page: 2 }, { title: "Appendix", page: 3 }], warnings: [] };
  const now = Date.now(); const draft = createBasicDraft(source, "book.pdf");
  return { version: 1, id: randomUUID(), courseId: "course-test", revision: 0, createdAt: now, updatedAt: now, expiresAt: now + 7 * 86400000, state: "open", source, sourceExtension: ".pdf", draft,
    candidate: { id: randomUUID(), baseRevision: 0, suggestions: draft.stages.map((stage, index) => ({ stageId: stage.id!, title: "AI " + index, tasks: ["New task"], notes: [{ title: "AI note " + index, page: index + 1, content: "AI content", stageId: stage.id, provenance: "ai" }] })) } };
}
describe("chapter suggestion application", () => {
  it("applies only accepted chapters and keeps all unrelated draft data unchanged", () => {
    const before = entry(); const id = before.draft.stages[0].id!;
    const after = applyAiSuggestions(before, before.candidate!.id, [id], 0);
    expect(after.revision).toBe(1); expect(after.candidate).toBeUndefined();
    expect(after.draft.stages[0]).toMatchObject({ id, title: "AI 0", source: before.draft.stages[0].source });
    expect(after.draft.stages[1]).toEqual(before.draft.stages[1]);
    expect(after.draft.notes.filter((note) => note.stageId !== id)).toEqual(before.draft.notes.filter((note) => note.stageId !== id));
    expect(after.draft.notes.find((note) => note.stageId === id)).toMatchObject({ provenance: "ai", content: "AI content" });
    for (const key of ["title", "goal", "weeklyHours", "references", "quality", "deadlines", "warnings"] as const) expect(after.draft[key]).toEqual(before.draft[key]);
    expect(after.undo).toEqual({ appliedRevision: 1, before: before.draft });
    expect(before.draft.aiStatus).toBe("not-used");
  });
  it("refuses stale revisions, unknown or repeated accepted IDs, and repeated application", () => {
    const before = entry(); const id = before.draft.stages[0].id!;
    for (const [candidate, ids, revision] of [[randomUUID(), [id], 0], [before.candidate!.id, [randomUUID()], 0], [before.candidate!.id, [id, id], 0], [before.candidate!.id, [id], 1]] as const) expect(() => applyAiSuggestions(before, candidate, [...ids], revision)).toThrow();
    const after = applyAiSuggestions(before, before.candidate!.id, [id], 0);
    expect(() => applyAiSuggestions(after, before.candidate!.id, [id], 1)).toThrow();
  });
  it("undoes only the latest application with monotonically increasing revisions", () => {
    const before = entry(); const after = applyAiSuggestions(before, before.candidate!.id, [before.draft.stages[0].id!], 0);
    const undone = undoAiSuggestions(after, 1);
    expect(undone.revision).toBe(2); expect(undone.draft).toEqual(before.draft); expect(undone.undo).toBeUndefined();
    expect(() => undoAiSuggestions({ ...after, revision: 2 }, 2)).toThrow();
    expect(() => undoAiSuggestions(after, 0)).toThrow();
    expect(() => undoAiSuggestions(undone, 2)).toThrow();
  });
});
