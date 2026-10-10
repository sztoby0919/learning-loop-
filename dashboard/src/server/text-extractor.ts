import type { ExtractedDocument } from "./course-import.js";

export class TextImportError extends Error {
  constructor(message: string) {
    super(message);
  }
}

const headingPattern = /^(#{1,6})\s+(.+)$/gm;

export async function extractText(bytes: Uint8Array, originalFilename: string): Promise<ExtractedDocument> {
  const encoding = detectEncoding(bytes);
  const text = new TextDecoder(encoding).decode(bytes).trim();

  if (text.length < 5) {
    throw new TextImportError("文件内容为空或过少");
  }
  if (text.length > 800_000) throw new TextImportError("文本超过 1,000 页等价长度，请拆分后导入");

  // Parse headings from markdown
  const outline: ExtractedDocument["outline"] = [];
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(text)) !== null) {
    const title = match[2].trim().slice(0, 100);
    if (title) outline.push({ title, page: Math.floor(match.index / 800) + 1, level: match[1].length });
  }

  // Split into simulated pages (~800 chars each)
  const charsPerPage = 800;
  const pages: ExtractedDocument["pages"] = [];
  for (let i = 0; i < text.length; i += charsPerPage) {
    pages.push({ page: Math.floor(i / charsPerPage) + 1, text: text.slice(i, i + charsPerPage) });
  }

  // Extract title: first H1 heading, or first line, or filename
  let title = "";
  const firstH1 = /^#\s+(.+)$/m.exec(text);
  if (firstH1) {
    title = firstH1[1].trim().slice(0, 100);
  } else {
    title = text.split("\n")[0]?.trim().slice(0, 100) ?? originalFilename.replace(/\.(md|txt|markdown)$/i, "");
  }

  return {
    title: title || originalFilename.replace(/\.(md|txt|markdown)$/i, ""),
    pageCount: Math.max(1, pages.length),
    pages,
    outline: outline.slice(0, 10000),
    warnings: outline.length === 0 ? ["未检测到 Markdown 标题（# 标题），将使用全文作为学习内容。"] : [],
    sourceFormat: "text",
  };
}

function detectEncoding(bytes: Uint8Array): string {
  // Detect UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return "utf-8";
  }
  // Detect UTF-16 BE BOM
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return "utf-16be";
  }
  // Detect UTF-16 LE BOM
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return "utf-16le";
  }
  // Default to utf-8 (TextDecoder will handle most cases gracefully)
  return "utf-8";
}
