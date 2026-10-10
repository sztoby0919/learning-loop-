// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AiService } from "./ai-service.js";
import type { AiProvider } from "./ai-provider.js";
import { PracticeManager } from "./practice-manager.js";
import { readReviewStreak, renderAttemptSession } from "./session-records.js";
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

it("repairs a review topic mismatch using feedback before returning a playable real question", async () => {
  const requests: Parameters<AiProvider["generateQuestions"]>[0][] = [];
  const { manager } = await setup({ ...provider, async generateQuestions(params) { requests.push(params); return [{ ...question, knowledgePoint: requests.length === 1 ? "积分" : "导数" }]; } });
  const current = manager(); const created = await current.create({ courseId: "calculus-101", topic: "导数", kind: "review-attempt" });
  expect(requests).toHaveLength(2); expect(requests[1]).toMatchObject({ instructions: expect.stringContaining("知识点与复习主题不一致") });
  expect(created.mode).toBe("real"); expect((await current.answer(created.sessionId, "q", "B")).feedback.isCorrect).toBe(true);
});

it("reports a topic mismatch without claiming the review question repeats the original", async () => {
  const { manager } = await setup({ ...provider, async generateQuestions() { return [{ ...question, knowledgePoint: "积分" }]; } });
  await expect(manager().create({ courseId: "calculus-101", topic: "导数", kind: "review-attempt" })).rejects.toThrow("生成题目的知识点与复习主题不一致，请重试");
});

it("reports invalid review options without claiming the question repeats the original", async () => {
  const { manager } = await setup({ ...provider, async generateQuestions() { return [{ ...question, options: ["重复", "重复", "面积", "体积"] }]; } });
  await expect(manager().create({ courseId: "calculus-101", topic: "导数", kind: "review-attempt" })).rejects.toThrow("模型生成的练习题格式无效、选项重复或泄露答案，请重试");
});

