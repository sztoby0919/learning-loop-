// @vitest-environment node

import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AiProvider } from "./ai-provider.js";
import { AiService } from "./ai-service.js";
import type { AssessmentQuestion } from "./ai-types.js";
import { renderAttemptSession, readMistakes } from "./session-records.js";
import { WorkspaceRepository } from "./workspace-repository.js";

const courseMarkdown = `---
id: calculus-101
title: 微积分基础
accent: "#27624B"
updated: 2026-09-28
---
# 微积分基础
## 课程概览
学习导数。
## 学习路线
### 导数
- [ ] 理解导数
## 关键知识
导数是瞬时变化率。
## 易错点
暂无。
## 学习记录
| 日期 | 学习内容 | 掌握度 1-10 | 遇到困难 | 下一步 |
| --- | --- | ---: | --- | --- |
`;
const generated: AssessmentQuestion = {
  id: "fresh-q", question: "某点的切线斜率说明什么？",
  options: ["平均变化率", "瞬时变化率", "函数值", "积分面积"],
  answer: "B", explanation: "切线斜率表示该点的瞬时变化率。", knowledgePoint: "导数",
};
const provider: AiProvider = {
  async generateQuestions() { return [generated]; },
  async submitAnswer() { throw new Error("选择题不调用模型评分"); },
  async generateDiagnosis() { throw new Error("练习不生成诊断"); },
  async generateFeynmanExplanation() { return { explanation: "", analogy: "", examples: [] }; },
  async generateRemediationTasks() { return []; },
};

async function setup(aiProvider: AiProvider = provider, mode: "real" | "mock" = "real", now = () => 0, sourceKnowledgePoint = "导数") {
  const root = await mkdtemp(path.join(tmpdir(), "learning-loop-practice-unit-"));
  const courseRoot = path.join(root, "calculus-101");
  await mkdir(path.join(courseRoot, "sessions"), { recursive: true });
  await writeFile(path.join(courseRoot, "course.md"), courseMarkdown);
  await writeFile(path.join(courseRoot, "reviews.md"), "手工复习计划\n");
  await writeFile(path.join(courseRoot, "sessions", "old.md"), renderAttemptSession({
    kind: "targeted-practice", courseId: "calculus-101", confirmedAt: "2026-09-27", mode: "real",
    question: { question: "导数表示什么？", options: ["平均变化率", "瞬时变化率", "函数值", "积分面积"], selected: "A", correct: "B", explanation: "导数是瞬时变化率。", knowledgePoint: sourceKnowledgePoint },
  }));
  const repository = new WorkspaceRepository({ configPath: path.join(root, "config.json"), courses: [{ id: "calculus-101", root: courseRoot, enabled: true }] }, () => "2026-09-28");
  const mistakeId = (await readMistakes(courseRoot, "calculus-101")).items[0].id;
  const { PracticeManager } = await import("./practice-manager.js");
  return { manager: new PracticeManager(repository, new AiService({ provider: aiProvider, maxRetries: 0 }), () => "2026-09-28", mode, now), courseRoot, mistakeId };
}

