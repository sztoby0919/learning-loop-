import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import matter from "gray-matter";

import type { MistakeItem } from "../shared/course.js";

export interface AttemptRecord {
  kind: "targeted-practice" | "review-attempt";
  courseId: string;
  confirmedAt: string;
  mode: "real" | "mock";
  question: {
    question: string;
    options: [string, string, string, string] | string[];
    selected: "A" | "B" | "C" | "D";
    correct: "A" | "B" | "C" | "D";
    explanation: string;
    knowledgePoint: string;
  };
}

const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
const dateText = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").trim();

export function renderAttemptSession(record: AttemptRecord): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(record.courseId)) throw new Error("courseId 非法");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.confirmedAt)) throw new Error("confirmedAt 必须为 YYYY-MM-DD");
  if (record.question.options.length !== 4 || record.question.options.some((option) => !oneLine(option))) throw new Error("选项必须有四个非空值");
  if (!oneLine(record.question.question) || !oneLine(record.question.knowledgePoint) || !oneLine(record.question.explanation)) throw new Error("作答记录缺少必要内容");
  const { question, options, selected, correct, explanation, knowledgePoint } = record.question;
  const choice = (letter: "A" | "B" | "C" | "D") => `${letter}. ${oneLine(options[letter.charCodeAt(0) - 65])}`;
  return `---\nkind: ${record.kind}\ncourseId: ${record.courseId}\nupdated: ${record.confirmedAt}\nconfirmedAt: ${record.confirmedAt}\nmode: ${record.mode}\n---\n# ${record.kind === "targeted-practice" ? "定向练习" : "复习作答"}记录 ${record.confirmedAt}\n\n## 第 1 题\n\n问题：${oneLine(question)}\n\n选项：${options.map((option, index) => `${String.fromCharCode(65 + index)}. ${oneLine(option)}`).join(" | ")}\n\n知识点：${oneLine(knowledgePoint)}\n\n选择：${choice(selected)}\n\n得分：${selected === correct ? 100 : 0}/100\n\n正确答案：${choice(correct)}\n\n解析：${oneLine(explanation)}\n`;
}

function field(section: string, label: string): string {
  const line = section.split(/\r?\n/).find((candidate) => candidate.startsWith(`${label}：`));
  return line?.slice(label.length + 1).trim() ?? "";
}

function questionSections(content: string): string[] {
  const sections: string[] = [];
  let current: string[] | null = null;
  for (const line of content.split(/\r?\n/)) {
    if (/^## 第\s*\d+\s*题\s*$/.test(line)) {
      if (current) sections.push(current.join("\n"));
      current = [];
    } else if (/^## /.test(line)) {
      if (current) sections.push(current.join("\n"));
      current = null;
    } else if (current) current.push(line);
  }
  if (current) sections.push(current.join("\n"));
  return sections;
}

function parseSession(raw: string, file: string, courseId: string): MistakeItem[] {
  const parsed = matter(raw);
  const data = parsed.data;
  if (!["ai-assessment", "targeted-practice", "review-attempt"].includes(String(data.kind ?? ""))) return [];
  if (data.courseId !== courseId) throw new Error("courseId 与课程配置不一致");
  const date = dateText(data.confirmedAt ?? data.updated);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("缺少有效日期");
  const mode = data.mode === undefined ? "unknown" : data.mode;
  if (mode !== "real" && mode !== "mock" && mode !== "unknown") throw new Error("来源模式无效");
  const sections = questionSections(parsed.content);
  if (!sections.length) throw new Error("缺少题目作答");
  return sections.flatMap((section, index) => {
    const question = field(section, "问题");
    const selected = field(section, "选择");
    const correct = field(section, "正确答案");
    const explanation = field(section, "解析");
    const score = field(section, "得分");
    if (!question || !selected || !correct || !explanation || !/^\d{1,3}\/100$/.test(score)) throw new Error(`第 ${index + 1} 题缺少完整作答`);
    const selectedLetter = /^([A-D])\./.exec(selected)?.[1];
    const correctLetter = /^([A-D])\./.exec(correct)?.[1];
    const answeredCorrectly = selectedLetter && correctLetter ? selectedLetter === correctLetter : selected === correct;
    if (answeredCorrectly || Number(score.split("/")[0]) === 100) return [];
    return [{
      id: createHash("sha256").update(`${courseId}\0${file}\0${index}\0${question}`).digest("hex").slice(0, 20),
      courseId,
      question,
      selected,
      correct,
      explanation,
      knowledgePoint: field(section, "知识点") || null,
      date,
      sourceSession: file,
      mode,
    } satisfies MistakeItem];
  });
}

export async function readMistakes(courseRoot: string, courseId: string): Promise<{ items: MistakeItem[]; warnings: string[] }> {
  const directory = path.join(courseRoot, "sessions");
  let files;
  try {
    files = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [], warnings: [] };
    throw error;
  }
  const items: MistakeItem[] = [];
  const warnings: string[] = [];
  for (const file of files.sort((left, right) => left.name.localeCompare(right.name))) {
    try { items.push(...parseSession(await readFile(path.join(directory, file.name), "utf8"), file.name, courseId)); }
    catch (error) { warnings.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  items.sort((left, right) => right.date.localeCompare(left.date) || left.sourceSession.localeCompare(right.sourceSession) || left.id.localeCompare(right.id));
  return { items, warnings };
}
