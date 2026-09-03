import matter from "gray-matter";
import type { Root, Table } from "mdast";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";

import type { NoteDocument, ResourceDocument, ReviewDocument, ReviewStatus, ScheduleDocument } from "../shared/course.js";

function textOf(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const value = node as { value?: unknown; children?: unknown[] };
  if (typeof value.value === "string") return value.value;
  return Array.isArray(value.children) ? value.children.map(textOf).join("") : "";
}

function parseBase(raw: string, sourcePath: string) {
  const parsed = matter(raw);
  const courseId = String(parsed.data.courseId ?? "").trim();
  const updatedValue = parsed.data.updated;
  const updated = updatedValue instanceof Date ? updatedValue.toISOString().slice(0, 10) : String(updatedValue ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(courseId)) throw new Error(`${sourcePath}: courseId 非法`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(updated)) throw new Error(`${sourcePath}: updated 必须为 YYYY-MM-DD`);
  const root = unified().use(remarkParse).use(remarkGfm).parse(parsed.content) as Root;
  return { courseId, updated, content: parsed.content.trim(), root };
}

function firstTable(root: Root): Table | null {
  const table = root.children.find((node) => node.type === "table");
  return table?.type === "table" ? table : null;
}

function tableRows(root: Root, columns: number, sourcePath: string, warnings: string[]): string[][] {
  const table = firstTable(root);
  if (!table) return [];
  return table.children.slice(1).flatMap((row, index) => {
    const cells = row.children.map((cell) => textOf(cell).trim());
    if (cells.every((cell) => !cell)) return [];
    if (cells.length < columns) {
      warnings.push(`${sourcePath}: 第 ${index + 1} 行列数不足，已忽略`);
      return [];
    }
    return [cells];
  });
}

function nullableDate(value: string, sourcePath: string, warnings: string[]): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    warnings.push(`${sourcePath}: 非法日期“${value}”`);
    return null;
  }
  return value;
}

function nullableMastery(value: string, sourcePath: string, warnings: string[]): number | null {
  if (!value) return null;
  const mastery = Number(value);
  if (!Number.isInteger(mastery) || mastery < 1 || mastery > 10) {
    warnings.push(`${sourcePath}: 非法掌握度“${value}”`);
    return null;
  }
  return mastery;
}

function reviewStatus(nextReview: string | null, today: string): ReviewStatus {
  if (!nextReview) return "unscheduled";
  if (nextReview === today) return "today";
  return nextReview < today ? "overdue" : "upcoming";
}

export function parseNotesMarkdown(raw: string, sourcePath: string): NoteDocument {
  const base = parseBase(raw, sourcePath);
  return {
    courseId: base.courseId,
    updated: base.updated,
    markdown: base.content,
    headings: base.root.children.filter((node) => node.type === "heading" && node.depth === 2).map(textOf),
    warnings: [],
  };
}

export function parseStandaloneNoteMarkdown(raw: string, sourcePath: string, metadata: { id: string; title: string; accent: string; updated: string }): NoteDocument {
  const root = unified().use(remarkParse).use(remarkGfm).parse(raw) as Root;
  return {
    courseId: metadata.id,
    title: metadata.title,
    accent: metadata.accent,
    updated: metadata.updated,
    markdown: raw.trim(),
    headings: root.children.filter((node) => node.type === "heading" && node.depth === 2).map(textOf),
    warnings: [],
  };
}

export function parseReviewsMarkdown(raw: string, sourcePath: string, today: string): ReviewDocument {
  const base = parseBase(raw, sourcePath);
  const warnings: string[] = [];
  const items = tableRows(base.root, 5, sourcePath, warnings).map((cells) => {
    const lastReviewed = nullableDate(cells[1], sourcePath, warnings);
    const nextReview = nullableDate(cells[2], sourcePath, warnings);
    return {
      courseId: base.courseId,
      topic: cells[0],
      lastReviewed,
      nextReview,
      mastery: nullableMastery(cells[3], sourcePath, warnings),
      evidence: cells[4],
      status: reviewStatus(nextReview, today),
    };
  });
  return { courseId: base.courseId, updated: base.updated, items, warnings };
}

export function parseResourcesMarkdown(raw: string, sourcePath: string): ResourceDocument {
  const base = parseBase(raw, sourcePath);
  const warnings: string[] = [];
  const items = tableRows(base.root, 6, sourcePath, warnings).map((cells) => ({
    courseId: base.courseId,
    name: cells[0], type: cells[1], location: cells[2], stage: cells[3], status: cells[4], note: cells[5],
  }));
  return { courseId: base.courseId, updated: base.updated, items, warnings };
}

export function parseScheduleMarkdown(raw: string, sourcePath: string): ScheduleDocument {
  const base = parseBase(raw, sourcePath);
  const warnings: string[] = [];
  const items = tableRows(base.root, 6, sourcePath, warnings).flatMap((cells) => {
    const date = nullableDate(cells[0], sourcePath, warnings);
    return date ? [{ courseId: base.courseId, date, type: cells[1], title: cells[2], stage: cells[3], status: cells[4], note: cells[5] }] : [];
  });
  return { courseId: base.courseId, updated: base.updated, items, warnings };
}
