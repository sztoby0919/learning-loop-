import matter from "gray-matter";

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

function cellsOf(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const cells: string[] = [];
  let cell = "";
  for (let index = 1; index < trimmed.length - 1; index++) {
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
  const source = rawReviews ?? `---\ncourseId: ${params.courseId}\nupdated: ${params.date}\n---\n# 复习计划\n\n| 知识点 | 上次复习 | 下次复习 | 掌握度 1-10 | 复习证据 |\n| --- | --- | --- | ---: | --- |\n`;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);

  let metadata: Record<string, unknown>;
  try {
    metadata = matter(source).data;
  } catch {
    throw new ReviewUpdateConflict("复习计划的元数据无效");
  }
  if (String(metadata.courseId ?? "").trim() !== params.courseId || !validDate(String(metadata.updated instanceof Date ? metadata.updated.toISOString().slice(0, 10) : metadata.updated ?? "").trim())) {
    throw new ReviewUpdateConflict("复习计划的课程或日期元数据无效");
  }

  const headers = lines.flatMap((line, index) => {
    const cells = cellsOf(line);
    return cells && (cells[0] === "知识点" || cells[0] === "主题") ? [index] : [];
  });
  if (headers.length !== 1) throw new ReviewUpdateConflict("复习计划缺少唯一的知识点表格");
  const headerIndex = headers[0];
  const headings = cellsOf(lines[headerIndex]);
  const separators = cellsOf(lines[headerIndex + 1] ?? "");
  if (!headings || headings.length !== 5 || headings[1] !== "上次复习" || headings[2] !== "下次复习" || !separators || separators.length !== 5 || !separators.every((part) => /^:?-{3,}:?$/.test(part))) {
    throw new ReviewUpdateConflict("复习计划表格格式无效");
  }

  const matches: Array<{ index: number; cells: string[] }> = [];
  let insertAt = headerIndex + 2;
  while (insertAt < lines.length && lines[insertAt].trim().startsWith("|")) {
    const row = cellsOf(lines[insertAt]);
    if (!row || row.length !== 5) throw new ReviewUpdateConflict("复习计划含畸形知识点行");
    if (row[0].replace(/\\\|/g, "|") === topic) matches.push({ index: insertAt, cells: row });
    insertAt++;
  }
  if (matches.length > 1) throw new ReviewUpdateConflict("复习计划含重复知识点行");
  const mastery = matches[0]?.cells[3] ?? "";
  const newRow = `| ${cell(topic)} | ${params.date} | ${nextDate} | ${mastery} | ${cell(params.evidence)} |`;
  if (matches.length) lines[matches[0].index] = newRow;
  else lines.splice(insertAt, 0, newRow);

  const metadataEnd = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  const updatedIndex = lines.findIndex((line, index) => index > 0 && index < metadataEnd && /^updated\s*:/.test(line));
  if (updatedIndex < 0) throw new ReviewUpdateConflict("复习计划缺少 updated 元数据");
  lines[updatedIndex] = `updated: ${params.date}`;
  return lines.join(eol);
}
