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
    expect(draft.stages).toEqual([{ title: "阅读原始 PDF", tasks: ["阅读原始 PDF，并标记需要进一步学习的章节（共 12 页）"] }]);
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
