import matter from "gray-matter";
import type { Root } from "mdast";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";

import { parseReviewsMarkdown } from "./artifact-parser.js";
import { nextIntervalDays } from "./review-scheduler.js";

export class ReviewUpdateConflict extends Error {}

interface ReviewUpdateParams {
  courseId: string;
  topic: string;
  date: string;
  isCorrect: boolean;
  priorConsecutiveCorrectReviews: number;
  evidence: string;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

const validOptionalDate = (value: string) => !value || validDate(value);

function cellsOf(line: string): string[] | null {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (char === "\\" && trimmed[index + 1] === "|") {
      cell += "\\|";
      index++;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();

export function locateReviewTable(source: string): { lines: string[]; eol: string; headerIndex: number; endIndex: number } {
  let content: string;
  try {
    content = matter(source).content;
  } catch {
    throw new ReviewUpdateConflict("复习计划的元数据无效");
  }
  if (!source.endsWith(content)) throw new ReviewUpdateConflict("复习计划内容无法定位");
  const root = unified().use(remarkParse).use(remarkGfm).parse(content) as Root;
  const table = root.children.find((node) => node.type === "table");
  if (!table?.position) throw new ReviewUpdateConflict("复习计划缺少知识点表格");
  const offset = source.slice(0, source.length - content.length).split(/\r?\n/).length - 1;
  const lines = source.split(/\r?\n/);
  const headerIndex = offset + table.position.start.line - 1;
  const endIndex = offset + table.position.end.line - 1;
  const headings = cellsOf(lines[headerIndex]);
  const separators = cellsOf(lines[headerIndex + 1] ?? "");
  if (!headings || headings.length !== 5 || !["知识点", "主题"].includes(headings[0]) || headings[1] !== "上次复习" || headings[2] !== "下次复习" || !separators || separators.length !== 5 || !separators.every((part) => /^:?-{3,}:?$/.test(part))) {
    throw new ReviewUpdateConflict("复习计划表格格式无效");
  }
  return { lines, eol: source.includes("\r\n") ? "\r\n" : "\n", headerIndex, endIndex };
}

export function prepareReviewUpdate(rawReviews: string | null, params: ReviewUpdateParams): string {
  const topic = params.topic.trim();
  if (!topic || !validDate(params.date) || !/^[a-z0-9][a-z0-9-]*$/.test(params.courseId) || !params.evidence.trim()) {
    throw new ReviewUpdateConflict("复习信息无效，无法安全更新计划");
  }

  let interval: 1 | 3 | 7 | 30;
  try {
    interval = nextIntervalDays(params.isCorrect, params.priorConsecutiveCorrectReviews);
  } catch {
    throw new ReviewUpdateConflict("连续正确复习次数无效");
  }
  const nextDate = new Date(Date.parse(`${params.date}T00:00:00Z`) + interval * 86_400_000).toISOString().slice(0, 10);
  if (!validDate(nextDate)) throw new ReviewUpdateConflict("下次复习日期超出支持范围");
  const source = rawReviews ?? `---\ncourseId: ${params.courseId}\nupdated: ${params.date}\n---\n# 复习计划\n\n| 知识点 | 上次复习 | 下次复习 | 掌握度 1-10 | 复习证据 |\n| --- | --- | --- | ---: | --- |\n`;
  const { lines, eol, headerIndex, endIndex } = locateReviewTable(source);

  let metadata: Record<string, unknown>;
  try {
    metadata = matter(source).data;
  } catch {
    throw new ReviewUpdateConflict("复习计划的元数据无效");
  }
  const metadataEnd = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  const updatedEntries = lines.slice(1, metadataEnd).flatMap((line, index) => /^updated\s*:/.test(line) ? [{ index: index + 1, value: line.replace(/^updated\s*:\s*/, "").trim() }] : []);
  const rawUpdated = updatedEntries[0]?.value.replace(/^(?:"(.*)"|'(.*)')$/, (_match, double: string | undefined, single: string | undefined) => double ?? single ?? "");
  if (String(metadata.courseId ?? "").trim() !== params.courseId || updatedEntries.length !== 1 || !validDate(rawUpdated ?? "")) {
    throw new ReviewUpdateConflict("复习计划的课程或日期元数据无效");
  }

  const matches: Array<{ index: number; cells: string[] }> = [];
  for (let index = headerIndex + 2; index <= endIndex; index++) {
    const row = cellsOf(lines[index]);
    if (!row || row.length !== 5) throw new ReviewUpdateConflict("复习计划含畸形知识点行");
    if (row[0].replace(/\\\|/g, "|") === topic) matches.push({ index, cells: row });
  }
  if (matches.length > 1) throw new ReviewUpdateConflict("复习计划含重复知识点行");
  const prior = matches[0]?.cells;
  if (prior && (!validOptionalDate(prior[1]) || !validOptionalDate(prior[2]) || (prior[3] !== "" && (!/^\d+$/.test(prior[3]) || Number(prior[3]) < 1 || Number(prior[3]) > 10)))) {
    throw new ReviewUpdateConflict("复习计划目标知识点的日期或掌握度无效");
  }
  const mastery = matches[0]?.cells[3] ?? "";
  const newRow = `| ${cell(topic)} | ${params.date} | ${nextDate} | ${mastery} | ${cell(params.evidence)} |`;
  if (matches.length) lines[matches[0].index] = newRow;
  else lines.splice(endIndex + 1, 0, newRow);

  lines[updatedEntries[0].index] = `updated: ${params.date}`;
  const result = lines.join(eol);
  const parsed = parseReviewsMarkdown(result, "reviews.md", params.date);
  const updated = parsed.items.filter((item) => item.topic === topic);
  if (parsed.warnings.length || updated.length !== 1 || updated[0].lastReviewed !== params.date || updated[0].nextReview !== nextDate || updated[0].mastery !== (mastery ? Number(mastery) : null)) {
    throw new ReviewUpdateConflict("复习计划写入结果无法正确读取");
  }
  return result;
}
