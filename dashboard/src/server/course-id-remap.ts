import { safeCourseMatter as matter } from "./safe-course-matter.js";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, Table } from "mdast";

// Patch only explicit top-level metadata scalars. Re-serializing YAML would
// normalize dates and alter evidence, even if the body was kept unchanged.
function association(raw: string, key: string, oldId: string, newId: string): string {
  const data = matter(raw).data;
  if (data[key] !== oldId) throw new Error(`${key} 与归档课程不一致`);
  const header = /^(---(?:yaml)?\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(raw);
  if (!header) throw new Error("文件缺少课程 metadata");
  const lines = header[2].split(/\r?\n/);
  const matches = lines.filter((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (matches.length !== 1) throw new Error("课程关联字段必须唯一且位于顶层");
  const patched = header[2].replace(new RegExp(`^${key}\\s*:.*$`, "m"), `${key}: ${newId}`);
  return header[1] + patched + header[3] + raw.slice(header[0].length);
}

function resourceUrls(raw: string, oldId: string, newId: string): string {
  const prefix = `/api/courses/${oldId}/source`;
  const replacement = `/api/courses/${newId}/source`;
  const isSourceUrl = (value: string) => value === prefix || new RegExp(`^${prefix}(?:#page=[1-9]\\d*|s/(?:legacy|[0-9a-f-]{36})(?:#page=[1-9]\\d*)?)$`).test(value);
  const content = matter(raw).content;
  const offset = raw.length - content.length;
  const tree = unified().use(remarkParse).use(remarkGfm).parse(content) as Root;
  const changes: Array<{ start: number; end: number; value: string }> = [];
  for (const node of tree.children) {
    if (node.type !== "table") continue;
    const table = node as Table;
    // artifact-parser treats the FIRST table as resources, regardless of labels.
    for (const row of table.children.slice(1)) {
      const cell = row.children[2];
      if (cell?.children.length !== 1 || !cell.children[0].position) continue;
      const child = cell.children[0];
      const start = offset + child.position!.start.offset!; const end = offset + child.position!.end.offset!;
      const text = raw.slice(start, end);
      // A single plain URL or single Markdown link; never rewrite labels or prose.
      const plain = text.trim();
      if (isSourceUrl(plain)) {
        changes.push({ start, end, value: text.replace(prefix, replacement) });
      } else if (cell.children.length === 1 && cell.children[0].type === "link") {
        const link = cell.children[0];
        if (isSourceUrl(link.url)) {
          const destination = text.lastIndexOf(`](${link.url})`);
          if (destination >= 0) changes.push({ start: start + destination + 2, end: start + destination + 2 + link.url.length, value: link.url.replace(prefix, replacement) });
        }
      }
    }
    break;
  }
  for (const change of changes.sort((a, b) => b.start - a.start)) raw = raw.slice(0, change.start) + change.value + raw.slice(change.end);
  return raw;
}

export function remapCourseFiles(files: Record<string, string>, oldId: string, newId: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [file, original] of Object.entries(files)) {
    const data = matter(original).data;
    let raw = original;
    if (file === "course.md") raw = association(raw, "id", oldId, newId);
    else if (!file.startsWith("sessions/") || data.courseId !== undefined) raw = association(raw, "courseId", oldId, newId);
    if (file.startsWith("sessions/") && ["ai-assessment", "targeted-practice", "review-attempt"].includes(data.kind)) {
      if (data.evidenceCourseId !== undefined && !/^[a-z0-9][a-z0-9-]{0,99}$/.test(String(data.evidenceCourseId))) throw new Error("证据课程 ID 无效");
      if (data.evidenceCourseId === undefined) raw = raw.replace(/^(---(?:yaml)?\r?\n)/, `$1evidenceCourseId: ${oldId}\n`);
    }
    if (file === "resources.md") raw = resourceUrls(raw, oldId, newId);
    result[file] = raw;
  }
  return result;
}
