import { describe, expect, it } from "vitest";

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
  it("extracts text with the source page number", async () => {
    const bytes = simplePdf("Chapter 1 Limits");
    const result = await extractPdf(bytes, "sample.pdf");
    expect(result.pageCount).toBe(1);
    expect(result.pages).toEqual([{ page: 1, text: "Chapter 1 Limits" }]);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("rejects an image-only page instead of creating an empty course", async () => {
    await expect(extractPdf(simplePdf(""), "scan.pdf")).rejects.toMatchObject({ code: "NO_TEXT" } satisfies Partial<PdfImportError>);
  });

  it("rejects non-PDF bytes", async () => {
    await expect(extractPdf(new Uint8Array(Buffer.from("not a pdf")), "fake.pdf")).rejects.toMatchObject({ code: "INVALID_PDF" } satisfies Partial<PdfImportError>);
  });
});
