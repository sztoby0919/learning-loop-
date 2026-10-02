import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import matter from "gray-matter";
import type { Root, RootContent } from "mdast";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { z } from "zod";

import type { SourceReference } from "../shared/course.js";
import type { CourseImportManager } from "./course-import-manager.js";
import { extractDocx } from "./docx-extractor.js";
import { extractHtml } from "./html-extractor.js";
import { extractText } from "./text-extractor.js";
import type { WorkspaceRepository } from "./workspace-repository.js";
import { readPdfPageText } from "./pdf-text-layout.js";

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const limits: Record<string, number> = { ".pdf": 100, ".docx": 50, ".html": 20, ".htm": 20, ".md": 10, ".markdown": 10, ".txt": 10 };

// Both routes share the existing managed-course lookup, then reject links and
// non-files before reading. Never use a path supplied in Markdown or a URL.
export async function safeSourcePath(repository: WorkspaceRepository, imports: CourseImportManager, courseId: string): Promise<string | null> {
  const configured = repository.config.courses.find((course) => course.id === courseId);
  if (!configured) return null;
  const candidate = await imports.sourcePath(courseId);
  if (!candidate || !/^source\.(pdf|docx|md|txt|markdown|html|htm)$/.test(path.basename(candidate))) return null;
  const root = path.resolve(configured.root);
  if (path.dirname(path.resolve(candidate)) !== root) return null;
  try {
    const [managedRoot, courseRoot, rootDetails, details] = await Promise.all([realpath(path.dirname(root)), realpath(root), lstat(root), lstat(candidate)]);
    if (rootDetails.isSymbolicLink() || path.dirname(courseRoot) !== managedRoot || !details.isFile() || details.isSymbolicLink()) return null;
    const resolved = await realpath(candidate);
    return path.dirname(resolved) === courseRoot ? resolved : null;
  } catch { return null; }
}

interface Candidate extends Omit<SourceReference, "kind" | "sourceUrl" | "verifiedExcerpt"> {
  text: string;
}

function textOf(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const value = node as { value?: string; children?: unknown[] };
  return typeof value.value === "string" ? value.value : (value.children ?? []).map(textOf).join("");
}

function markerPosition(node: RootContent | undefined, extension: string): number | null {
  // A marker must be the standalone plain paragraph emitted by the importer,
  // not a link, quotation, code sample, or an arbitrary mention of a page.
  if (node?.type !== "paragraph" || node.children.length !== 1 || node.children[0].type !== "text") return null;
  const pattern = extension === ".pdf" ? /^来源：原 PDF 第 ([1-9]\d*) 页。$/
    : extension === ".docx" ? /^来源：原 Word 文档 第 ([1-9]\d*) (?:页|段文本（估算位置）)。$/
      : /^来源：原 文本文件 第 ([1-9]\d*) 段文本。$/;
  const match = pattern.exec(node.children[0].value);
  const position = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(position) && position > 0 && position <= 1000 ? position : null;
}

function candidates(raw: string, artifact: "course" | "notes", extension: string, courseId: string): Candidate[] {
  const parsed = matter(raw);
  if (parsed.data[artifact === "course" ? "id" : "courseId"] !== courseId) return [];
  const nodes = (unified().use(remarkParse).parse(parsed.content) as Root).children;
  const depth = artifact === "course" ? 3 : 2;
  const provenance = z.object({ version: z.literal(1), entries: z.array(z.object({ headingIndex: z.number().int().min(0).max(59), heading: z.string().min(1).max(100), page: z.number().int().positive(), provenance: z.enum(["source", "ai"]) }).strict()).max(60) }).strict().safeParse(parsed.data.sourceNoteProvenance);
  const validProvenance = provenance.success && new Set(provenance.data.entries.map((item) => item.headingIndex)).size === provenance.data.entries.length ? provenance.data.entries : null;
  let inSection = artifact === "notes";
  let headingIndex = -1;
  const result: Candidate[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (artifact === "course" && node.type === "heading" && node.depth === 2) {
      inSection = textOf(node).trim() === "关键知识";
    }
    if (!inSection || node.type !== "heading" || node.depth !== depth) continue;
    headingIndex += 1;
    const marker = nodes[index + 1];
    const position = markerPosition(marker, extension);
    if (position === null) continue;
    let end = parsed.content.length;
    for (const next of nodes.slice(index + 2)) {
      if (next.type === "heading" && (next.depth === depth || (artifact === "course" && next.depth === 2))) {
        end = next.position?.start.offset ?? end;
        break;
      }
    }
    const body = parsed.content.slice(marker.position?.end.offset ?? end, end).trim();
    // Reverse only the importer's explicitly versioned encoding. Preserve all
    // original # characters and backslashes; legacy Markdown stays untouched.
    let text = parsed.data.sourceExcerptEncoding === "escaped-line-v1"
      ? body.replace(/^\\#/, "#").replace(/\\\\/g, "\\") : body;
    if (parsed.data.sourceExcerptEncoding === "fenced-text-v2") {
      const blocks = (unified().use(remarkParse).parse(body) as Root).children;
      text = blocks.length === 1 && blocks[0].type === "code" && blocks[0].lang === "text" ? blocks[0].value : "";
    }
    result.push({
      artifact, headingIndex, heading: textOf(node).trim(), position,
      // Missing/failed provenance is deliberately conservative: a failed
      // enrichment retry can leave notes from an earlier successful AI call.
      aiDerived: parsed.data.sourceNoteProvenance !== undefined ? !validProvenance?.some((item) => item.headingIndex === headingIndex && item.heading === textOf(node).trim() && item.page === position && item.provenance === "source") : parsed.data.aiStatus !== "not-used",
      text: normalize(text),
    });
    if (result.length >= 60) break;
  }
  return result;
}

async function readCandidates(root: string, artifact: "course" | "notes", extension: string, courseId: string): Promise<Candidate[]> {
  const filename = path.join(root, `${artifact}.md`);
  try {
    const details = await lstat(filename);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 2 * 1024 * 1024 || path.dirname(await realpath(filename)) !== root) return [];
    return candidates(await readFile(filename, "utf8"), artifact, extension, courseId);
  } catch { return []; }
}