describe("PracticeManager targeted practice", () => {
  it("uses the selected mistake and course context, returning one four-option question without its answer", async () => {
    let sent: Parameters<AiProvider["generateQuestions"]>[0] | undefined;
    const { manager, mistakeId } = await setup({ ...provider, async generateQuestions(params) { sent = params; return [generated]; } });
    const created = await manager.create({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" });
    expect(sent).toMatchObject({ courseId: "calculus-101", count: 1 });
    expect(sent?.context).toContain("导数表示什么？");
    expect(sent?.context).toContain("A. 平均变化率");
    expect(sent?.context).toContain("B. 瞬时变化率");
    expect(sent?.context).toContain("导数是瞬时变化率");
    expect(created.question.options).toEqual(["平均变化率", "瞬时变化率", "函数值", "积分面积"]);
    expect(created).toMatchObject({ mode: "real", question: { id: "fresh-q", question: generated.question } });
    expect(JSON.stringify(created)).not.toContain('"answer":"B"');
    expect(JSON.stringify(created)).not.toContain("切线斜率表示");
  });

  it("rejects a question identical to the original after whitespace and punctuation normalization", async () => {
    const { manager, mistakeId } = await setup({ ...provider, async generateQuestions() { return [{ ...generated, question: " 导数 表示什么？！ " }]; } });
    await expect(manager.create({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" })).rejects.toMatchObject({ status: 502 });
  });

  it("rejects a generated question about a different knowledge point", async () => {
    const { manager, mistakeId } = await setup({ ...provider, async generateQuestions() { return [{ ...generated, knowledgePoint: "积分" }]; } });
    await expect(manager.create({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" })).rejects.toMatchObject({ status: 502 });
  });

  it.each(["question", "explanation", "knowledgePoint"] as const)("rejects whitespace-only %s before a retry can be answered and confirmed", async (field) => {
    let calls = 0;
    const valid = { ...generated, question: `  ${generated.question}  `, explanation: `  ${generated.explanation}  `, knowledgePoint: " 导数 " };
    const { manager, mistakeId, courseRoot } = await setup({ ...provider, async generateQuestions() {
      return [calls++ === 0 ? { ...valid, [field]: " \n\t " } : valid];
    } });
    await expect(manager.create({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" })).rejects.toMatchObject({ status: 502 });
    const created = await manager.create({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" });
    await manager.answer(created.sessionId, "fresh-q", "A");
    await expect(manager.confirm(created.sessionId)).resolves.toMatchObject({ courseId: "calculus-101" });
    const fresh = (await readdir(path.join(courseRoot, "sessions"))).find((name) => name !== "old.md");
    expect(await readFile(path.join(courseRoot, "sessions", fresh!), "utf8")).toContain("解析：切线斜率表示该点的瞬时变化率。");
  });

  it.each(["question", "options", "knowledgePoint"] as const)("rejects an explicit answer cue in public %s", async (field) => {
    const cue = "正确答案：B";
    const contaminated = {
      ...generated,
      question: field === "question" ? `${generated.question}${cue}` : generated.question,
      options: field === "options" ? ["平均变化率", `瞬时变化率（${cue}）`, "函数值", "积分面积"] : generated.options,
      knowledgePoint: field === "knowledgePoint" ? `导数（${cue}）` : generated.knowledgePoint,
    };
    const sourceKnowledgePoint = field === "knowledgePoint" ? contaminated.knowledgePoint : "导数";
    const { manager, mistakeId } = await setup({ ...provider, async generateQuestions() { return [contaminated]; } }, "real", () => 0, sourceKnowledgePoint);
    await expect(manager.create({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" })).rejects.toMatchObject({ status: 502 });
  });

  it.each(["答案是 B", "答案为：B", "应选 B", "B 选项正确", "Answer: B", "Correct answer B", "【正确答案】B"])("rejects the answer declaration %s in the public question", async (cue) => {
    const { manager, mistakeId } = await setup({ ...provider, async generateQuestions() { return [{ ...generated, question: `${generated.question} ${cue}` }]; } });
    await expect(manager.create({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" })).rejects.toMatchObject({ status: 502 });
  });

  it.each(["正确选项：B", "正确 选项 ： B", "正确选项是 B", "正确的选项为 B", "正确答案为选项 B", "正确答案为：选项 B"])("rejects the explicit choice hint %s", async (cue) => {
    const { manager, mistakeId } = await setup({ ...provider, async generateQuestions() { return [{ ...generated, question: `${generated.question} ${cue}` }]; } });
    await expect(manager.create({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" })).rejects.toMatchObject({ status: 502 });
  });

  it.each(["options", "knowledgePoint"] as const)("rejects a correct-option hint in public %s", async (field) => {
    const cue = "正确选项：B";
    const contaminated = field === "options"
      ? { ...generated, options: ["平均变化率", `瞬时变化率（${cue}）`, "函数值", "积分面积"] }
      : { ...generated, knowledgePoint: `导数（${cue}）` };
    const sourceKnowledgePoint = field === "knowledgePoint" ? contaminated.knowledgePoint : "导数";
    const { manager, mistakeId } = await setup({ ...provider, async generateQuestions() { return [contaminated]; } }, "real", () => 0, sourceKnowledgePoint);
    await expect(manager.create({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" })).rejects.toMatchObject({ status: 502 });
  });

  it("rejects a correct marker attached to a public option without a choice letter", async () => {
    const { manager, mistakeId } = await setup({ ...provider, async generateQuestions() { return [{ ...generated, options: ["平均变化率", "瞬时变化率（正确）", "函数值", "积分面积"] }]; } });
    await expect(manager.create({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" })).rejects.toMatchObject({ status: 502 });
  });

  it("allows ordinary question wording and option text that do not disclose a choice", async () => {
    const normal = { ...generated, question: "分析选项 B 是否正确：正确的选项是哪个？", options: ["答案是一个过程", "B 族维生素", "函数值", "积分面积"] };
    const { manager, mistakeId } = await setup({ ...provider, async generateQuestions() { return [normal]; } });
    await expect(manager.create({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" })).resolves.toMatchObject({ question: { question: normal.question, options: normal.options } });
  });

  it("rejects choices that become identical after Unicode normalization", async () => {
    const { manager, mistakeId } = await setup({ ...provider, async generateQuestions() { return [{ ...generated, options: ["Ａ", "A", "函数值", "积分面积"] }]; } });
    await expect(manager.create({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" })).rejects.toMatchObject({ status: 502 });
  });

  it("rejects malformed or multiple provider questions", async () => {
    const { manager, mistakeId } = await setup({ ...provider, async generateQuestions() { return [{ ...generated, options: ["A", "B", "C"] }]; } });
    await expect(manager.create({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" })).rejects.toMatchObject({ status: 502 });
    const second = await setup({ ...provider, async generateQuestions() { return [generated, { ...generated, id: "q2" }]; } });
    await expect(second.manager.create({ courseId: "calculus-101", mistakeId: second.mistakeId, kind: "targeted-practice" })).rejects.toMatchObject({ status: 502 });
    const missing = await setup({ ...provider, async generateQuestions() { return null as unknown as AssessmentQuestion[]; } });
    await expect(missing.manager.create({ courseId: "calculus-101", mistakeId: missing.mistakeId, kind: "targeted-practice" })).rejects.toMatchObject({ status: 502 });
  });

  it("grades 0 or 100 server-side and rejects an altered question, invalid choice, and second answer", async () => {
    const { manager, mistakeId } = await setup();
    const created = await manager.create({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" });
    await expect(manager.confirm(created.sessionId)).rejects.toMatchObject({ status: 409 });
    await expect(manager.answer(created.sessionId, "wrong-id", "A")).rejects.toMatchObject({ status: 409 });
    await expect(manager.answer(created.sessionId, "fresh-q", "E" as "A")).rejects.toMatchObject({ status: 400 });
    const wrong = await manager.answer(created.sessionId, "fresh-q", "A");
    expect(wrong.feedback).toMatchObject({ questionId: "fresh-q", isCorrect: false, score: 0, correctPart: "B. 瞬时变化率" });
    await expect(manager.answer(created.sessionId, "fresh-q", "B")).rejects.toMatchObject({ status: 409 });
    const another = await manager.create({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" });
    expect((await manager.answer(another.sessionId, "fresh-q", "B")).feedback).toMatchObject({ isCorrect: true, score: 100 });
  });

  it.each(["real", "mock"] as const)("confirms a unique durable %s session once without changing course or reviews", async (mode) => {
    const { manager, courseRoot, mistakeId } = await setup(provider, mode);
    const created = await manager.create({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" });
    if (mode === "mock") expect(created.question.question).toContain("离线演示");
    await manager.answer(created.sessionId, "fresh-q", "A");
    const confirmed = await manager.confirm(created.sessionId);
    expect(confirmed).toMatchObject({ courseId: "calculus-101", mode });
    const names = await readdir(path.join(courseRoot, "sessions"));
    const fresh = names.filter((name) => name !== "old.md");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatch(/^2026-09-28-[a-f0-9-]+\.md$/);
    const content = await readFile(path.join(courseRoot, "sessions", fresh[0]), "utf8");
    expect(content).toContain("kind: targeted-practice");
    expect(content).toContain(`mode: ${mode}`);
    expect(content).toContain("得分：0/100");
    expect(content).toContain("选择：A. 平均变化率");
    if (mode === "mock") expect(content).toContain("离线演示");
    expect((await readMistakes(courseRoot, "calculus-101")).items).toEqual(expect.arrayContaining([expect.objectContaining({ mode, selected: "A. 平均变化率" })]));
    expect(await readFile(path.join(courseRoot, "course.md"), "utf8")).toBe(courseMarkdown);
    expect(await readFile(path.join(courseRoot, "reviews.md"), "utf8")).toBe("手工复习计划\n");
    await expect(manager.confirm(created.sessionId)).rejects.toMatchObject({ status: 409 });
    expect((await readdir(path.join(courseRoot, "sessions"))).length).toBe(2);
  });

  it("reports unknown mistakes, unavailable sessions, expired sessions, and provider errors", async () => {
    let clock = 0;
    const { manager, mistakeId } = await setup(provider, "real", () => clock);
    await expect(manager.create({ courseId: "calculus-101", mistakeId: "missing", kind: "targeted-practice" })).rejects.toMatchObject({ status: 404 });
    await expect(manager.answer("missing", "fresh-q", "A")).rejects.toMatchObject({ status: 404 });
    const created = await manager.create({ courseId: "calculus-101", mistakeId, kind: "targeted-practice" });
    clock = 31 * 60 * 1000;
    await expect(manager.answer(created.sessionId, "fresh-q", "A")).rejects.toMatchObject({ status: 404 });
    await expect(manager.confirm(created.sessionId)).rejects.toMatchObject({ status: 404 });
    const failing = await setup({ ...provider, async generateQuestions() { throw new Error("模型暂不可用"); } });
    await expect(failing.manager.create({ courseId: "calculus-101", mistakeId: failing.mistakeId, kind: "targeted-practice" })).rejects.toMatchObject({ status: 502 });
  });
});
