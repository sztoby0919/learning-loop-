import { describe, expect, it } from "vitest";

import { extractText, TextImportError } from "./text-extractor.js";

describe("Text/Markdown extraction", () => {
  it("extracts title from H1 heading", async () => {
    const bytes = Buffer.from("# 微积分基础\n## 第一章 极限\n内容");
    const result = await extractText(bytes, "notes.md");
    expect(result.title).toBe("微积分基础");
    expect(result.sourceFormat).toBe("text");
    expect(result.outline).toHaveLength(2);
    expect(result.outline.map((item) => item.page)).toEqual([1, 1]);
  });

  it("falls back to first line when no H1 heading", async () => {
    const bytes = Buffer.from("第一章 极限\n内容");
    const result = await extractText(bytes, "notes.txt");
    expect(result.title).toBe("第一章 极限");
  });

  it("warns when no markdown headings found", async () => {
    const bytes = Buffer.from("纯文本内容\n第二行");
    const result = await extractText(bytes, "plain.txt");
    expect(result.warnings).toContain("未检测到 Markdown 标题（# 标题），将使用全文作为学习内容。");
  });

  it("throws on empty content", async () => {
    const bytes = Buffer.from("  ");
    await expect(extractText(bytes, "empty.md")).rejects.toBeInstanceOf(TextImportError);
  });

  it("handles UTF-8 BOM", async () => {
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    const content = Buffer.from("# 标题\n内容");
    const bytes = Buffer.concat([bom, content]);
    const result = await extractText(bytes, "bom.md");
    expect(result.title).toBe("标题");
  });

  it("rejects text beyond the 1,000-section-equivalent limit", async () => {
    await expect(extractText(Buffer.from("正文".repeat(400_001)), "long.txt")).rejects.toThrow("1,000");
  });
});
