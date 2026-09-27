import { convertToHtml, extractRawText } from "mammoth";

import type { ExtractedDocument } from "./course-import.js";

export class DocxImportError extends Error {
  constructor(readonly code: "INVALID_DOCX" | "NO_TEXT" | "TOO_MANY_PAGES", message: string) {
    super(message);
  }
}

interface HeadingInfo {
  title: string;
  level: number;
}

interface ConvertResult {
  value: string;
  messages: Array<{ type: string; message: string }>;
}

function parseHeadingsFromHtml(html: string): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  const headingPattern = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(html)) !== null) {
    const level = Number(match[1]);
    const rawTitle = match[2].replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, "\"").trim();
    if (rawTitle) headings.push({ title: rawTitle, level });
  }
  return headings;
}

export async function extractDocx(bytes: Uint8Array, filename: string): Promise<ExtractedDocument> {
  if (bytes.length < 4) {
    throw new DocxImportError("INVALID_DOCX", "文件不是有效的 Word 文档");
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4B) {
    throw new DocxImportError("INVALID_DOCX", "文件不是有效的 Word 文档（仅支持 .docx 格式，不支持旧版 .doc）");
  }

  let htmlResult: ConvertResult;
  let rawTextResult: { value: string };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const buffer = Buffer.from(bytes);
    const conversion = Promise.all([convertToHtml({ buffer }, {
      styleMap: [
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='标题 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='标题 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
        "p[style-name='标题 3'] => h3:fresh",
        "p[style-name='Heading 4'] => h4:fresh",
        "p[style-name='标题 4'] => h4:fresh",
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='标题'] => h1:fresh",
      ],
    }), extractRawText({ buffer })]);
    [htmlResult, rawTextResult] = await Promise.race([
      conversion,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("DOCX 解析超时（60 秒）")), 60_000); }),
    ]) as [ConvertResult, { value: string }];
  } catch (error) {
    if (error instanceof DocxImportError) throw error;
    if (error instanceof Error && /超时/.test(error.message)) {
      throw new DocxImportError("INVALID_DOCX", "Word 文档解析超时，请尝试拆分文件后导入");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new DocxImportError("INVALID_DOCX", `Word 文档损坏或无法解析：${message}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  const fullText = rawTextResult.value.trim();
  if (fullText.length < 5) {
    throw new DocxImportError("NO_TEXT", "无法从 Word 文档提取足够文字；图片型文档暂不支持，请使用包含可编辑文字的版本");
  }

  const html = htmlResult.value;
  const headings = parseHeadingsFromHtml(html);

  const charsPerPage = 800;
  const totalPages = Math.max(1, Math.ceil(fullText.length / charsPerPage));

  if (totalPages > 1000) {
    throw new DocxImportError("TOO_MANY_PAGES", "Word 文档超过 1,000 页等价长度，请拆分后导入");
  }

  const outline: ExtractedDocument["outline"] = [];
  if (headings.length > 0) {
    let lastIndex = 0;
    for (const heading of headings) {
      const headingHtmlIndex = html.indexOf(`<h${heading.level}`, lastIndex);
      if (headingHtmlIndex >= 0) {
        const ratio = headingHtmlIndex / html.length;
        const page = Math.min(totalPages, Math.max(1, Math.floor(ratio * totalPages) + 1));
        outline.push({ title: heading.title.slice(0, 100), page });
        lastIndex = headingHtmlIndex + 1;
      } else {
        outline.push({ title: heading.title.slice(0, 100), page: 1 });
      }
    }
  }

  const pages: ExtractedDocument["pages"] = [];
  for (let i = 0; i < fullText.length; i += charsPerPage) {
    pages.push({ page: Math.floor(i / charsPerPage) + 1, text: fullText.slice(i, i + charsPerPage) });
  }

  let title = "";
  if (headings.length > 0 && headings[0].level === 1) {
    title = headings[0].title;
  } else if (headings.length > 0) {
    title = headings[0].title;
  } else {
    title = fullText.split("\n")[0]?.trim().slice(0, 100) ?? filename.replace(/\.docx$/i, "");
  }

  const warnings: string[] = [];
  if (htmlResult.messages.length > 0) {
    const conversionWarnings = htmlResult.messages.filter((m: { type: string }) => m.type === "warning").map((m: { message: string }) => m.message);
    if (conversionWarnings.length > 0) {
      warnings.push(`Word 文档转换时出现 ${conversionWarnings.length} 个警告：${conversionWarnings.slice(0, 3).join("；")}`);
    }
  }

  return {
    title: title || filename.replace(/\.docx$/i, ""),
    pageCount: pages.length,
    pages,
    outline: outline.slice(0, 60),
    warnings,
    sourceFormat: "docx",
  };
}
