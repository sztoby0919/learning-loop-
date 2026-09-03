import matter from "gray-matter";
import type { Content, Root } from "mdast";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";

import type { CourseDetail, CourseId, CourseStage, StudyRecord } from "../shared/course.js";

const REQUIRED_SECTIONS = ["课程概览", "学习路线", "关键知识", "易错点", "学习记录"] as const;

export class CourseParseError extends Error {
  constructor(
    message: string,
    readonly sourcePath: string,
  ) {
    super(`${sourcePath}: ${message}`);
    this.name = "CourseParseError";
  }
}

function textOf(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const record = node as { value?: unknown; children?: unknown[] };
  if (typeof record.value === "string") return record.value;
  return Array.isArray(record.children) ? record.children.map(textOf).join("") : "";
}

function isHeading(node: Content, depth: number, title?: string): boolean {
  return node.type === "heading" && node.depth === depth && (title === undefined || textOf(node).trim() === title);
}

function sectionBounds(root: Root, title: string): { startIndex: number; endIndex: number; startOffset: number; endOffset: number } {
  const startIndex = root.children.findIndex((node) => isHeading(node, 2, title));
  if (startIndex < 0) throw new Error(`缺少“${title}”二级标题`);

  let endIndex = root.children.length;
  for (let index = startIndex + 1; index < root.children.length; index += 1) {
    const node = root.children[index];
    if (node.type === "heading" && node.depth <= 2) {
      endIndex = index;
      break;
    }
  }

  const heading = root.children[startIndex];
  const nextNode = root.children[endIndex];
  return {
    startIndex,
    endIndex,
    startOffset: heading.position?.end.offset ?? 0,
    endOffset: nextNode?.position?.start.offset ?? Number.MAX_SAFE_INTEGER,
  };
}

function parseStages(root: Root, startIndex: number, endIndex: number): CourseStage[] {
  const stages: CourseStage[] = [];
  let current: CourseStage | undefined;

  for (const node of root.children.slice(startIndex + 1, endIndex)) {
    if (isHeading(node, 3)) {
      current = { title: textOf(node).trim(), tasks: [] };
      stages.push(current);
      continue;
    }

    if (!current || node.type !== "list") continue;
    for (const item of node.children) {
      if (typeof item.checked !== "boolean") continue;
      current.tasks.push({ text: textOf(item).trim(), completed: item.checked });
    }
  }

  return stages;
}

function parseRecords(root: Root, startIndex: number, endIndex: number, warnings: string[]): StudyRecord[] {
  const table = root.children.slice(startIndex + 1, endIndex).find((node) => node.type === "table");
  if (!table || table.type !== "table") return [];

  return table.children.slice(1).flatMap((row, index) => {
    const cells = row.children.map((cell) => textOf(cell).trim());
    if (cells.every((cell) => cell === "")) return [];
    if (cells.length < 5) {
      warnings.push(`学习记录第 ${index + 1} 行列数不足，已忽略`);
      return [];
    }

    const parsedMastery = Number.parseInt(cells[2], 10);
    const mastery = Number.isInteger(parsedMastery) && parsedMastery >= 1 && parsedMastery <= 10 ? parsedMastery : null;
    if (cells[2] && mastery === null) warnings.push(`学习记录 ${cells[0] || index + 1} 的掌握度无效`);

    return [{
      date: cells[0],
      content: cells[1],
      mastery,
      difficulty: cells[3],
      nextStep: cells[4],
    }];
  });
}

function normalizeUpdated(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").trim();
}

export function parseCourseMarkdown(raw: string, sourcePath: string): CourseDetail {
  try {
    const parsedMatter = matter(raw);
    const id = String(parsedMatter.data.id ?? "") as CourseId;
    const title = String(parsedMatter.data.title ?? "").trim();
    const accent = String(parsedMatter.data.accent ?? "").trim();
    const updated = normalizeUpdated(parsedMatter.data.updated);

    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`非法课程 ID“${id}”`);
    if (!title) throw new Error("frontmatter 缺少 title");
    if (!/^#[0-9a-fA-F]{6}$/.test(accent)) throw new Error("accent 必须是 6 位 HEX 颜色");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(updated)) throw new Error("updated 必须为 YYYY-MM-DD");

    const root = unified().use(remarkParse).use(remarkGfm).parse(parsedMatter.content) as Root;
    const bounds = Object.fromEntries(REQUIRED_SECTIONS.map((section) => [section, sectionBounds(root, section)])) as Record<(typeof REQUIRED_SECTIONS)[number], ReturnType<typeof sectionBounds>>;
    const warnings: string[] = [];
    const route = bounds["学习路线"];
    const recordsBounds = bounds["学习记录"];
    const stages = parseStages(root, route.startIndex, route.endIndex);
    const records = parseRecords(root, recordsBounds.startIndex, recordsBounds.endIndex, warnings);
    const tasks = stages.flatMap((stage) => stage.tasks);
    const completedTasks = tasks.filter((task) => task.completed).length;
    const firstIncompleteStage = stages.find((stage) => stage.tasks.some((task) => !task.completed));
    const firstIncompleteTask = firstIncompleteStage?.tasks.find((task) => !task.completed);
    const latestMastery = [...records].reverse().find((record) => record.mastery !== null)?.mastery ?? null;

    const markdownFor = (section: (typeof REQUIRED_SECTIONS)[number]) => {
      const { startOffset, endOffset } = bounds[section];
      return parsedMatter.content.slice(startOffset, endOffset).trim();
    };

    return {
      id,
      title,
      shortTitle: String(parsedMatter.data.shortTitle ?? title).trim(),
      accent,
      updated,
      order: Number.isFinite(Number(parsedMatter.data.order)) ? Number(parsedMatter.data.order) : 999,
      archived: parsedMatter.data.archived === true,
      status: "ready",
      progress: tasks.length === 0 ? null : Math.round((completedTasks / tasks.length) * 100),
      completedTasks,
      totalTasks: tasks.length,
      currentStage: firstIncompleteStage?.title ?? null,
      nextTask: tasks.length > 0 && !firstIncompleteTask ? "已完成全部计划" : firstIncompleteTask?.text ?? null,
      mastery: latestMastery,
      overviewMarkdown: markdownFor("课程概览"),
      keyPointsMarkdown: markdownFor("关键知识"),
      mistakesMarkdown: markdownFor("易错点"),
      stages,
      records,
      warnings,
      sourcePath,
    };
  } catch (error) {
    if (error instanceof CourseParseError) throw error;
    throw new CourseParseError(error instanceof Error ? error.message : String(error), sourcePath);
  }
}
