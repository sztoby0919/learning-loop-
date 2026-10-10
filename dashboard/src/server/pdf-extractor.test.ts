// @vitest-environment node
import { describe, expect, it } from "vitest";

import { textPdf, imageOnlyPdf, positionedPdf, nestedOutlinePdf } from "../test/pdf-fixtures.js";

import { PdfImportError, extractPdf } from "./pdf-extractor.js";

function simplePdf(text: string): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${`BT /F1 18 Tf 50 750 Td (${text}) Tj ET`.length} >>\nstream\nBT /F1 18 Tf 50 750 Td (${text}) Tj ET\nendstream`,
  ];
  let raw = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(raw));
    raw += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(raw);
  raw += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(raw, "ascii"));
}

describe("PDF text extraction", () => {
  it("finds numbered chapter headings below a running page header", async () => {
    const result = await extractPdf(positionedPdf([
      { text: "University course", x: 50, y: 780, size: 9 },
      { text: "Chapter 2 Derivatives", x: 50, y: 740, size: 18 },
      { text: "A derivative describes the rate of change.", x: 50, y: 700 },
    ]), "headers.pdf");
    expect(result.outline).toEqual([{ title: "Chapter 2 Derivatives", page: 1 }]);
  });

  it("recognizes unit, section and multilevel numbered headings", async () => {
    for (const title of ["Unit 2 Motion", "Section 3 Limits", "1.2 Derivatives"]) {
      const result = await extractPdf(textPdf([title]), "numbered.pdf");
      expect(result.outline).toEqual([{ title, page: 1 }]);
    }
  });

  it("recognizes an unnumbered prominent title without treating body text as a chapter", async () => {
    const result = await extractPdf(positionedPdf([
      { text: "University course", x: 50, y: 780, size: 9 },
      { text: "Machine Learning Basics", x: 50, y: 735, size: 24 },
      { text: "Learning systems use observations to improve predictions.", x: 50, y: 690, size: 12 },
      { text: "Examples and practice help us understand these systems.", x: 50, y: 670, size: 12 },
    ]), "slides.pdf");
    expect(result.outline).toEqual([{ title: "Machine Learning Basics", page: 1 }]);
    const body = await extractPdf(positionedPdf([
      { text: "Ordinary paragraph", x: 50, y: 750 },
      { text: "Another line of ordinary body text.", x: 50, y: 730 },
    ]), "paragraph.pdf");
    expect(body.outline).toEqual([]);
  });

  it("reads nested bookmarks even when the parent has no destination", async () => {
    const result = await extractPdf(nestedOutlinePdf(), "nested.pdf");
    expect(result.outline).toEqual([{ title: "Nested lesson", page: 1, level: 2 }]);
  });

  it("measures title typography only on its own line even when body fragments repeat title words", async () => {
    const result = await extractPdf(positionedPdf([
      { text: "Machine Learning Basics", x: 50, y: 740, size: 24 },
      { text: "Machine", x: 50, y: 690, size: 12 },
      { text: "learning uses examples to improve predictions.", x: 105, y: 690, size: 12 },
      { text: "We evaluate models on separate observations.", x: 50, y: 670, size: 12 },
    ]), "fragments.pdf");
    expect(result.outline).toEqual([{ title: "Machine Learning Basics", page: 1 }]);
  });

  it("does not let ordinary numbered instructions replace a prominent page title", async () => {
    const result = await extractPdf(positionedPdf([
      { text: "Installation Guide", x: 50, y: 740, size: 24 },
      { text: "1. Install the required development tools.", x: 50, y: 690 },
      { text: "2. Configure the application and check the output.", x: 50, y: 670 },
    ]), "instructions.pdf");
    expect(result.outline).toEqual([{ title: "Installation Guide", page: 1 }]);
  });

  it("reads lines top-to-bottom and retains paragraph gaps rather than stream order", async () => {
    const result = await extractPdf(positionedPdf([
      { text: "Second paragraph", x: 50, y: 650 },
      { text: "First line", x: 50, y: 750 },
      { text: "continued", x: 50, y: 734 },
    ]), "lines.pdf");
    expect(result.pages[0].text).toBe("First line\ncontinued\n\nSecond paragraph");
  });

  it("keeps a confident small-font side column after the body instead of interleaving it", async () => {
    const body = `Body paragraph ${"reading ".repeat(7).trim()}`;
    const result = await extractPdf(positionedPdf([
      { text: "Side note first", x: 30, y: 690, size: 8 },
      { text: "Side note second", x: 30, y: 678, size: 8 },
      { text: "Side note third", x: 30, y: 666, size: 8 },
      { text: "Chapter 1", x: 180, y: 750, size: 18 },
      { text: body, x: 180, y: 700 },
      { text: "Body continuation", x: 180, y: 684 },
    ]), "sidebar.pdf");
    expect(result.pages[0].text.indexOf("Body continuation")).toBeLessThan(result.pages[0].text.indexOf("Side note first"));
    expect(result.pages[0].text).toContain("Side note second\nSide note third");
    expect(result.warnings.join(" ")).toContain("旁注");
    expect(result.quality).toEqual({ version: 1, noTextPages: [], sideNotePages: [1], complexPages: [1] });
  });

  it("does not join widely separated cells into a fabricated Markdown table", async () => {
    const result = await extractPdf(positionedPdf([
      { text: "Actual", x: 50, y: 750 }, { text: "Predicted", x: 350, y: 750 },
      { text: "Positive", x: 50, y: 730 }, { text: "TP", x: 350, y: 730 },
      { text: "Negative", x: 50, y: 710 }, { text: "FP", x: 350, y: 710 },
    ]), "table.pdf");
    expect(result.pages[0].text).toContain("Actual Predicted\nPositive TP\nNegative FP");
    expect(result.warnings.join(" ")).toContain("表格");
    expect(result.pages[0].text).not.toContain("| ---");
  });

  it("extracts text with the source page number", async () => {
    const bytes = simplePdf("Chapter 1 Limits");
    const result = await extractPdf(bytes, "sample.pdf");
    expect(result.pageCount).toBe(1);
    expect(result.pages).toEqual([{ page: 1, text: "Chapter 1 Limits" }]);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("reports no-text physical pages without labelling them as definitely scanned", async () => {
    const result = await extractPdf(textPdf(["Chapter 1 Lesson", "", "Reading page"]), "mixed.pdf");
    expect(result.quality).toEqual({ version: 1, noTextPages: [2], sideNotePages: [], complexPages: [] });
  });

  it("rejects an image-only page instead of creating an empty course", async () => {
    await expect(extractPdf(imageOnlyPdf(), "scan.pdf")).rejects.toMatchObject({ code: "NO_TEXT" } satisfies Partial<PdfImportError>);
  });

  it("rejects non-PDF bytes", async () => {
    await expect(extractPdf(new Uint8Array(Buffer.from("not a pdf")), "fake.pdf")).rejects.toMatchObject({ code: "INVALID_PDF" } satisfies Partial<PdfImportError>);
  });

  it("explains password-protected PDFs rather than reporting generic corruption", async () => {
    await expect(extractPdf(textPdf(["Protected lesson"], true), "encrypted.pdf")).rejects.toMatchObject({ code: "ENCRYPTED", message: expect.stringContaining("密码") });
  });

  it("rejects a damaged PDF even with a valid PDF header", async () => {
    await expect(extractPdf(new Uint8Array(Buffer.from("%PDF-1.4\ncorrupt")), "damaged.pdf")).rejects.toMatchObject({ code: "INVALID_PDF" });
  });

  it("accepts 1,000 pages and preserves the last page location", async () => {
    const result = await extractPdf(textPdf(Array.from({ length: 1000 }, (_, index) => `Chapter ${index + 1} Limits and derivatives`)), "long.pdf");
    expect(result.pageCount).toBe(1000);
    expect(result.pages[999]).toEqual({ page: 1000, text: "Chapter 1000 Limits and derivatives" });
  }, 30_000);

  it("rejects 1,001 pages before extracting all page text", async () => {
    await expect(extractPdf(textPdf(Array.from({ length: 1001 }, () => "Lesson")), "too-long.pdf")).rejects.toMatchObject({ code: "TOO_MANY_PAGES" });
  }, 30_000);
});