async function sourceTexts(sourcePath: string, positions: number[]): Promise<Map<number, string[]>> {
  const extension = path.extname(sourcePath);
  const details = await lstat(sourcePath);
  if (!details.isFile() || details.isSymbolicLink() || details.size > limits[extension] * 1024 * 1024) return new Map();
  const bytes = await readFile(sourcePath);
  if (extension !== ".pdf") {
    const extracted = extension === ".docx" ? await extractDocx(bytes, path.basename(sourcePath))
      : /\.html?$/.test(extension) ? await extractHtml(bytes, path.basename(sourcePath))
        : await extractText(bytes, path.basename(sourcePath));
    return new Map(extracted.pages.filter((page) => positions.includes(page.page)).map((page) => [page.page, [normalize(page.text)]]));
  }
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") return new Map();
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  try {
    const document = await task.promise;
    if (document.numPages > 1000) return new Map();
    const texts = new Map<number, string[]>();
    // Only read distinct pages referenced by generated markers, never scan
    // the whole PDF merely to display a source card.
    for (const position of new Set(positions)) {
      if (position > document.numPages) continue;
      const page = await document.getPage(position);
      try {
        const content = await page.getTextContent();
        // Verify either the current layout order or the legacy stream order,
        // never a concatenation that could substantiate invented mixed text.
        texts.set(position, [
          normalize(readPdfPageText(content.items, page.view[2] - page.view[0]).text),
          normalize(content.items.flatMap((item) => "str" in item ? [item.str] : []).join(" ")),
        ]);
      } finally { page.cleanup(); }
    }
    return texts;
  } finally { await task.destroy().catch(() => {}); }
}

export async function readSourceReferences(repository: WorkspaceRepository, imports: CourseImportManager, courseId: string): Promise<SourceReference[]> {
  const sourcePath = await safeSourcePath(repository, imports, courseId);
  if (!sourcePath) return [];
  const root = path.dirname(sourcePath);
  const extension = path.extname(sourcePath);
  const references = (await Promise.all((["course", "notes"] as const).map((artifact) => readCandidates(root, artifact, extension, courseId)))).flat();
  if (!references.length) return [];
  let texts: Map<number, string[]>;
  try { texts = await sourceTexts(sourcePath, references.map((reference) => reference.position)); }
  catch { return []; } // Changed, unreadable or corrupt sources cannot substantiate a reference.
  return references.flatMap(({ text, ...reference }) => {
    const extracted = texts.get(reference.position);
    if (extracted === undefined) return [];
    const kind = extension === ".pdf" ? "pdf-page" : "virtual-position";
    return [{
      ...reference, kind,
      sourceUrl: `/api/courses/${encodeURIComponent(courseId)}/source${kind === "pdf-page" ? `#page=${reference.position}` : ""}`,
      // Verify the entire candidate before truncating; a matching prefix must
      // not hide an invented continuation beyond the 500-character limit.
      verifiedExcerpt: !reference.aiDerived && text && extracted.some((variant) => variant.includes(text)) ? text.slice(0, 500) : null,
    } satisfies SourceReference];
  });
}
