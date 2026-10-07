import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import { parseCourseMarkdown } from "./course-parser.js";
import { batchAtomicWrite } from "./file-utils.js";
import type { WorkspaceRepository } from "./workspace-repository.js";
import type { CourseEventBus } from "./course-events.js";
import type { CourseEditSnapshot } from "../shared/course-management.js";
import type { RootContent } from "mdast";

export class CourseManagementError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const line = z.string().trim().min(1).max(500).refine((s) => !/[\r\n]/.test(s));
const version = z.object({ expectedHash: z.string().regex(/^[a-f0-9]{64}$/) });
const edit = version.extend({ title: line, overviewMarkdown: z.string().max(30000), stages: z.array(z.object({ title: line, sourceStage: z.number().int().nonnegative().optional(), tasks: z.array(z.object({ text: line, completed: z.boolean(), sourceTask: z.number().int().nonnegative().optional() })).max(300) })).max(100) });
const literal = (s: string) => s.replace(/([\\`*_[\]<>#~!|])/g, "\\$1");
function nodeText(node: unknown): string {
  const item = node as { value?: string; children?: unknown[] };
  return item.value ?? item.children?.map(nodeText).join("") ?? "";
}

function editedRoadmap(content: string, stages: CourseEditSnapshot["stages"]): string {
  const nodes = unified().use(remarkParse).use(remarkGfm).parse(content).children;
  const start = nodes.findIndex((node) => node.type === "heading" && node.depth === 2 && nodeText(node) === "学习路线");
  const route: RootContent[] = [];
  for (const node of nodes.slice(start + 1)) { if (node.type === "heading" && node.depth <= 2) break; route.push(node); }
  const originals = new Map<string, { text: string; raw: string }>();
  let stageIndex = -1; let taskIndex = 0;
  const extras: string[] = [];
  const slice = (node: RootContent) => content.slice(node.position!.start.offset!, node.position!.end.offset!);
  for (const node of route) {
    if (node.type === "heading" && node.depth === 3) { stageIndex++; taskIndex = 0; continue; }
    if (node.type !== "list") { extras.push(slice(node)); continue; }
    for (const item of node.children) {
      if (typeof item.checked !== "boolean") { extras.push(slice(item)); continue; }
      const text = nodeText(item).trim();
      originals.set(`${stageIndex}:${taskIndex++}`, { text, raw: slice(item) });
    }
  }
  const roadmap = stages.map((stage) => `### ${literal(stage.title)}\n\n${stage.tasks.map((task) => {
    const candidate = originals.get(`${stage.sourceStage}:${task.sourceTask}`);
    const original = candidate?.text === task.text ? candidate.raw : undefined;
    // Retain existing links, inline formatting and source annotations for unchanged task text.
    return original ? original.replace(/^([-*+]\s+|\d+[.)]\s+)\[[ xX]\]/, `$1[${task.completed ? "x" : " "}]`) : `- [${task.completed ? "x" : " "}] ${literal(task.text)}`;
  }).join("\n")}`).join("\n\n");
  return [roadmap, extras.join("\n\n")].filter(Boolean).join("\n\n");
}

// AST offsets avoid treating headings inside fenced code as section boundaries.
function replaceSection(content: string, title: string, replacement: string): string {
  const nodes = unified().use(remarkParse).use(remarkGfm).parse(content).children;
  const index = nodes.findIndex((node) => node.type === "heading" && node.depth === 2 && node.children.map((child) => "value" in child ? child.value : "").join("") === title);
  if (index < 0) throw new CourseManagementError(`缺少${title}章节`, 422);
  const end = nodes.slice(index + 1).find((node) => node.type === "heading" && node.depth <= 2)?.position?.start.offset ?? content.length;
  const start = nodes[index].position!.end.offset!;
  return content.slice(0, start) + "\n\n" + replacement.trim() + "\n\n" + content.slice(end);
}

export class CourseManagement {
  private busy = new Set<string>();
  constructor(private repository: WorkspaceRepository, private events: CourseEventBus) {}
  private async read(id: string) {
    const configured = this.repository.config.courses.find((course) => course.id === id);
    if (!configured) throw new CourseManagementError("未知课程", 404);
    const file = path.join(configured.root, "course.md");
    if (path.dirname(await realpath(file)) !== await realpath(configured.root)) throw new CourseManagementError("课程文件路径不安全", 422);
    const raw = await readFile(file, "utf8");
    const course = parseCourseMarkdown(raw, file);
    if (course.id !== id) throw new CourseManagementError("课程 ID 与注册信息不一致", 409);
    return { configured, file, raw, course, expectedHash: createHash("sha256").update(raw).digest("hex") };
  }
  async snapshot(id: string) {
    const { course, expectedHash } = await this.read(id);
    return { expectedHash, title: course.title, overviewMarkdown: course.overviewMarkdown, stages: course.stages.map((stage, sourceStage) => ({ ...stage, sourceStage, tasks: stage.tasks.map((task, sourceTask) => ({ ...task, sourceTask })) })) };
  }
  async mutate(id: string, input: unknown, deleting: boolean) {
    if (this.busy.has(id)) throw new CourseManagementError("课程正在保存，请稍后重试", 409);
    this.busy.add(id);
    try {
      const parsed = (deleting ? version : edit).safeParse(input);
      if (!parsed.success) throw new CourseManagementError("请填写有效课程名称、阶段、任务和文件版本", 400);
      const current = await this.read(id);
      if (current.expectedHash !== parsed.data.expectedHash) throw new CourseManagementError("课程已被修改，请重新打开编辑后保存；当前输入已保留", 409);
      const document = matter(current.raw);
      if (deleting) { document.data.deleted = true; document.data.deletedAt = new Date().toISOString(); }
      else {
        const data = edit.parse(input);
        // Overview may contain Markdown, but must not introduce another top-level section.
        const headings = unified().use(remarkParse).parse(data.overviewMarkdown).children;
        if (headings.some((node) => node.type === "heading" && node.depth <= 2)) throw new CourseManagementError("简介中的标题请使用三级或更低级标题", 400);
        document.data.title = data.title;
        if (data.title !== current.course.title && document.data.shortTitle !== undefined) document.data.shortTitle = data.title;
        document.data.updated = new Date().toLocaleDateString("sv-SE");
        if (data.overviewMarkdown !== current.course.overviewMarkdown) document.content = replaceSection(document.content, "课程概览", data.overviewMarkdown);
        const stages = data.stages.map((stage) => ({ title: stage.title, tasks: stage.tasks.map((task) => ({ text: task.text, completed: task.completed })) }));
        if (JSON.stringify(stages) !== JSON.stringify(current.course.stages)) document.content = replaceSection(document.content, "学习路线", editedRoadmap(document.content, data.stages));
        const nodes = unified().use(remarkParse).parse(document.content).children;
        const heading = nodes.find((node) => node.type === "heading" && node.depth === 1);
        if (heading) document.content = document.content.slice(0, heading.position!.start.offset!) + `# ${literal(data.title)}` + document.content.slice(heading.position!.end.offset!);
      }
      const raw = matter.stringify(document.content, document.data);
      const course = parseCourseMarkdown(raw, current.file);
      const result = await batchAtomicWrite([{ filePath: current.file, content: raw, expectedHash: current.expectedHash }]);
      if (!result.success) throw new CourseManagementError(result.conflict ? "课程已被修改，请重新打开编辑后保存" : "保存失败：" + result.error, result.conflict ? 409 : 500);
      if (deleting) this.repository.removeCourses([current.configured]);
      else await this.repository.refresh(id, "course");
      this.events.publish("journal-updated", { courseId: id, artifact: "course" });
      return deleting ? { deleted: true, filesRetained: true } : { course };
    } finally { this.busy.delete(id); }
  }
}
