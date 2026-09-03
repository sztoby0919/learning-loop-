// @vitest-environment node

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { CourseEventBus } from "./course-events.js";
import { WorkspaceRepository } from "./workspace-repository.js";

const markdown = `---
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
- [ ] 完成词法分析器
## 关键知识
关键知识。
## 易错点
暂无。
## 学习记录
| 日期 | 学习内容 | 掌握度 1-10 | 遇到困难 | 下一步 |
| --- | --- | ---: | --- | --- |
`;

async function setupApp() {
  const root = await mkdtemp(path.join(tmpdir(), "study-dashboard-api-"));
  const directory = path.join(root, "compiler-principles");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "course.md"), markdown, "utf8");
  const repository = new WorkspaceRepository({ configPath: path.join(root, "dashboard.config.json"), courses: [{ id: "compiler-principles", root: directory, enabled: true }] }, () => "2026-08-29");
  return createApp(repository, new CourseEventBus());
}

describe("course API", () => {
  it("GET /api/courses 返回配置课程摘要", async () => {
    const response = await request(await setupApp()).get("/api/courses");

    expect(response.status).toBe(200);
    expect(response.body.courses).toHaveLength(1);
    expect(response.body.courses[0]).toMatchObject({
      id: "compiler-principles",
      title: "编译原理",
      status: "ready",
    });
  });

  it("聚合端点返回任务、统计和设置状态", async () => {
    const app = await setupApp();
    const tasks = await request(app).get("/api/tasks");
    const stats = await request(app).get("/api/stats");
    const settings = await request(app).get("/api/settings");

    expect(tasks.status).toBe(200);
    expect(tasks.body).toMatchObject([{ courseId: "compiler-principles", text: "完成词法分析器" }]);
    expect(stats.body).toMatchObject({ totalTasks: 1, recordCount: 0 });
    expect(settings.body.courses[0].root).toContain("compiler-principles");
  });

  it("未知课程 ID 返回 404，不尝试读取任意路径", async () => {
    const response = await request(await setupApp()).get("/api/courses/unknown-course");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "未知课程" });
  });
});