async function setup(aiProvider: AiProvider = provider) {
  const root = await mkdtemp(path.join(tmpdir(), "review-practice-"));
  await mkdir(path.join(root, "sessions"));
  await writeFile(path.join(root, "course.md"), `---\nid: calculus-101\ntitle: 微积分\naccent: "#27624B"\nupdated: 2026-09-28\n---\n# 微积分\n## 课程概览\n学习导数。\n## 学习路线\n### 导数\n- [ ] 学习导数\n## 关键知识\n导数是瞬时变化率。\n## 易错点\n暂无。\n## 学习记录\n| 日期 | 学习内容 | 掌握度 1-10 | 遇到困难 | 下一步 |\n| --- | --- | ---: | --- | --- |\n| 2026-09-20 | 导数 | 5 | | |\n`);
  await writeFile(path.join(root, "reviews.md"), original);
  const repository = new WorkspaceRepository({ configPath: path.join(root, "config.json"), courses: [{ id: "calculus-101", root, enabled: true }] }, () => "2026-09-28");
  let now = Date.parse("2026-09-28T09:00:00Z");
  const manager = () => new PracticeManager(repository, new AiService({ provider: aiProvider, maxRetries: 0 }), () => "2026-09-28", "real", () => now++);
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

it.each(["2026-02-31", "2026-02-29"])("does not extend review intervals from the invalid raw confirmed date %s", async (date) => {
  const { root, seed, complete } = await setup();
  await seed("invalid-date.md", date, "B");
  expect(await readReviewStreak(root, "calculus-101", "导数", "2026-09-28")).toBe(0);
  expect(await complete("B")).toContain("| 导数 | 2026-09-28 | 2026-10-01 | 5 |");
});

it.each([
  ["single option", "选项", "仅一个选项"],
  ["missing option text", "选项", "A. 平均变化 | B. 瞬时变化 | C. 面积 | D. "],
  ["duplicate choice label", "选项", "A. 平均变化 | B. 瞬时变化 | C. 面积 | C. 体积"],
  ["duplicate option text", "选项", "A. 平均变化 | B. 瞬时变化 | C. 面积 | D. 面积"],
  ["mismatched selected text", "选择", "B. 伪造选项"],
  ["mismatched answer text", "正确答案", "B. 伪造选项"],
  ["inconsistent score", "得分", "0/100"],
  ["missing explanation", "解析", ""],
])("does not extend intervals with %s in a saved review", async (_label, field, value) => {
  const { root, seed, complete } = await setup();
  await seed("incomplete.md", "2026-09-27", "B");
  const file = path.join(root, "sessions", "incomplete.md");
  const raw = await readFile(file, "utf8");
  await writeFile(file, raw.replace(new RegExp(`^${field}：.*$`, "m"), `${field}：${value}`));
  expect(await readReviewStreak(root, "calculus-101", "导数", "2026-09-28")).toBe(0);
  expect(await complete("B")).toContain("| 导数 | 2026-09-28 | 2026-10-01 | 5 |");
});

it.each(["2026-09-27 # confirmed", "'2026-09-27' # confirmed", '"2026-09-27" # confirmed'])("keeps valid annotated legacy dates compatible: %s", async (scalar) => {
  const { root, seed, complete } = await setup();
  await seed("legacy.md", "2026-09-27", "B");
  const file = path.join(root, "sessions", "legacy.md");
  await writeFile(file, (await readFile(file, "utf8")).replace(/^questionOptions:.*\r?\n/m, "").replace("confirmedAt: 2026-09-27", `confirmedAt: ${scalar}`));
  expect(await readReviewStreak(root, "calculus-101", "导数", "2026-09-28")).toBe(1);
  expect(await complete("B")).toContain("| 导数 | 2026-09-28 | 2026-10-05 | 5 |");
});

it.each(["A", "B"] as const)("preserves correct %s answers and intervals when option text contains option separators", async (answer) => {
  const trickyQuestion = { ...question, answer, options: ["x | B. y", '"quoted" | C. z', "\\path | D. w", "key: value # note"] };
  const { root, complete } = await setup({ ...provider, async generateQuestions() { return [trickyQuestion]; } });
  expect(await complete(answer)).toContain("| 导数 | 2026-09-28 | 2026-10-01 | 5 |");
  expect(await readReviewStreak(root, "calculus-101", "导数", "2026-09-28")).toBe(1);
  expect(await complete(answer)).toContain("| 导数 | 2026-09-28 | 2026-10-05 | 5 |");
  expect(await complete(answer)).toContain("| 导数 | 2026-09-28 | 2026-10-28 | 5 |");
});

it("does not invent options for a legacy record with ambiguous delimiters", async () => {
  const { root, complete } = await setup();
  const legacy = renderAttemptSession({ kind: "review-attempt", courseId: "calculus-101", confirmedAt: "2026-09-27", mode: "real", question: { ...question, options: ["x | B. y", "瞬时变化", "面积", "体积"], selected: "B", correct: "B" } }).replace(/^questionOptions:.*\r?\n/m, "");
  await writeFile(path.join(root, "sessions", "ambiguous-legacy.md"), legacy);
  expect(await readReviewStreak(root, "calculus-101", "导数", "2026-09-28")).toBe(0);
  expect(await complete("B")).toContain("| 导数 | 2026-09-28 | 2026-10-01 | 5 |");
});

it.each([{ options: null }, { options: ["only one option"] }, { options: 42 }])("rejects malformed structured options instead of falling back to display text: $options", async ({ options }) => {
  const { root, seed, complete } = await setup();
  await seed("malformed-options.md", "2026-09-27", "B");
  const file = path.join(root, "sessions", "malformed-options.md");
  const raw = (await readFile(file, "utf8")).replace(/^questionOptions:.*\r?\n/m, "");
  await writeFile(file, raw.replace("mode: real\n", `mode: real\nquestionOptions: ${JSON.stringify(options)}\n`));
  expect(await readReviewStreak(root, "calculus-101", "导数", "2026-09-28")).toBe(0);
  expect(await complete("B")).toContain("| 导数 | 2026-09-28 | 2026-10-01 | 5 |");
});
