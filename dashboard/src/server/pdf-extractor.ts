import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import type { ExtractedDocument } from "./course-import.js";
import { readPdfPageText } from "./pdf-text-layout.js";
import { inferPdfHeading } from "./pdf-heading.js";

export class PdfImportError extends Error {
  constructor(readonly code: "INVALID_PDF" | "ENCRYPTED" | "NO_TEXT" | "TOO_MANY_PAGES", message: string) {
    super(message);
  }
}

export async function extractPdf(bytes: Uint8Array, filename: string): Promise<ExtractedDocument> {
  if (bytes.length < 8 || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") {
    throw new PdfImportError("INVALID_PDF", "文件不是有效 PDF");
  }
  let loadingTask: ReturnType<typeof getDocument> | undefined;
  try {
    // PDF.js may transfer/detach its input buffer; keep the caller's bytes for the source file.
    loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const document = await loadingTask.promise;
    if (document.numPages > 1000) throw new PdfImportError("TOO_MANY_PAGES", "PDF 超过 1,000 页，请拆分后导入");
    const pages: ExtractedDocument["pages"] = [];
    const inferred: ExtractedDocument["outline"] = [];
    const complexPages: number[] = [];
    const sidePages: number[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const layout = readPdfPageText(content.items, page.view[2] - page.view[0]);
      const text = layout.text;
      if (layout.complexLayout) complexPages.push(pageNumber);
      if (layout.hasSideNotes) sidePages.push(pageNumber);
      pages.push({ page: pageNumber, text });
      const title = inferPdfHeading(content.items, text);
      if (title) inferred.push({ title, page: pageNumber });
      page.cleanup();
    }
    if (pages.reduce((sum, page) => sum + page.text.length, 0) < 5) {
      throw new PdfImportError("NO_TEXT", "无法从 PDF 提取足够文字；扫描版 PDF 暂不支持，请使用可复制文字的版本");
    }
    const outline: ExtractedDocument["outline"] = [];
    const bookmarks = [...(await document.getOutline() ?? [])];
    for (let cursor = 0; cursor < bookmarks.length; cursor += 1) {
      const item = bookmarks[cursor];
      // Parent groups often have no page destination but still contain chapters.
      bookmarks.push(...item.items);
      try {
        if (!item.dest || !item.title.trim()) continue;
        const destination = typeof item.dest === "string" ? await document.getDestination(item.dest) : item.dest;
        if (!destination?.length) continue;
        const first = destination[0];
        const index = typeof first === "object" && first !== null ? await document.getPageIndex(first) : Number(first);
        if (Number.isInteger(index) && index >= 0 && index < document.numPages) outline.push({ title: item.title, page: index + 1 });
      } catch { /* A broken bookmark should not block import. */ }
    }
    const metadata = await document.getMetadata().catch(() => null);
    const infoTitle = metadata?.info && "Title" in metadata.info && typeof metadata.info.Title === "string" ? metadata.info.Title.trim() : "";
    return {
      title: infoTitle || filename.replace(/\.pdf$/i, ""),
      pageCount: document.numPages,
      pages,
      outline: outline.length ? outline : inferred,
      quality: { version: 1, noTextPages: pages.filter((page) => !page.text).map((page) => page.page), sideNotePages: sidePages, complexPages },
      warnings: [
        ...(!outline.length && inferred.length ? ["未读取到可用书签目录，章节根据页面标题推断，请对照原 PDF 核查。"] : []),
        ...(pages.some((page) => !page.text) ? ["部分页面没有可提取文字，可能是空白页、图片或扫描内容，请对照原 PDF 检查。"] : []),
        ...(sidePages.length ? [`${sidePages.length} 页识别到可能的旁注，已移至该页正文之后；请对照原页确认阅读顺序。`] : []),
        ...(complexPages.length ? [`${complexPages.length} 页可能存在分栏、表格或复杂排版，文字行顺序仅为估算，未重建表格或数学公式。`] : []),
      ],
      sourceFormat: "pdf",
    };
  } catch (error) {
    if (error instanceof PdfImportError) throw error;
    if (error instanceof Error && /password|encrypted/i.test(`${error.name} ${error.message}`)) {
      throw new PdfImportError("ENCRYPTED", "PDF 已加密或需要密码，请先提供未加密版本");
    }
    throw new PdfImportError("INVALID_PDF", "PDF 损坏或无法解析，请检查文件后重试");
  } finally {
    await loadingTask?.destroy().catch(() => {});
  }
}
