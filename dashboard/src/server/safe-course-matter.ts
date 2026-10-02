import matter from "gray-matter";
import { BackupError } from "./backup-zip.js";

// gray-matter exposes engines at runtime but omits it from its bundled types.
export const courseMatterEngines = (matter as typeof matter & {
  engines: Record<string, { parse: (input: string) => object; stringify?: (data: object) => string }>;
}).engines;

// Uploaded files are data, not plug-in programs. Restrict the delimiter before
// invoking gray-matter; schema validation would be too late to stop an engine.
export function safeCourseMatter(raw: string) {
  const normalized = raw.replace(/^\uFEFF/, "");
  if (normalized.startsWith("---")) {
    const firstLine = normalized.split(/\r?\n/, 1)[0];
    if (firstLine !== "---" && firstLine !== "---yaml") throw new BackupError("课程 frontmatter 仅支持不可执行的 YAML 格式");
  }
  return matter(normalized, { language: "yaml", engines: { yaml: courseMatterEngines.yaml, javascript: { parse: () => { throw new BackupError("不支持可执行 frontmatter"); } } } });
}
