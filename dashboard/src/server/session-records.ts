import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import matter from "gray-matter";

import type { MistakeItem, PracticeAttempt } from "../shared/course.js";

export interface AttemptRecord {
  kind: "targeted-practice" | "review-attempt";
  courseId: string;
  confirmedAt: string;
  completedAt?: string;
  mistakeId?: string;
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

function confirmedReviewDate(raw: string, parsedValue: unknown): string | null {
  const lines = raw.split(/\r?\n/);
  const metadataEnd = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (lines[0].trim() !== "---" || metadataEnd < 0) return null;
  const entries = lines.slice(1, metadataEnd).filter((line) => /^confirmedAt\s*:/.test(line));
  if (entries.length !== 1) return null;
  const scalar = /^confirmedAt\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))(?:\s+#.*)?\s*$/.exec(entries[0]);
  const date = scalar?.[1] ?? scalar?.[2] ?? scalar?.[3] ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = Date.parse(`${date}T00:00:00Z`);
  // YAML normalizes bare invalid dates such as February 31. Validate the source
  // scalar before accepting the parsed value as evidence of a completed review.
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date && dateText(parsedValue) === date ? date : null;
}

function hasCompleteCorrectAnswer(section: string, structuredOptions: unknown): boolean {
  const parseChoice = (value: string) => /^([A-D])\.\s*(.+)$/.exec(value);
  let options: Map<string, string>;
  if (structuredOptions !== undefined) {
    if (!Array.isArray(structuredOptions) || structuredOptions.length !== 4 || structuredOptions.some((option) => typeof option !== "string" || !option.trim())) return false;
    options = new Map(structuredOptions.map((option: string, index) => [String.fromCharCode(65 + index), option]));
    // The JSON array fixes option boundaries even if the visible text contains
    // " | B. ". Keep the display consistent with this machine-readable evidence.
    if (field(section, "选项") !== [...options].map(([letter, option]) => `${letter}. ${option}`).join(" | ")) return false;
  } else {
    // Older files have no structured options. Ambiguous delimiters must not be
    // interpreted as proof of a correct answer.
    const entries = field(section, "选项").split(/\s+\|\s+(?=[A-Z]\.)/).map(parseChoice);
    if (entries.length !== 4 || entries.some((entry) => !entry)) return false;
    options = new Map(entries.map((entry) => [entry![1], entry![2].trim()]));
  }
  if (options.size !== 4 || [...options.values()].some((value) => !value)) return false;
  const normalized = [...options.values()].map((value) => value.normalize("NFKC").replace(/\s+/gu, " ").toLowerCase());
  if (new Set(normalized).size !== 4) return false;
  const selected = parseChoice(field(section, "选择"));
  const correct = parseChoice(field(section, "正确答案"));
  return Boolean(selected && correct && selected[1] === correct[1]
    && options.get(selected[1]) === selected[2].trim() && options.get(correct[1]) === correct[2].trim()
    && field(section, "问题") && field(section, "解析") && field(section, "得分") === "100/100");
}

export function renderAttemptSession(record: AttemptRecord): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(record.courseId)) throw new Error("courseId 非法");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.confirmedAt)) throw new Error("confirmedAt 必须为 YYYY-MM-DD");
  if (record.question.options.length !== 4 || record.question.options.some((option) => !oneLine(option))) throw new Error("选项必须有四个非空值");
  if (!oneLine(record.question.question) || !oneLine(record.question.knowledgePoint) || !oneLine(record.question.explanation)) throw new Error("作答记录缺少必要内容");
  const { question, options, selected, correct, explanation, knowledgePoint } = record.question;
  const choice = (letter: "A" | "B" | "C" | "D") => `${letter}. ${oneLine(options[letter.charCodeAt(0) - 65])}`;
  const completed = record.completedAt ? `completedAt: ${new Date(record.completedAt).toISOString()}\n` : "";
  const association = record.kind === "targeted-practice" && record.mistakeId ? `mistakeId: ${JSON.stringify(record.mistakeId)}\n` : "";
  return `---\nkind: ${record.kind}\ncourseId: ${record.courseId}\nupdated: ${record.confirmedAt}\nconfirmedAt: ${record.confirmedAt}\n${completed}${association}mode: ${record.mode}\nquestionOptions: ${JSON.stringify(options.map(oneLine))}\n---\n# ${record.kind === "targeted-practice" ? "定向练习" : "复习作答"}记录 ${record.confirmedAt}\n\n## 第 1 题\n\n问题：${oneLine(question)}\n\n选项：${options.map((option, index) => `${String.fromCharCode(65 + index)}. ${oneLine(option)}`).join(" | ")}\n\n知识点：${oneLine(knowledgePoint)}\n\n选择：${choice(selected)}\n\n得分：${selected === correct ? 100 : 0}/100\n\n正确答案：${choice(correct)}\n\n解析：${oneLine(explanation)}\n`;
}

