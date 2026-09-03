import { describe, expect, it } from "vitest";

import { parseNotesMarkdown, parseResourcesMarkdown, parseReviewsMarkdown, parseScheduleMarkdown } from "./artifact-parser.js";

describe("辅助学习文件解析", () => {
  it("解析笔记正文和二级标题目录", () => {
    const result = parseNotesMarkdown(`---\ncourseId: cs336\nupdated: 2026-08-29\n---\n# CS336 笔记\n## Tokenization\n正文\n## Training\n更多正文`, "notes.md");
    expect(result).toMatchObject({ courseId: "cs336", updated: "2026-08-29", headings: ["Tokenization", "Training"] });
    expect(result.markdown).toContain("## Tokenization");
  });

  it("复习空日期和空掌握度保持 null，并按上海日期计算状态", () => {
    const markdown = `---\ncourseId: cs336\nupdated: 2026-08-29\n---\n# 复习\n| 知识点 | 上次复习 | 下次复习 | 掌握度 1-10 | 复习证据 |\n| --- | --- | --- | ---: | --- |\n| 空计划 |  |  |  | 尚未安排 |\n| 今日项 | 2026-08-28 | 2026-08-29 | 7 | 主动回忆 |\n| 逾期项 | 2026-08-20 | 2026-08-28 | 6 | 小测 |`;
    const result = parseReviewsMarkdown(markdown, "reviews.md", "2026-08-29");
    expect(result.items[0]).toMatchObject({ lastReviewed: null, nextReview: null, mastery: null, status: "unscheduled" });
    expect(result.items[1].status).toBe("today");
    expect(result.items[2].status).toBe("overdue");
  });

  it("解析资源和日程标准表格", () => {
    const resources = parseResourcesMarkdown(`---\ncourseId: cs336\nupdated: 2026-08-29\n---\n# 资源\n| 名称 | 类型 | URL 或本地路径 | 对应阶段 | 使用状态 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n| 官网 | 课程 | https://example.com | 全课程 | 使用中 | 官方 |`, "resources.md");
    const schedule = parseScheduleMarkdown(`---\ncourseId: cs336\nupdated: 2026-08-29\n---\n# 日程\n| 日期 | 类型 | 标题 | 对应阶段 | 状态 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n| 2026-09-01 | 作业 | 完成实验 | 阶段 1 | 计划中 |  |`, "schedule.md");
    expect(resources.items[0]).toMatchObject({ name: "官网", location: "https://example.com", status: "使用中" });
    expect(schedule.items[0]).toMatchObject({ date: "2026-09-01", title: "完成实验", status: "计划中" });
  });
});
