// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AiService } from "./ai-service.js";
import type { AiProvider } from "./ai-provider.js";
import { PracticeManager } from "./practice-manager.js";
import { renderAttemptSession } from "./session-records.js";
import { WorkspaceRepository } from "./workspace-repository.js";

const question = { id: "q", question: "切线表示什么？", options: ["平均变化", "瞬时变化", "面积", "体积"], answer: "B", explanation: "导数是瞬时变化率。", knowledgePoint: "导数" };
const provider: AiProvider = {
  async generateQuestions() { return [question]; },
  async submitAnswer() { throw new Error("选择题由服务端评分"); },
  async generateDiagnosis() { throw new Error("复习不生成诊断"); },
  async generateFeynmanExplanation() { return { explanation: "", analogy: "", examples: [] }; },
  async generateRemediationTasks() { return []; },
};
const original = `---\ncourseId: calculus-101\nupdated: 2026-09-20\n---\n| 知识点 | 上次复习 | 下次复习 | 掌握度 1-10 | 复习证据 |\n| --- | --- | --- | ---: | --- |\n| 导数 | 2026-09-20 | 2026-09-21 | 5 | 手工计划不是作答证据 |\n`;

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "review-practice-"));
  await mkdir(path.join(root, "sessions"));
  await writeFile(path.join(root, "course.md"), `---\nid: calculus-101\ntitle: 微积分\naccent: "#27624B"\nupdated: 2026-09-28\n---\n# 微积分\n## 课程概览\n学习导数。\n## 学习路线\n### 导数\n- [ ] 学习导数\n## 关键知识\n导数是瞬时变化率。\n## 易错点\n暂无。\n## 学习记录\n| 日期 | 学习内容 | 掌握度 1-10 | 遇到困难 | 下一步 |\n| --- | --- | ---: | --- | --- |\n| 2026-09-20 | 导数 | 5 | | |\n`);
  await writeFile(path.join(root, "reviews.md"), original);
  const repository = new WorkspaceRepository({ configPath: path.join(root, "config.json"), courses: [{ id: "calculus-101", root, enabled: true }] }, () => "2026-09-28");
  let now = Date.parse("2026-09-28T09:00:00Z");
  const manager = () => new PracticeManager(repository, new AiService({ provider, maxRetries: 0 }), () => "2026-09-28", "real", () => now++);
  const seed = async (name: string, date: string, selected: "A" | "B", mode: "real" | "mock" = "real", kind: "review-attempt" | "targeted-practice" = "review-attempt") => {
    await writeFile(path.join(root, "sessions", name), renderAttemptSession({ kind, courseId: "calculus-101", confirmedAt: date, mode, question: { ...question, selected, correct: "B" } }));
  };
  const complete = async (choice: "A" | "B", current = manager()) => {
    const created = await current.create({ courseId: "calculus-101", topic: "导数", kind: "review-attempt" });
    await current.answer(created.sessionId, "q", choice);
    await current.confirm(created.sessionId);
    return readFile(path.join(root, "reviews.md"), "utf8");
  };
  return { root, repository, manager, seed, complete };
}

it("uses persisted real review evidence after restart for 3/7/30 days, and resets wrong answers to 1 day", async () => {
  const { complete, seed } = await setup();
  await seed("mock.md", "2026-09-27", "B", "mock");
  await seed("practice.md", "2026-09-27", "B", "real", "targeted-practice");
  expect(await complete("B")).toContain("| 导数 | 2026-09-28 | 2026-10-01 | 5 |");
  expect(await complete("B")).toContain("| 导数 | 2026-09-28 | 2026-10-05 | 5 |");
  expect(await complete("B")).toContain("| 导数 | 2026-09-28 | 2026-10-28 | 5 |");
  expect(await complete("A")).toContain("| 导数 | 2026-09-28 | 2026-09-29 | 5 |");
  expect(await complete("B")).toContain("| 导数 | 2026-09-28 | 2026-10-01 | 5 |");
});

it("does not raise the streak using uncertain same-day legacy ordering", async () => {
  const { complete, seed } = await setup();
  await seed("z-correct.md", "2026-09-27", "B");
  await seed("a-wrong.md", "2026-09-27", "A");
  expect(await complete("B")).toContain("| 导数 | 2026-09-28 | 2026-10-01 | 5 |");
});

it("allows automatic record topics and creates a missing plan only on confirmation", async () => {
  const { root, manager } = await setup();
  const { unlink } = await import("node:fs/promises");
  await unlink(path.join(root, "reviews.md"));
  const current = manager();
  const created = await current.create({ courseId: "calculus-101", topic: "导数", kind: "review-attempt" });
  await expect(readFile(path.join(root, "reviews.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await current.answer(created.sessionId, "q", "A");
  await current.confirm(created.sessionId);
  expect(await readFile(path.join(root, "reviews.md"), "utf8")).toContain("2026-09-29");
});