// Dates on a plan are not attempts. Only complete, confirmed real review records
// contribute to the streak; uncertain legacy ordering is handled conservatively.
export async function readReviewStreak(courseRoot: string, courseId: string, topic: string, today: string): Promise<number> {
  const directory = path.join(courseRoot, "sessions");
  let files;
  try {
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("sessions 目录不可读");
    files = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const attempts: Array<{ date: string; time: number | null; correct: boolean }> = [];
  for (const file of files) {
    try {
      const raw = await readFile(path.join(directory, file.name), "utf8");
      const parsed = matter(raw);
      if (parsed.data.kind !== "review-attempt" || parsed.data.mode !== "real" || parsed.data.courseId !== courseId) continue;
      const date = confirmedReviewDate(raw, parsed.data.confirmedAt);
      if (!date || date > today) continue;
      const sections = questionSections(parsed.content);
      if (sections.length !== 1 || field(sections[0], "知识点") !== topic) continue;
      const section = sections[0];
      const isCorrect = hasCompleteCorrectAnswer(section, parsed.data.questionOptions);
      const timestamp = parsed.data.completedAt instanceof Date ? parsed.data.completedAt.getTime() : Date.parse(String(parsed.data.completedAt ?? ""));
      attempts.push({ date, time: Number.isFinite(timestamp) ? timestamp : null, correct: isCorrect });
    } catch {
      // A malformed session may hide an intervening failure; do not infer a streak.
      return 0;
    }
  }
  let streak = 0;
  for (const date of [...new Set(attempts.map((attempt) => attempt.date))].sort()) {
    const day = attempts.filter((attempt) => attempt.date === date);
    const certain = day.every((attempt) => attempt.time !== null) && new Set(day.map((attempt) => attempt.time)).size === day.length;
    if (!certain) {
      streak = day.every((attempt) => attempt.correct) ? streak + day.length : 0;
    } else {
      for (const attempt of day.sort((a, b) => a.time! - b.time!)) streak = attempt.correct ? streak + 1 : 0;
    }
  }
  return streak;
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

interface SessionAnswer { attempt: PracticeAttempt; kind: string; mistakeId?: string }

function parseSession(raw: string, file: string, courseId: string): SessionAnswer[] {
  const parsed = matter(raw);
  const data = parsed.data;
  if (!["ai-assessment", "targeted-practice", "review-attempt"].includes(String(data.kind ?? ""))) return [];
  if (data.courseId !== courseId) throw new Error("courseId 与课程配置不一致");
  const date = dateText(data.confirmedAt ?? (data.kind === "ai-assessment" ? data.updated : undefined));
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
    if (!question || !selected || !correct || !explanation || !/^(?:100|[1-9]?\d)\/100$/.test(score)) throw new Error(`第 ${index + 1} 题缺少完整作答`);
    const selectedLetter = /^([A-D])\./.exec(selected)?.[1];
    const correctLetter = /^([A-D])\./.exec(correct)?.[1];
    const answeredCorrectly = selectedLetter && correctLetter ? selectedLetter === correctLetter : selected === correct;
    return [{ kind: String(data.kind), mistakeId: typeof data.mistakeId === "string" ? data.mistakeId : undefined, attempt: {
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
      isCorrect: Boolean(answeredCorrectly || Number(score.split("/")[0]) === 100),
    } }];
  });
}

export async function readMistakes(courseRoot: string, courseId: string): Promise<{ items: MistakeItem[]; warnings: string[]; unassociatedAttempts?: PracticeAttempt[] }> {
  const directory = path.join(courseRoot, "sessions");
  let files;
  try {
    const details = await lstat(directory);
    if (details.isSymbolicLink() || !details.isDirectory()) return { items: [], warnings: ["sessions 不是课程目录内的普通文件夹，已忽略"] };
    files = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [], warnings: [] };
    throw error;
  }
  const items: MistakeItem[] = [];
  const records: SessionAnswer[] = [];
  const unassociatedAttempts: PracticeAttempt[] = [];
  const warnings: string[] = [];
  for (const file of files.sort((left, right) => left.name.localeCompare(right.name))) {
    try { records.push(...parseSession(await readFile(path.join(directory, file.name), "utf8"), file.name, courseId)); }
    catch (error) { warnings.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const { attempt, kind, mistakeId } of records) {
    if (!attempt.isCorrect && !(kind === "targeted-practice" && mistakeId)) {
      const { isCorrect: _correct, ...item } = attempt;
      items.push({ ...item, ...(kind === "targeted-practice" ? { unassociated: true } : {}) });
    }
  }
  const originals = new Map(items.map((item) => [item.id, item]));
  for (const { attempt, kind, mistakeId } of records) {
    if (kind !== "targeted-practice") continue;
    const original = mistakeId ? originals.get(mistakeId) : undefined;
    if (original) (original.attempts ??= []).push(attempt);
    else if (mistakeId || attempt.isCorrect) unassociatedAttempts.push(attempt);
  }
  items.sort((left, right) => right.date.localeCompare(left.date) || left.sourceSession.localeCompare(right.sourceSession) || left.id.localeCompare(right.id));
  return { items, warnings, ...(unassociatedAttempts.length ? { unassociatedAttempts } : {}) };
}
