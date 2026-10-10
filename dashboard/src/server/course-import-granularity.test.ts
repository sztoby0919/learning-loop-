// @vitest-environment node
import { expect, it } from "vitest";
import { createBasicDraft } from "./course-import.js";
import { extractText } from "./text-extractor.js";
import { extractHtml } from "./html-extractor.js";

it("keeps a knowledge topic as one stage and its definition, examples and practice as tasks", async () => {
  const source = await extractText(Buffer.from("# 机器学习\n## 线性回归\n### 定义\n拟合输入与输出。\n### 例题\n计算预测值。\n### 练习\n训练模型。\n## 决策树\n### 性质\n递归划分。"), "topics.md");
  const draft = createBasicDraft(source, "topics.md");
  expect(draft.stages.map(stage => stage.title)).toEqual(["线性回归", "决策树"]);
  expect(draft.stages[0].tasks.join(" ")).toContain("例题");
  expect(draft.stages[0].tasks.join(" ")).toContain("练习");
  expect(draft.stages[1].tasks.join(" ")).toContain("性质");
  expect(draft.notes.find(note => note.title === "例题")?.stageId).toBe(draft.stages[0].id);
});

it("uses topics below chapter containers and retains their complete source range", () => {
  const draft = createBasicDraft({ title: "机器学习", sourceFormat: "pdf", pageCount: 20,
    pages: Array.from({ length: 20 }, (_, i) => ({ page: i + 1, text: `原文 ${i + 1}` })), warnings: [],
    outline: [{ title: "第1章 监督学习", page: 1 }, { title: "1.1 线性回归", page: 2 },
      { title: "1.1.1 最小二乘", page: 3 }, { title: "1.1.2 例题", page: 5 },
      { title: "1.2 决策树", page: 8 }, { title: "1.2.1 信息增益", page: 9 },
      { title: "附录", page: 18 }],
  }, "book.pdf");
  expect(draft.stages.map(stage => stage.title)).toEqual(["1.1 线性回归", "1.2 决策树"]);
  expect(draft.stages.map(stage => stage.source)).toEqual([
    { title: "1.1 线性回归", startPage: 2, endPage: 7 },
    { title: "1.2 决策树", startPage: 8, endPage: 17 },
  ]);
  expect(draft.stages[0].tasks.join(" ")).toContain("最小二乘");
  expect(draft.references).toEqual([{ title: "参考：附录", page: 18 }]);
});

it("preserves HTML hierarchy rather than making every subheading a stage", async () => {
  const source = await extractHtml(Buffer.from("<h1>网络课程</h1><h2>TCP 拥塞控制</h2><h3>慢启动</h3><p>逐步增加窗口。</p><h3>拥塞避免</h3><p>控制增长。</p><h2>DNS</h2><p>域名解析。</p>"), "network.html");
  expect(createBasicDraft(source, "network.html").stages.map(stage => stage.title)).toEqual(["TCP 拥塞控制", "DNS"]);
});

it("does not discard later topics because child headings consumed the old outline limit", async () => {
  const markdown = "# 课程\n" + Array.from({ length: 40 }, (_, i) => `## 知识点 ${i + 1}\n### 定义\n正文 ${i + 1}\n### 例题\n练习 ${i + 1}\n`).join("");
  const draft = createBasicDraft(await extractText(Buffer.from(markdown), "many.md"), "many.md");
  expect(draft.stages).toHaveLength(40);
  expect(draft.stages.at(-1)?.title).toBe("知识点 40");
});

it("keeps a first standalone knowledge topic even when it also serves as the document title", async () => {
  const draft = createBasicDraft(await extractText(Buffer.from("# 线性回归\n拟合关系。\n# 决策树\n递归划分。"), "topics.md"), "topics.md");
  expect(draft.stages.map(stage => stage.title)).toEqual(["线性回归", "决策树"]);
});
