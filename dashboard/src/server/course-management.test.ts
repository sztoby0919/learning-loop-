// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { expect, it } from "vitest";
import { createApp } from "./app.js";
import { CourseEventBus } from "./course-events.js";
import { WorkspaceRepository } from "./workspace-repository.js";
import { loadDashboardConfig } from "./dashboard-config.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "course-management-"));
  const directory = path.join(root, "example"); await mkdir(directory);
  const file = path.join(directory, "course.md");
  await writeFile(file, `---\nid: example\ntitle: 原课程\naccent: '#27624B'\nupdated: 2026-10-07\ncustom: preserved\n---\n# 原课程\n## 课程概览\n原简介\n## 学习路线\n### 入门\n- [x] 已完成\n## 关键知识\n知识 [来源](source.pdf)\n## 易错点\n易错\n## 学习记录\n原始记录必须保留\n`);
  await writeFile(path.join(directory, "source.pdf"), "original PDF");
  const configPath = path.join(root, "dashboard.config.json");
  await writeFile(configPath, JSON.stringify({ courses: [{ root: directory, enabled: true }] }));
  const repository = new WorkspaceRepository({ configPath, courses: [{ id: "example", root: directory, enabled: true }] }, () => "2026-10-07");
  return { app: createApp(repository, new CourseEventBus()), file, directory, configPath };
}

it("编辑课程保留学习记录、来源和未知元数据，过期版本不能覆盖文件", async () => {
  const { app, file } = await fixture();
  const snapshot = await request(app).get("/api/courses/example/edit").expect(200);
  const input = { ...snapshot.body, title: "新课程", overviewMarkdown: "新简介", stages: [{ title: "进阶", tasks: [{ text: "a * b", completed: false }] }] };
  const saved = await request(app).patch("/api/courses/example").send(input).expect(200);
  expect(saved.body.course).toMatchObject({ title: "新课程", stages: input.stages });
  const raw = await readFile(file, "utf8");
  expect(raw).toContain("custom: preserved"); expect(raw).toContain("原始记录必须保留"); expect(raw).toContain("知识 [来源](source.pdf)");
  await request(app).patch("/api/courses/example").send(input).expect(409);
  expect(await readFile(file, "utf8")).toBe(raw);
});

it("删除从列表移除并持久化，保留 PDF；过期删除和重复删除失败", async () => {
  const { app, file, directory, configPath } = await fixture();
  const snapshot = await request(app).get("/api/courses/example/edit").expect(200);
  await writeFile(file, (await readFile(file, "utf8")) + "\n外部编辑\n");
  await request(app).delete("/api/courses/example").send({ expectedHash: snapshot.body.expectedHash }).expect(409);
  const fresh = await request(app).get("/api/courses/example/edit").expect(200);
  await request(app).delete("/api/courses/example").send({ expectedHash: fresh.body.expectedHash }).expect(200);
  expect((await request(app).get("/api/courses")).body.courses).toEqual([]);
  await request(app).get("/api/courses/example").expect(404);
  await request(app).delete("/api/courses/example").send({ expectedHash: fresh.body.expectedHash }).expect(404);
  expect(await readFile(path.join(directory, "source.pdf"), "utf8")).toBe("original PDF");
  expect((await loadDashboardConfig(configPath)).courses).toEqual([]);
  await writeFile(configPath, JSON.stringify({ courses: [] }));
  expect((await loadDashboardConfig(configPath, path.dirname(directory))).courses).toEqual([]);
});

it("无效编辑不写文件，未知课程不可编辑", async () => {
  const { app, file } = await fixture(); const before = await readFile(file, "utf8");
  await request(app).patch("/api/courses/example").send({ title: "" }).expect(400);
  await request(app).get("/api/courses/unknown/edit").expect(404);
  expect(await readFile(file, "utf8")).toBe(before);
});

it("改名同步简称，修改任务状态保留路线说明、代码块和原任务链接", async () => {
  const { app, file } = await fixture();
  let raw = await readFile(file, "utf8");
  raw = raw.replace("title: 原课程", "title: 原课程\nshortTitle: 原简称").replace("- [x] 已完成", "- [x] [已完成](source.pdf#page=2)\n\n阶段来源说明\n\n```text\n## 不是真正章节\n```\n\n- 普通参考资料");
  await writeFile(file, raw);
  const snapshot = await request(app).get("/api/courses/example/edit").expect(200);
  snapshot.body.title = "新名称";
  snapshot.body.stages[0].tasks[0].completed = false;
  const saved = await request(app).patch("/api/courses/example").send(snapshot.body).expect(200);
  expect(saved.body.course.shortTitle).toBe("新名称");
  expect(saved.body.course.stages[0].tasks).toEqual([{ text: "已完成", completed: false }]);
  const result = await readFile(file, "utf8");
  expect(result).toContain("- [ ] [已完成](source.pdf#page=2)");
  expect(result).toContain("阶段来源说明"); expect(result).toContain("## 不是真正章节"); expect(result).toContain("- 普通参考资料");
});

it("删除阶段后同名任务仍保留自己原来的来源页码", async () => {
  const { app, file } = await fixture();
  await writeFile(file, (await readFile(file, "utf8")).replace("- [x] 已完成", "- [ ] [阅读](source.pdf#page=1)\n### 第二章\n- [ ] [阅读](source.pdf#page=10)"));
  const snapshot = await request(app).get("/api/courses/example/edit").expect(200);
  snapshot.body.stages.shift(); snapshot.body.stages[0].title = "重命名第二章";
  await request(app).patch("/api/courses/example").send(snapshot.body).expect(200);
  const result = await readFile(file, "utf8");
  expect(result).toContain("source.pdf#page=10"); expect(result).not.toContain("source.pdf#page=1)");
});
