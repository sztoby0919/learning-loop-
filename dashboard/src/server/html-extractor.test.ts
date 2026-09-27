import { describe, expect, it } from "vitest";

import { extractHtml, HtmlImportError } from "./html-extractor.js";

describe("HTML extraction", () => {
  it("extracts title from h1 heading", async () => {
    const html = Buffer.from("<html><body><h1>课程标题</h1><p>内容</p></body></html>");
    const result = await extractHtml(html, "page.html");
    expect(result.title).toBe("课程标题");
    expect(result.sourceFormat).toBe("text");
  });

  it("falls back to title tag when no h1", async () => {
    const html = Buffer.from("<html><head><title>页面标题</title></head><body><p>内容</p></body></html>");
    const result = await extractHtml(html, "page.html");
    expect(result.title).toBe("页面标题");
  });

  it("extracts headings h1-h3", async () => {
    const html = Buffer.from("<h1>主标题</h1><h2>副标题</h2><h3>小节</h3>");
    const result = await extractHtml(html, "page.html");
    expect(result.outline).toHaveLength(3);
    expect(result.outline.map((item) => item.page)).toEqual([1, 1, 1]);
  });

  it("strips script and style tags", async () => {
    const html = Buffer.from("<script>alert('x')</script><style>.x{}</style><h1>标题</h1><p>正文</p>");
    const result = await extractHtml(html, "page.html");
    expect(result.pages[0].text).not.toContain("alert");
    expect(result.pages[0].text).not.toContain("script");
    expect(result.pages[0].text).toContain("正文");
  });

  it("throws on empty content", async () => {
    await expect(extractHtml(Buffer.from("  "), "empty.html")).rejects.toBeInstanceOf(HtmlImportError);
  });

  it("warns when no headings found", async () => {
    const html = Buffer.from("<p>纯文本内容</p>");
    const result = await extractHtml(html, "page.html");
    expect(result.warnings).toContain("未检测到 HTML 标题（h1-h3），将使用全文作为学习内容。");
  });

  it("rejects HTML beyond the 1,000-page-equivalent limit", async () => {
    await expect(extractHtml(Buffer.from(`<p>${"内容".repeat(400_001)}</p>`), "long.html")).rejects.toThrow("1,000");
  });
});
