// @vitest-environment node

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { WorkspaceRepository } from "./workspace-repository.js";

const courseMarkdown = `---
id: test-course
title: 测试课程
shortTitle: 测试
accent: "#27624B"
updated: 2026-08-29
order: 1
archived: false
---
# 测试课程
## 课程概览
课程概览。
## 学习路线
### 第一阶段
- [x] 已完成任务
- [ ] 待完成任务
## 关键知识
知识。
## 易错点
暂无。
## 学习记录
| 日期 | 学习内容 | 掌握度 1-10 | 遇到困难 | 下一步 |
| --- | --- | ---: | --- | --- |
| 2026-08-29 | 完成练习 | 8 | 无 | 下一题 |
`;

const artifact = (kind: "notes" | "reviews" | "resources" | "schedule") => ({
  notes: `---\ncourseId: test-course\nupdated: 2026-08-29\n---\n# 笔记\n## 主题一\n正文`,
  reviews: `---\ncourseId: test-course\nupdated: 2026-08-29\n---\n# 复习\n| 知识点 | 上次复习 | 下次复习 | 掌握度 1-10 | 复习证据 |\n| --- | --- | --- | ---: | --- |\n| 主题一 | 2026-08-28 | 2026-08-29 | 8 | 主动回忆 |`,
  resources: `---\ncourseId: test-course\nupdated: 2026-08-29\n---\n# 资源\n| 名称 | 类型 | URL 或本地路径 | 对应阶段 | 使用状态 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n| 教材 | 教材 | C:\\book.pdf | 第一阶段 | 使用中 | 主教材 |`,
  schedule: `---\ncourseId: test-course\nupdated: 2026-08-29\n---\n# 日程\n| 日期 | 类型 | 标题 | 对应阶段 | 状态 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n| 2026-08-30 | 作业 | 完成实验 | 第一阶段 | 计划中 |  |`,
})[kind];

async function makeWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-repository-"));
  const courseRoot = path.join(root, "course");
  await mkdir(path.join(courseRoot, "sessions"), { recursive: true });
  await writeFile(path.join(courseRoot, "course.md"), courseMarkdown);
  for (const kind of ["notes", "reviews", "resources", "schedule"] as const) {
    await writeFile(path.join(courseRoot, `${kind}.md`), artifact(kind));
  }
  await writeFile(path.join(courseRoot, "sessions", "2026-08-29.md"), "# session");
  return { root, courseRoot };
}

describe("WorkspaceRepository", () => {
  it("从配置课程生成全部聚合视图且不重复计算 session", async () => {
    const { root, courseRoot } = await makeWorkspace();
    const repository = new WorkspaceRepository({ configPath: path.join(root, "dashboard.config.json"), courses: [{ id: "test-course", root: courseRoot, enabled: true }] }, () => "2026-08-29");

    const courses = await repository.getCourses();
    const notes = await repository.getNotes();
    const tasks = await repository.getTasks();
    const reviews = await repository.getReviews();
    const calendar = await repository.getCalendar("2026-08");
    const stats = await repository.getStats();

    expect(courses.courses[0]).toMatchObject({ id: "test-course", title: "测试课程", shortTitle: "测试", progress: 50, mastery: 8 });
    expect(notes[0]).toMatchObject({ courseId: "test-course", title: "测试课程", accent: "#27624B" });
    expect(tasks).toHaveLength(2);
    expect(reviews[0]).toMatchObject({ topic: "主题一", status: "today" });
    expect(calendar.map((event) => event.kind).sort()).toEqual(["record", "review", "schedule"]);
    expect(stats).toMatchObject({ completedTasks: 1, totalTasks: 2, recordCount: 1, dueReviewCount: 1 });
    const settings = await repository.getSettings();
    expect(settings.courses[0].artifacts.find((item) => item.artifact === "sessions")).toMatchObject({ status: "ready", count: 1 });
  });

  it("辅助文件暂时损坏时保留上次成功数据和文件警告", async () => {
    const { root, courseRoot } = await makeWorkspace();
    const repository = new WorkspaceRepository({ configPath: path.join(root, "dashboard.config.json"), courses: [{ id: "test-course", root: courseRoot, enabled: true }] }, () => "2026-08-29");
    expect(await repository.getResources()).toHaveLength(1);

    await writeFile(path.join(courseRoot, "resources.md"), "---\ncourseId: broken");
    await repository.refresh("test-course", "resources");

    expect(await repository.getResources()).toHaveLength(1);
    const settings = await repository.getSettings();
    expect(settings.courses[0].artifacts.find((item) => item.artifact === "resources")?.warning).toContain("保留上次成功数据");
  });
});
