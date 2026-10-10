import type { ExtractedDocument } from "./course-import.js";

export class HtmlImportError extends Error {
  constructor(message: string) {
    super(message);
  }
}

const headingPattern = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
const tagStripPattern = /<[^>]*>/g;
const entityPattern = /&(?:amp|lt|gt|quot|nbsp|#\d+);/g;
const entityMap: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": "\"",
  "&nbsp;": " ",
};

function decodeEntity(match: string): string {
  if (match.startsWith("&#")) {
    const code = parseInt(match.slice(2, -1), 10);
    return String.fromCharCode(code);
  }
  return entityMap[match] ?? match;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(tagStripPattern, " ")
    .replace(entityPattern, decodeEntity)
    .replace(/\s+/g, " ")
    .trim();
}

function extractHeadings(html: string): Array<{ title: string; level: number }> {
  const headings: Array<{ title: string; level: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(html)) !== null) {
    const level = Number(match[1]);
    const title = match[2].replace(tagStripPattern, "").replace(entityPattern, decodeEntity).trim();
    if (title) headings.push({ title: title.slice(0, 100), level });
  }
  return headings;
}

export async function extractHtml(bytes: Uint8Array, originalFilename: string): Promise<ExtractedDocument> {
  const encoding = detectEncoding(bytes);
  const html = new TextDecoder(encoding).decode(bytes).trim();

  if (html.length < 10) {
    throw new HtmlImportError("HTML 文件内容为空或过少");
  }

  const headings = extractHeadings(html);
  const text = stripHtml(html);

  if (text.length < 5) {
    throw new HtmlImportError("无法从 HTML 提取足够文字");
  }
  if (text.length > 800_000) throw new HtmlImportError("HTML 超过 1,000 页等价长度，请拆分后导入");

  const charsPerPage = 800;
  const pages: ExtractedDocument["pages"] = [];
  for (let i = 0; i < text.length; i += charsPerPage) {
    pages.push({ page: Math.floor(i / charsPerPage) + 1, text: text.slice(i, i + charsPerPage) });
  }

  let title = "";
  const firstH1 = headings.find((h) => h.level === 1);
  if (firstH1) {
    title = firstH1.title;
  } else if (headings.length > 0) {
    title = headings[0].title;
  } else {
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (titleMatch) {
      title = titleMatch[1].replace(tagStripPattern, "").trim().slice(0, 100);
    } else {
      title = text.split("\n")[0]?.trim().slice(0, 100) ?? originalFilename.replace(/\.html?$/i, "");
    }
  }

  const warnings: string[] = [];
  if (headings.length === 0) {
    warnings.push("未检测到 HTML 标题（h1-h3），将使用全文作为学习内容。");
  }

  return {
    title: title || originalFilename.replace(/\.html?$/i, ""),
    pageCount: Math.max(1, pages.length),
    pages,
    outline: headings.slice(0, 10000).map((h) => {
      const headingIndex = text.indexOf(h.title);
      return { title: h.title, page: Math.max(1, Math.floor(Math.max(0, headingIndex) / charsPerPage) + 1), level: h.level };
    }),
    warnings,
    sourceFormat: "text",
  };
}

function detectEncoding(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return "utf-16be";
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return "utf-16le";
  return "utf-8";
}
