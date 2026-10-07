import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DraftEntry } from "../shared/course-import.js";
import { createBasicDraft } from "./course-import.js";
import { buildAiExcerpt } from "./course-import-excerpt.js";

function entry(): DraftEntry {
  const source = { title: "Test", sourceFormat: "pdf" as const, pageCount: 8, outline: [{ title: "Chapter 1", page: 1 }, { title: "Chapter 2", page: 4 }, { title: "Appendix A", page: 7 }], pages: Array.from({ length: 8 }, (_, index) => ({ page: index + 1, text: `${index + 1}:` + "正文".repeat(1000) })), warnings: [] };
  const createdAt = Date.now();
  return { version: 1, id: randomUUID(), courseId: "course-test", revision: 0, createdAt, updatedAt: createdAt, expiresAt: createdAt + 7 * 86400000, state: "open", sourceExtension: ".pdf", source, draft: createBasicDraft(source, "test.pdf") };
}

describe("exact AI excerpt", () => {
  it("can preview AI input for an outline-free PDF using page-based stages", () => {
    const current = entry();
    current.source.outline = [];
    current.source.pages[0].text = "";
    current.source.pages[1].text = "";
    current.draft = createBasicDraft(current.source, "no-outline.pdf");
    const stage = current.draft.stages[0];
    const excerpt = buildAiExcerpt(current, [stage.id!]);
    expect(stage.source).toMatchObject({ startPage: 3, endPage: 5 });
    expect(excerpt.pages.map((page) => page.page)).toEqual([3, 4]);
    expect(excerpt.pages.every((page) => page.text.length <= 1200)).toBe(true);
    expect(excerpt.text).toContain("按页码");
    expect(excerpt.chars).toBeLessThanOrEqual(24000);
  });

  it("sends only the first two pages of the selected chapter and hashes its metadata", () => {
    const draft = entry(); const stageId = draft.draft.stages[1].id!;
    const excerpt = buildAiExcerpt(draft, [stageId]);
    expect(excerpt.stageIds).toEqual([stageId]);
    expect(excerpt.pages.map((item) => item.page)).toEqual([4, 5]);
    expect(excerpt.pages.every((item) => item.text.length <= 1200 && item.stageId === stageId)).toBe(true);
    for (const page of excerpt.pages) expect(excerpt.text).toContain(page.text);
    expect(excerpt.text).not.toContain("Appendix A");
    expect(excerpt.text).not.toContain(draft.draft.stages[0].id!);
    expect(excerpt.chars).toBe(excerpt.text.length);
    expect(buildAiExcerpt(draft, [stageId])).toEqual(excerpt);
    expect(buildAiExcerpt({ ...draft, draft: { ...draft.draft, goal: "new goal" } }, [stageId]).excerptHash).not.toBe(excerpt.excerptHash);
    expect(buildAiExcerpt({ ...draft, revision: 1 }, [stageId]).excerptHash).not.toBe(excerpt.excerptHash);
  });

  it("rejects empty, duplicated, unknown, manual and entirely empty chapter selections", () => {
    const draft = entry(); const id = draft.draft.stages[0].id!;
    for (const selection of [[], [id, id], [randomUUID()]]) expect(() => buildAiExcerpt(draft, selection)).toThrow();
    draft.draft.stages[0].source = undefined;
    expect(() => buildAiExcerpt(draft, [id])).toThrow(/来源/);
    draft.draft.stages[0].source = { title: "Chapter 1", startPage: 1, endPage: 3 };
    draft.source.pages[0].text = ""; draft.source.pages[1].text = " ";
    expect(() => buildAiExcerpt(draft, [id])).toThrow(/文字/);
  });

  it("keeps complete page markers within the overall twenty-four-thousand-character budget", () => {
    const draft = entry();
    draft.source.pageCount = 60; draft.draft.pageCount = 60;
    draft.source.pages = Array.from({ length: 60 }, (_, index) => ({ page: index + 1, text: "content".repeat(500) }));
    draft.draft.stages = Array.from({ length: 20 }, (_, index) => ({ id: randomUUID(), title: "Chapter " + index, tasks: ["Read"], source: { title: "Chapter " + index, startPage: index * 3 + 1, endPage: index * 3 + 3 } }));
    const excerpt = buildAiExcerpt(draft, draft.draft.stages.map((stage) => stage.id!));
    expect(excerpt.text.length).toBeLessThanOrEqual(24000);
    expect(new Set(excerpt.pages.map((item) => item.stageId)).size).toBe(20);
    for (const page of excerpt.pages) expect(excerpt.text).toContain(`[第 ${page.page} 页]\n${page.text}`);
    expect((excerpt.text.match(/\[第 \d+ 页\]/g) ?? []).length).toBe(excerpt.pages.length);
  });
});
