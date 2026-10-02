import { describe, expect, it } from "vitest";

import { parseCourseMarkdown } from "./course-parser.js";
import { parseNotesMarkdown, parseResourcesMarkdown, parseReviewsMarkdown, parseScheduleMarkdown } from "./artifact-parser.js";
import { buildCourseFiles, createBasicDraft } from "./course-import.js";

describe("PDF course draft", () => {
  const source = {
    title: "微积分基础",
    pageCount: 12,
    pages: [
      { page: 1, text: "微积分基础\n第一章 极限\n极限描述函数的趋近过程。" },
      { page: 6, text: "第二章 导数\n导数描述瞬时变化率。" },
    ],
    outline: [{ title: "第一章 极限", page: 1 }, { title: "第二章 导数", page: 6 }],
    warnings: [],
    sourceFormat: "pdf" as const,
  };

  const textSource = {
    title: "算法笔记",
    pageCount: 3,
    pages: [
      { page: 1, text: "# 算法笔记\n## 排序\n排序是基本算法。" },
    ],
    outline: [{ title: "排序", page: 1 }],
    warnings: [],
    sourceFormat: "text" as const,
  };

  it("creates source-grounded stages and parseable files without invented progress or dates", () => {
    const draft = createBasicDraft(source, "微积分.pdf");
    expect(draft.stages.map((stage) => stage.title)).toEqual(["第一章 极限", "第二章 导数"]);
    expect(draft.stages[0].tasks[0]).toContain("第 1 页");
    const files = buildCourseFiles({ ...draft, title: "我的微积分", goal: "掌握基础概念", weeklyHours: 4 }, "course-abc", "2026-09-26");
    const course = parseCourseMarkdown(files["course.md"], "course.md");
    expect(course.title).toBe("我的微积分");
    expect(course.stages).toHaveLength(2);
    expect(course.records).toEqual([]);
    const notes = parseNotesMarkdown(files["notes.md"], "notes.md");
    expect(notes.courseId).toBe("course-abc");
    expect(notes.headings).toEqual(["第一章 极限", "第二章 导数"]);
    expect(parseReviewsMarkdown(files["reviews.md"], "reviews.md", "2026-09-26").items).toEqual([]);
    expect(parseScheduleMarkdown(files["schedule.md"], "schedule.md").items).toEqual([]);
    expect(parseResourcesMarkdown(files["resources.md"], "resources.md").items[0].location).toBe("/api/courses/course-abc/source");
  });

  it("falls back to an honest reading task when the PDF has no usable outline", () => {
    const draft = createBasicDraft({ ...source, outline: [] }, "教材.pdf");
    expect(draft.stages).toMatchObject([{ title: "阅读原始 PDF", tasks: ["阅读原始 PDF，并标记需要进一步学习的章节（共 12 页）"] }]);
  });

  it("binds generated stages to physical chapter ranges and notes to stable IDs", () => {
    const draft = createBasicDraft({ ...source, outline: [...source.outline, { title: "附录", page: 10 }], quality: { version: 1 as const, noTextPages: [3], sideNotePages: [6], complexPages: [6] } }, "book.pdf");
    expect(draft.stages[0].id).toEqual(expect.any(String));
    expect(new Set(draft.stages.map((stage) => stage.id)).size).toBe(2);
    expect(draft.stages.map((stage) => stage.source)).toEqual([
      { title: "第一章 极限", startPage: 1, endPage: 5 },
      { title: "第二章 导数", startPage: 6, endPage: 9 },
    ]);
    expect(draft.notes[0]).toMatchObject({ stageId: draft.stages[0].id, provenance: "source" });
    expect(draft.quality).toEqual({ version: 1, noTextPages: [3], sideNotePages: [6], complexPages: [6] });
    const moved = [...draft.stages].reverse();
    moved[0] = { ...moved[0], title: "改名" };
    expect(moved[0].id).toBe(draft.stages[1].id);
    expect(moved[0].source).toEqual({ title: "第二章 导数", startPage: 6, endPage: 9 });
    expect(buildCourseFiles({ ...draft, stages: moved }, "course-book", "2026-10-01")["resources.md"]).toContain("#page=10");
  });

  it("excludes front matter from PDF stages and keeps appendix excerpts as references", () => {
    const draft = createBasicDraft({ ...source, pages: [...source.pages, { page: 12, text: "附录 线性代数资料" }], outline: [
      { title: "目 录", page: 1 }, { title: "主要符号表", page: 1 }, { title: "前言", page: 1 },
      ...source.outline, { title: "附录", page: 12 },
    ] }, "textbook.pdf");
    expect(draft.stages.map((stage) => stage.title)).toEqual(["第一章 极限", "第二章 导数"]);
    expect(draft.notes).toContainEqual(expect.objectContaining({ title: "参考：附录", page: 12, content: "附录 线性代数资料", provenance: "source" }));
    const files = buildCourseFiles(draft, "course-book", "2026-10-01");
    expect(parseNotesMarkdown(files["notes.md"], "notes.md").headings).toContain("参考：附录");
    expect(parseResourcesMarkdown(files["resources.md"], "resources.md").items).toContainEqual(expect.objectContaining({ location: "/api/courses/course-book/source#page=12" }));
  });

  it("does not suppress legitimately named topics in non-PDF imports", () => {
    const draft = createBasicDraft({ ...textSource, outline: [{ title: "目录", page: 1 }] }, "directory.md");
    expect(draft.stages[0].title).toBe("目录");
  });

  it("excludes explicit English symbol-table titles but not a chapter about symbols", () => {
    const draft = createBasicDraft({ ...source, outline: [
      { title: "List of Symbols", page: 1 }, { title: "Notation", page: 1 },
      { title: "Chapter 1: Symbols", page: 6 },
    ] }, "symbols.pdf");
    expect(draft.stages.map((stage) => stage.title)).toEqual(["Chapter 1: Symbols"]);
  });

  it("reserves appendix excerpts and links when chapter excerpts reach the limit", () => {
    const outline = Array.from({ length: 60 }, (_, i) => ({ title: `Chapter ${i + 1}`, page: i + 1 }));
    outline.push({ title: "Appendix A", page: 61 });
    const draft = createBasicDraft({ ...source, pageCount: 61, outline,
      pages: outline.map((item) => ({ page: item.page, text: `${item.title} source text` })),
    }, "large.pdf");
    expect(draft.stages).toHaveLength(60);
    expect(draft.notes).toHaveLength(60);
    expect(draft.notes).toContainEqual(expect.objectContaining({ title: "参考：Appendix A", page: 61 }));
    expect(buildCourseFiles(draft, "course-large", "2026-10-01")["resources.md"]).toContain("/source#page=61");
  });

  it("keeps appendix links even if the appendix page has no extractable text", () => {
    const draft = createBasicDraft({ ...source, outline: [...source.outline, { title: "Appendix A", page: 12 }] }, "book.pdf");
    expect(draft.notes.some((note) => note.page === 12)).toBe(false);
    expect(buildCourseFiles(draft, "course-book", "2026-10-01")["resources.md"]).toContain("/source#page=12");
  });

  it("preserves PDF excerpt line breaks without turning formulas or Markdown into structure", () => {
    const text = "First paragraph\ncontinued\n\n## 学习记录\n```\nx_i = y^2\n```";
    const draft = createBasicDraft({ ...source, pages: [{ page: 1, text }], outline: [{ title: "第一章", page: 1 }] }, "layout.pdf");
    expect(draft.notes[0].content).toBe(text);
    const files = buildCourseFiles(draft, "course-lines", "2026-10-01");
    const course = parseCourseMarkdown(files["course.md"], "course.md");
    expect(course.records).toEqual([]);
    expect(course.stages).toHaveLength(1);
    expect(parseNotesMarkdown(files["notes.md"], "notes.md").headings).toEqual(["第一章"]);
    expect(files["notes.md"]).toContain("First paragraph\ncontinued\n\n## 学习记录");
    expect(files["notes.md"]).toContain("````text");
  });

  it("does not let user goal or AI note text create fake Markdown sections", () => {
    const draft = createBasicDraft(source, "course.pdf");
    draft.goal = "理解极限\n## 学习路线\n### 伪造章节\n- [x] 完成";
    draft.notes = [{ title: "极限", page: 1, content: "原文摘要\n## 学习记录\n| 2026-01-01 | 虚假记录 | 10 | | |" }];
    const course = parseCourseMarkdown(buildCourseFiles(draft, "course-safe", "2026-09-26")["course.md"], "course.md");
    expect(course.stages.map((stage) => stage.title)).toEqual(["第一章 极限", "第二章 导数"]);
    expect(course.records).toEqual([]);
  });

  it("adds only explicit PDF deadlines to the schedule", () => {
    const draft = createBasicDraft({ ...source, pages: [...source.pages, { page: 9, text: "作业截止日期：2026-10-01。请提交习题。" }] }, "course.pdf");
    const schedule = parseScheduleMarkdown(buildCourseFiles(draft, "course-dates", "2026-09-26")["schedule.md"], "schedule.md");
    expect(schedule.items).toMatchObject([{ date: "2026-10-01", note: "原 PDF 第 9 页" }]);
  });

  it("handles text source format with correct labels", () => {
    const draft = createBasicDraft(textSource, "notes.md");
    expect(draft.sourceFormat).toBe("text");
    expect(draft.warnings.some((w) => w.includes("纯文本"))).toBe(true);
    const files = buildCourseFiles({ ...draft, title: "算法课" }, "course-text", "2026-09-26");
    expect(files["resources.md"]).toContain("TEXT");
    expect(files["course.md"]).toContain("文本文件");
    expect(files["course.md"]).toContain("第 1 段文本");
    expect(files["course.md"]).not.toContain("第 1 页");
  });
});
