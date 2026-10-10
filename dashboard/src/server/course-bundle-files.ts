import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import type { CourseSourceDocument } from "../shared/course-bundle.js";
import type { DraftEntry } from "../shared/course-import.js";
import { buildCourseFiles } from "./course-import.js";
import { CourseImportError } from "./course-import-manager.js";
import { safeCourseMatter } from "./safe-course-matter.js";

export const sourceFilePattern = /^source(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.(pdf|docx|html|htm|md|markdown|txt)$/;
export const sourceDocumentSchema = z.object({ id: z.union([z.literal("legacy"), z.string().uuid()]), filename: z.string().min(1).max(1000), storedName: z.string().regex(sourceFilePattern), sourceFormat: z.enum(["pdf", "docx", "text"]), pageCount: z.number().int().min(1).max(10000).optional() }).strict();
export function sourceDocuments(raw: string): CourseSourceDocument[] {
  const data = safeCourseMatter(raw).data.sourceDocuments;
  if (data === undefined) return [];
  const parsed = z.array(sourceDocumentSchema).max(100).safeParse(data);
  if (!parsed.success || new Set(parsed.data.map((item) => item.id)).size !== parsed.data.length || new Set(parsed.data.map((item) => item.storedName)).size !== parsed.data.length) throw new CourseImportError("课件来源清单损坏，请先检查档案", 422);
  return parsed.data;
}
function textOf(node: unknown): string {
  const item = node as { value?: string; children?: unknown[] }; return item.value ?? item.children?.map(textOf).join("") ?? "";
}
function section(content: string, title: string) {
  const nodes = unified().use(remarkParse).use(remarkGfm).parse(content).children;
  const index = nodes.findIndex((node) => node.type === "heading" && node.depth === 2 && textOf(node) === title);
  if (index < 0) throw new CourseImportError(`课程缺少${title}章节，不能追加`, 422);
  return { start: nodes[index].position!.end.offset!, end: nodes.slice(index + 1).find((node) => node.type === "heading" && node.depth <= 2)?.position?.start.offset ?? content.length };
}
const headings = (content: string, depth: number) => unified().use(remarkParse).parse(content).children.filter((node) => node.type === "heading" && node.depth === depth).length;
const escaped = (title: string) => title.replace(/[\r\n]+/g, " ").replace(/([\\`*_[\]<>#~!|])/g, "\\$1");
const tableRows = (raw: string) => safeCourseMatter(raw).content.split("\n").filter((line) => line.startsWith("|")).slice(2).join("\n");
function addTableRows(raw: string, rows: string) {
  if (!rows) return raw;
  const document = safeCourseMatter(raw);
  const table = unified().use(remarkParse).use(remarkGfm).parse(document.content).children.find((node) => node.type === "table");
  if (!table) throw new CourseImportError("资源或日程缺少有效表格，请先检查档案", 422);
  const offset = raw.length - document.content.length + table.position!.end.offset!;
  return raw.slice(0, offset).trimEnd() + "\n" + rows + raw.slice(offset);
}

/** Adds only new material; learning evidence and completed tasks are never regenerated. */
export function buildBundleFiles(entries: DraftEntry[], courseId: string, title: string, today: string, existing?: Record<string, string | null>, legacy?: CourseSourceDocument): Record<string, string> {
  const first = buildCourseFiles(entries[0].draft, courseId, today);
  const course = safeCourseMatter(existing?.["course.md"] ?? first["course.md"]);
  if (!existing) {
    for (const name of ["学习路线", "关键知识"] ) { const bounds = section(course.content, name); course.content = course.content.slice(0, bounds.start) + "\n\n" + course.content.slice(bounds.end); }
    course.data.title = title; course.data.shortTitle = title.slice(0, 12);
    course.content = course.content.replace(/^\s*# .*/m, `\n# ${escaped(title)}`);
    const bounds = section(course.content, "课程概览");
    course.content = course.content.slice(0, bounds.start) + `\n\n来源：${entries.length} 份课件，分别保留原文件与来源页码。\n\n学习目标：待补充。\n\n` + course.content.slice(bounds.end);
    course.data.sourceNoteProvenance = { version: 1, entries: [] };
  }
  const notes = safeCourseMatter(existing?.["notes.md"] ?? `---\ncourseId: ${courseId}\nupdated: ${today}\n---\n# ${escaped(title)}笔记\n`);
  const documents = [...sourceDocuments(matter.stringify(course.content, course.data)), ...(legacy ? [legacy] : [])];
  const provenance = (data: Record<string, any>) => {
    const value = data.sourceNoteProvenance;
    if (value === undefined) return [];
    if (value?.version !== 1 || !Array.isArray(value.entries)) throw new CourseImportError("来源标记损坏，请检查档案后重试", 422);
    return [...value.entries];
  };
  const courseProvenance = provenance(course.data); const noteProvenance = provenance(notes.data);
  const resourceAdditions: string[] = []; const scheduleAdditions: string[] = [];
  for (const entry of entries) {
    const document = { id: entry.id, filename: entry.draft.originalFilename, storedName: `source-${entry.id}${entry.sourceExtension}`, sourceFormat: entry.source.sourceFormat, pageCount: entry.source.pageCount } satisfies CourseSourceDocument;
    documents.push(document);
    const prefix = `课件 ${documents.length} · ${entry.draft.originalFilename.slice(0, 30)} · `;
    const generated = buildCourseFiles({ ...entry.draft, stages: entry.draft.stages.map((stage) => ({ ...stage, title: (prefix + stage.title).slice(0, 100) })) }, courseId, today);
    const importedCourse = safeCourseMatter(generated["course.md"]); const importedNotes = safeCourseMatter(generated["notes.md"]);
    const routeBounds = section(importedCourse.content, "学习路线");
    const keyBounds = section(importedCourse.content, "关键知识");
    const keyPoints = importedCourse.content.slice(keyBounds.start, keyBounds.end).trim();
    const bounds = section(course.content, "学习路线");
    const route = importedCourse.content.slice(routeBounds.start, routeBounds.end).trim();
    course.content = course.content.slice(0, bounds.end).trimEnd() + `\n\n${route}\n\n` + course.content.slice(bounds.end);
    const oldKeys = section(course.content, "关键知识");
    const courseOffset = headings(course.content.slice(oldKeys.start, oldKeys.end), 3);
    const noteOffset = headings(notes.content, 2);
    const encoding = importedCourse.data.sourceExcerptEncoding;
    for (const item of importedCourse.data.sourceNoteProvenance.entries) {
      courseProvenance.push({ ...item, headingIndex: item.headingIndex + courseOffset, sourceId: entry.id, encoding });
      noteProvenance.push({ ...item, headingIndex: item.headingIndex + noteOffset, sourceId: entry.id, encoding });
    }
    course.content = course.content.slice(0, oldKeys.end).trimEnd() + `\n\n${keyPoints}\n\n` + course.content.slice(oldKeys.end);
    const noteContent = importedNotes.content.replace(/^\s*# .*\r?\n/, "").trim();
    notes.content = notes.content.trimEnd() + `\n\n${noteContent}\n`;
    resourceAdditions.push(tableRows(generated["resources.md"]).replaceAll(`/api/courses/${courseId}/source`, `/api/courses/${courseId}/sources/${entry.id}`));
    scheduleAdditions.push(tableRows(generated["schedule.md"]));
  }
  if (documents.length > 100) throw new CourseImportError("每门课程最多保留 100 份课件，请拆分课程", 413);
  course.data.sourceDocuments = documents; course.data.updated = today;
  course.data.sourceNoteProvenance = { version: 1, entries: courseProvenance };
  notes.data.sourceNoteProvenance = { version: 1, entries: noteProvenance }; notes.data.updated = today;
  // Legacy excerpts keep their original encoding; each added note carries its own encoding.
  const result: Record<string, string> = { "course.md": matter.stringify(course.content, course.data), "notes.md": matter.stringify(notes.content, notes.data) };
  for (const [name, additions] of [["resources.md", resourceAdditions], ["schedule.md", scheduleAdditions]] as const) {
    const original = existing?.[name] ?? first[name];
    const base = existing?.[name] != null ? original : original.split("\n").filter((line) => !line.startsWith("|") || /^\| (?:名称|日期|---)/.test(line)).join("\n");
    result[name] = addTableRows(base, additions.filter(Boolean).join("\n"));
  }
  result["reviews.md"] = existing?.["reviews.md"] ?? first["reviews.md"];
  return result;
}
