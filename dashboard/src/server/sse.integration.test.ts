// @vitest-environment node

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { CourseEventBus } from "./course-events.js";
import { startCourseWatcher } from "./course-watcher.js";
import { WorkspaceRepository } from "./workspace-repository.js";

const markdown = (checked: boolean) => `---
id: compiler-principles
title: 编译原理
accent: "#27624B"
updated: 2026-08-28
---
# 编译原理
## 课程概览
课程概览。
## 学习路线
### 词法分析
- [${checked ? "x" : " "}] 完成 Lexer
## 关键知识
关键知识。
## 易错点
暂无。
## 学习记录
| 日期 | 学习内容 | 掌握度 1-10 | 遇到困难 | 下一步 |
| --- | --- | ---: | --- | --- |
`;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("SSE journal updates", () => {
  it("notes.md 修改后推送带课程和文件类型的 journal-updated", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "study-dashboard-sse-"));
    const directory = path.join(root, "compiler-principles");
    const sourcePath = path.join(directory, "course.md");
    await mkdir(directory, { recursive: true });
    await writeFile(sourcePath, markdown(false), "utf8");
    const notesPath = path.join(directory, "notes.md");
    await writeFile(notesPath, "---\ncourseId: compiler-principles\nupdated: 2026-08-29\n---\n# 笔记\n## 初始\n正文", "utf8");

    const repository = new WorkspaceRepository({ configPath: path.join(root, "dashboard.config.json"), courses: [{ id: "compiler-principles", root: directory, enabled: true }] }, () => "2026-08-29");
    await repository.getCourse("compiler-principles");
    await repository.getNotes();
    const events = new CourseEventBus();
    const watcher = startCourseWatcher(repository, events);
    const server = createApp(repository, events).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanups.push(async () => { await watcher.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });

    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器未获得端口");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/events`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE 响应没有 body");
    await reader.read();

    await writeFile(notesPath, "---\ncourseId: compiler-principles\nupdated: 2026-08-29\n---\n# 笔记\n## 更新后\n正文", "utf8");
    const eventText = await Promise.race([
      reader.read().then(({ value }) => new TextDecoder().decode(value)),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("SSE 更新超时")), 4000)),
    ]);

    expect(eventText).toContain("event: journal-updated");
    expect(eventText).toContain('"courseId":"compiler-principles"');
    expect(eventText).toContain('"artifact":"notes"');
    const updated = await repository.getNotes();
    expect(updated[0].headings).toEqual(["更新后"]);
    await reader.cancel();
  });
});
