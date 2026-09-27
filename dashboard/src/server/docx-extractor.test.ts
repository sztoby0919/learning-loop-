import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import { DocxImportError, extractDocx } from "./docx-extractor.js";

describe("DOCX validation", () => {
  it("extracts headings and body text from a real OOXML Word document", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>微积分基础</w:t></w:r></w:p><w:p><w:r><w:t>极限与导数的课程内容</w:t></w:r></w:p></w:body></w:document>`);
    const result = await extractDocx(await zip.generateAsync({ type: "uint8array" }), "course.docx");
    expect(result.title).toBe("微积分基础");
    expect(result.outline[0]).toMatchObject({ title: "微积分基础", page: 1 });
    expect(result.pages[0].text).toContain("极限与导数的课程内容");
  });
  it("rejects non-docx files (no PK magic bytes)", async () => {
    await expect(extractDocx(new Uint8Array(Buffer.from("not a docx")), "fake.docx")).rejects.toMatchObject({ code: "INVALID_DOCX" } satisfies Partial<DocxImportError>);
  });

  it("rejects files that are too short", async () => {
    await expect(extractDocx(new Uint8Array([0x50]), "tiny.docx")).rejects.toMatchObject({ code: "INVALID_DOCX" });
  });

  it("rejects files with PK bytes but invalid content", async () => {
    // A file that starts with PK (ZIP magic) but is not a valid .docx
    const fakeZip = new Uint8Array([
      0x50, 0x4B, 0x03, 0x04, // local file header signature
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    await expect(extractDocx(fakeZip, "fake.docx")).rejects.toMatchObject({ code: "INVALID_DOCX" });
  });
});
