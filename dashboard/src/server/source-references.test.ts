// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";
import { CourseEventBus } from "./course-events.js";
import { buildCourseFiles, createBasicDraft } from "./course-import.js";
import { CourseImportManager } from "./course-import-manager.js";
import { WorkspaceRepository } from "./workspace-repository.js";
import { positionedPdf } from "../test/pdf-fixtures.js";

const roots: string[] = [];
const managers: CourseImportManager[] = [];
afterEach(async () => {
  managers.splice(0).forEach((manager) => manager.stopScheduledCleanup());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "learning-loop-references-"));
  roots.push(root);
  const repository = new WorkspaceRepository({ configPath: path.join(root, "config.json"), courses: [] }, () => "2026-09-29");
  const events = new CourseEventBus();
  const manager = new CourseImportManager({ root, repository, events, watchCourse: () => {}, today: () => "2026-09-29" });
  managers.push(manager);
  const app = createApp(repository, events, undefined, manager);
  const importFile = async (bytes: Uint8Array, filename: string) => {
    const draft = await manager.create(bytes, filename);
    await manager.confirm(draft.id, draft.revision);
    const courseRoot = repository.config.courses.find((course) => course.id === draft.courseId)!.root;
    return { ...draft, courseRoot, url: `/api/courses/${draft.courseId}/source-references` };
  };
  return { root, repository, manager, app, importFile };
}

function pdf(pages: string[]): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pages.flatMap((text, index) => {
      const stream = `BT /F1 18 Tf 50 750 Td (${text}) Tj ET`;
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      ];
    }),
  ];
  let raw = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(raw));
    raw += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(raw);
  raw += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(raw, "ascii"));
}

async function docx() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word source material</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: "uint8array" });
}

describe("trustworthy source reference HTTP API", () => {
  it("verifies untouched source notes after partially applying AI suggestions", async () => {
    const { manager, app } = await setup();
    const draft = await manager.create(pdf(["Chapter 1 Source", "Chapter 2 Source"]), "mixed.pdf");
    manager.setAiEnricher(async (excerpt) => excerpt.stageIds.map((stageId) => ({ stageId, title: "AI chapter", tasks: ["Read"], notes: [{ title: "AI note", page: 1, content: "Chapter 1 Source" }] })));
    const excerpt = await manager.aiExcerpt(draft.id, { expectedRevision: 0, stageIds: [draft.draft.stages[0].id!] });
    const operation = await manager.startAi(draft.id, { consent: true, expectedRevision: 0, stageIds: excerpt.stageIds, excerptHash: excerpt.excerptHash });
    await vi.waitFor(async () => expect((await manager.getAi(draft.id, operation.id)).status).toBe("complete"), { timeout: 5000 });
    const preview = await manager.preview(draft.id);
    const applied = await manager.applyAi(draft.id, preview.candidate!.id, { expectedRevision: 0, acceptedStageIds: excerpt.stageIds });
    await manager.confirm(draft.id, applied.revision);
    const response = await request(app).get(`/api/courses/${draft.courseId}/source-references`).expect(200);
    expect(response.body.filter((item: { heading: string }) => item.heading === "Chapter 2 Source")).toEqual(expect.arrayContaining([expect.objectContaining({ aiDerived: false, verifiedExcerpt: "Chapter 2 Source" })]));
    expect(response.body.filter((item: { heading: string }) => item.heading === "AI note")).toEqual(expect.arrayContaining([expect.objectContaining({ aiDerived: true, verifiedExcerpt: null })]));
  });
  it("verifies safely fenced multiline PDF excerpts using the same reading order as import", async () => {
    const { app, importFile } = await setup();
    const course = await importFile(positionedPdf([
      { text: "Second paragraph", x: 50, y: 650 },
      { text: "Chapter 1 Reading", x: 50, y: 750 },
      { text: "continued", x: 50, y: 734 },
    ]), "reading.pdf");
    const response = await request(app).get(course.url).expect(200);
    expect(response.body).toHaveLength(2);
    for (const item of response.body) expect(item).toMatchObject({ heading: "Chapter 1 Reading", position: 1, verifiedExcerpt: "Chapter 1 Reading continued Second paragraph" });
    expect(await readFile(path.join(course.courseRoot, "notes.md"), "utf8")).toContain("Chapter 1 Reading\ncontinued\n\nSecond paragraph");
  });

  it("still verifies legacy PDF stream-order excerpts after reading-order optimization", async () => {
    const { app, importFile } = await setup();
    const course = await importFile(positionedPdf([
      { text: "Second paragraph", x: 50, y: 650 },
      { text: "Chapter 1 Reading", x: 50, y: 750 },
    ]), "legacy.pdf");
    await writeFile(path.join(course.courseRoot, "notes.md"), `---\ncourseId: ${course.courseId}\naiStatus: not-used\nsourceExcerptEncoding: escaped-line-v1\n---\n## Legacy\n\n来源：原 PDF 第 1 页。\n\nSecond paragraph Chapter 1 Reading\n`);
    const response = await request(app).get(course.url).expect(200);
    expect(response.body.find((item: { artifact: string }) => item.artifact === "notes").verifiedExcerpt).toBe("Second paragraph Chapter 1 Reading");
  });

  it("does not verify fabricated text crossing two possible PDF reading orders", async () => {
    const { app, importFile } = await setup();
    const course = await importFile(positionedPdf([
      { text: "Second paragraph", x: 50, y: 650 },
      { text: "Chapter 1 Reading", x: 50, y: 750 },
    ]), "mixed.pdf");
    await writeFile(path.join(course.courseRoot, "notes.md"), `---\ncourseId: ${course.courseId}\naiStatus: not-used\nsourceExcerptEncoding: fenced-text-v2\n---\n## Changed\n\n来源：原 PDF 第 1 页。\n\n\`\`\`text\nSecond paragraph Second paragraph\n\`\`\`\n`);
    const response = await request(app).get(course.url).expect(200);
    expect(response.body.find((item: { artifact: string }) => item.artifact === "notes").verifiedExcerpt).toBeNull();
  });

  it("does not decode an arbitrary paragraph labeled as a fenced PDF excerpt", async () => {
    const { app, importFile } = await setup();
    const course = await importFile(pdf(["Chapter 1 Reading"]), "unfenced.pdf");
    await writeFile(path.join(course.courseRoot, "notes.md"), `---\ncourseId: ${course.courseId}\naiStatus: not-used\nsourceExcerptEncoding: fenced-text-v2\n---\n## Changed\n\n来源：原 PDF 第 1 页。\n\nChapter 1 Reading\n`);
    const response = await request(app).get(course.url).expect(200);
    expect(response.body.find((item: { artifact: string }) => item.artifact === "notes").verifiedExcerpt).toBeNull();
  });

  it("links the actual PDF page and verifies only the text on that page", async () => {
    const { app, importFile } = await setup();
    const course = await importFile(pdf(["Chapter 1 Limits", "Chapter 2 Derivatives"]), "course.pdf");
    const response = await request(app).get(course.url).expect(200);
    expect(response.body).toEqual([
      { artifact: "course", headingIndex: 0, heading: "Chapter 1 Limits", kind: "pdf-page", position: 1, sourceUrl: `/api/courses/${course.courseId}/source#page=1`, verifiedExcerpt: "Chapter 1 Limits", aiDerived: false },
      { artifact: "course", headingIndex: 1, heading: "Chapter 2 Derivatives", kind: "pdf-page", position: 2, sourceUrl: `/api/courses/${course.courseId}/source#page=2`, verifiedExcerpt: "Chapter 2 Derivatives", aiDerived: false },
      { artifact: "notes", headingIndex: 0, heading: "Chapter 1 Limits", kind: "pdf-page", position: 1, sourceUrl: `/api/courses/${course.courseId}/source#page=1`, verifiedExcerpt: "Chapter 1 Limits", aiDerived: false },
      { artifact: "notes", headingIndex: 1, heading: "Chapter 2 Derivatives", kind: "pdf-page", position: 2, sourceUrl: `/api/courses/${course.courseId}/source#page=2`, verifiedExcerpt: "Chapter 2 Derivatives", aiDerived: false },
    ]);
  });

  it.each(["txt", "md", "markdown", "html", "htm", "docx"])("labels %s positions as virtual without a PDF page anchor", async (extension) => {
    const { app, importFile } = await setup();
    const bytes = extension === "docx" ? await docx() : Buffer.from(/html|htm/.test(extension) ? "<h1>Source heading</h1><p>Text content here.</p>" : "Source text content here.");
    const course = await importFile(bytes, `course.${extension}`);
    const response = await request(app).get(course.url).expect(200);
    expect(response.body).toHaveLength(2);
    for (const reference of response.body) {
      expect(reference).toMatchObject({ kind: "virtual-position", position: 1, sourceUrl: `/api/courses/${course.courseId}/source`, aiDerived: false });
      expect(reference.verifiedExcerpt).toContain(extension === "docx" ? "Word source material" : /html|htm/.test(extension) ? "Text content here." : "Source text content here.");
    }
    const opened = await request(app).get(`/api/courses/${course.courseId}/source`).expect(200);
    expect(opened.headers["x-content-type-options"]).toBe("nosniff");
    if (/html|htm/.test(extension)) expect(opened.headers["content-security-policy"]).toBe("sandbox");
    if (extension === "docx") expect(await readFile(path.join(course.courseRoot, "notes.md"), "utf8")).toContain("第 1 段文本（估算位置）");
  });

  it("keeps old Word page markers virtual and old provenance unverified", async () => {
    const { app, importFile } = await setup();
    const course = await importFile(await docx(), "course.docx");
    await writeFile(path.join(course.courseRoot, "notes.md"), "---\ncourseId: " + course.courseId + "\n---\n## Legacy\n\n来源：原 Word 文档 第 1 页。\n\nWord source material\n");
    const response = await request(app).get(course.url).expect(200);
    expect(response.body.find((reference: { artifact: string }) => reference.artifact === "notes")).toMatchObject({ kind: "virtual-position", aiDerived: true, verifiedExcerpt: null });
  });

  it("never verifies AI-derived text even when it exactly matches the source", async () => {
    const { app, manager } = await setup();
    manager.setAiEnricher(async (excerpt) => excerpt.stageIds.map((stageId) => ({ stageId, title: "AI stage", tasks: ["Read"], notes: [{ title: "AI note", page: 1, content: "Source text content here." }] })));
    const draft = await manager.create(Buffer.from("# Source chapter\nSource text content here."), "course.txt");
    const excerpt = await manager.aiExcerpt(draft.id, { expectedRevision: 0, stageIds: [draft.draft.stages[0].id!] });
    const operation = await manager.startAi(draft.id, { consent: true, expectedRevision: 0, stageIds: excerpt.stageIds, excerptHash: excerpt.excerptHash });
    await vi.waitFor(async () => expect((await manager.getAi(draft.id, operation.id)).status).toBe("complete"));
    const preview = await manager.preview(draft.id);
    await manager.applyAi(draft.id, preview.candidate!.id, { expectedRevision: 0, acceptedStageIds: excerpt.stageIds });
    await manager.confirm(draft.id, (await manager.preview(draft.id)).revision);
    const response = await request(app).get(`/api/courses/${draft.courseId}/source-references`).expect(200);
    expect(response.body).toHaveLength(2);
    for (const reference of response.body) expect(reference).toMatchObject({ aiDerived: true, verifiedExcerpt: null });
  });

  it.each(["failed", "missing"])("treats %s provenance as unverified even for matching source text", async (status) => {
    const { app, importFile } = await setup();
    const course = await importFile(Buffer.from("Source text content here."), "course.txt");
    for (const artifact of ["course.md", "notes.md"]) {
      const file = path.join(course.courseRoot, artifact);
      await writeFile(file, (await readFile(file, "utf8")).replace(/^sourceNoteProvenance:.*\n/m, "").replace("aiStatus: not-used\n", status === "missing" ? "" : "aiStatus: failed\n"));
    }
    const response = await request(app).get(course.url).expect(200);
    expect(response.body).toHaveLength(2);
    for (const reference of response.body) expect(reference).toMatchObject({ aiDerived: true, verifiedExcerpt: null });
  });

  it("does not let forged source metadata verify text absent from the physical page", async () => {
    const { app, importFile } = await setup();
    const course = await importFile(pdf(["Chapter 1 Original"]), "forged.pdf");
    const filename = path.join(course.courseRoot, "notes.md");
    const original = await readFile(filename, "utf8");
    await writeFile(filename, original.replace("\nChapter 1 Original\n```", "\nInvented knowledge\n```"));
    const response = await request(app).get(course.url).expect(200);
    expect(response.body.find((item: { artifact: string }) => item.artifact === "notes")).toMatchObject({ aiDerived: false, verifiedExcerpt: null });
  });

  it("does not verify text found only on a different PDF page or expose an out-of-range page", async () => {
    const { app, importFile } = await setup();
    const course = await importFile(pdf(["Chapter 1 Limits", "Chapter 2 Derivatives"]), "course.pdf");
    const file = path.join(course.courseRoot, "notes.md");
    await writeFile(file, `---\ncourseId: ${course.courseId}\naiStatus: not-used\n---\n## Wrong page\n\n来源：原 PDF 第 1 页。\n\nChapter 2 Derivatives\n\n## Out of range\n\n来源：原 PDF 第 3 页。\n\nChapter 1 Limits\n`);
    const response = await request(app).get(course.url).expect(200);
    expect(response.body.filter((reference: { artifact: string }) => reference.artifact === "notes")).toEqual([
      { artifact: "notes", headingIndex: 0, heading: "Wrong page", position: 1, kind: "pdf-page", sourceUrl: `/api/courses/${course.courseId}/source#page=1`, aiDerived: false, verifiedExcerpt: null },
    ]);
  });

  it("verifies raw Markdown text without treating its heading characters as prose", async () => {
    const { app, importFile } = await setup();
    const course = await importFile(Buffer.from("# Title\n## Topic\nSource content"), "course.md");
    const response = await request(app).get(course.url).expect(200);
    expect(response.body).toHaveLength(4);
    for (const reference of response.body) expect(reference.verifiedExcerpt).toBe("# Title ## Topic Source content");
  });

  it.each(["##", "###"])("preserves an imported %s heading as source text, not generated structure", async (prefix) => {
    const { app, repository, importFile } = await setup();
    const course = await importFile(Buffer.from(`${prefix} Topic\nSource content here.`), "course.md");
    expect((await repository.getNotes())[0].headings).toEqual(["Topic"]);
    const response = await request(app).get(course.url).expect(200);
    expect(response.body).toHaveLength(2);
    for (const reference of response.body) expect(reference).toMatchObject({ heading: "Topic", headingIndex: 0, verifiedExcerpt: `${prefix} Topic Source content here.` });
  });

  it("keeps several Markdown knowledge points and verifies virtual position 2 independently", async () => {
    const { app, repository, importFile } = await setup();
    // 9 heading characters + 790 body characters + newline = one 800-char position.
    const source = `## First\n${"a".repeat(790)}\n### Second\nSecond position source.`;
    const course = await importFile(Buffer.from(source), "course.md");
    expect((await repository.getNotes())[0].headings).toEqual(["First", "Second"]);
    const response = await request(app).get(course.url).expect(200);
    expect(response.body).toHaveLength(4);
    for (const artifact of ["course", "notes"]) {
      expect(response.body.filter((reference: { artifact: string }) => reference.artifact === artifact)).toMatchObject([
        { heading: "First", headingIndex: 0, kind: "virtual-position", position: 1, verifiedExcerpt: `## First ${"a".repeat(491)}` },
        { heading: "Second", headingIndex: 1, kind: "virtual-position", position: 2, verifiedExcerpt: "### Second Second position source." },
      ]);
    }
    const notesPath = path.join(course.courseRoot, "notes.md");
    await writeFile(notesPath, (await readFile(notesPath, "utf8")).replace("第 2 段文本", "第 1 段文本"));
    const wrongPosition = await request(app).get(course.url).expect(200);
    expect(wrongPosition.body.find((reference: { artifact: string; heading: string }) => reference.artifact === "notes" && reference.heading === "Second").verifiedExcerpt).toBeNull();
  });

  it.each(["\\# Literal", "\\\\# Literal", "## Topic with \\literal"])("round-trips existing source backslashes: %s", async (firstLine) => {
    const { app, importFile } = await setup();
    const course = await importFile(Buffer.from(`${firstLine}\nSource content here.`), "course.md");
    const response = await request(app).get(course.url).expect(200);
    expect(response.body).toHaveLength(2);
    for (const reference of response.body) expect(reference.verifiedExcerpt).toBe(`${firstLine} Source content here.`);
  });

  it("does not decode legacy escaped text without explicit excerpt encoding metadata", async () => {
    const { app, importFile } = await setup();
    const course = await importFile(Buffer.from("## Topic\nSource content here."), "course.md");
    await writeFile(path.join(course.courseRoot, "notes.md"), `---\ncourseId: ${course.courseId}\naiStatus: not-used\n---\n## Topic\n\n来源：原 文本文件 第 1 段文本。\n\n\\## Topic Source content here.\n`);
    const response = await request(app).get(course.url).expect(200);
    expect(response.body.find((reference: { artifact: string }) => reference.artifact === "notes").verifiedExcerpt).toBeNull();
  });

  it("does not verify changed note text or a matching prefix with an invented suffix", async () => {
    const { app, importFile } = await setup();
    const source = "a".repeat(600);
    const course = await importFile(Buffer.from(source), "course.txt");
    const notesPath = path.join(course.courseRoot, "notes.md");
    const raw = await readFile(notesPath, "utf8");
    await writeFile(notesPath, raw.replace("a".repeat(500), `${"a".repeat(500)} Invented conclusion`));
    const response = await request(app).get(course.url).expect(200);
    expect(response.body.find((reference: { artifact: string }) => reference.artifact === "course").verifiedExcerpt).toHaveLength(500);
    expect(response.body.find((reference: { artifact: string }) => reference.artifact === "notes").verifiedExcerpt).toBeNull();
  });

  it("retains heading indexes but ignores arbitrary links, code markers and invalid positions", async () => {
    const { app, importFile } = await setup();
    const course = await importFile(Buffer.from("Source text content here."), "course.txt");
    await writeFile(path.join(course.courseRoot, "notes.md"), `---\ncourseId: ${course.courseId}\naiStatus: not-used\n---\n# Notes\n\n## Manual\n\n[来源](file:///outside.txt)\n\n## Code example\n\n\`\`\`md\n来源：原 文本文件 第 1 段文本。\n\`\`\`\n\n## Zero\n\n来源：原 文本文件 第 0 段文本。\n\n## Negative\n\n来源：原 文本文件 第 -1 段文本。\n\n## Out of range\n\n来源：原 文本文件 第 2 段文本。\n\n## Mismatched type\n\n来源：原 PDF 第 1 页。\n\n## Valid\n\n来源：原 文本文件 第 1 段文本。\n\nSource text\ncontent here.\n`);
    const response = await request(app).get(course.url).expect(200);
    expect(response.body.filter((reference: { artifact: string }) => reference.artifact === "notes")).toEqual([
      { artifact: "notes", headingIndex: 6, heading: "Valid", kind: "virtual-position", position: 1, sourceUrl: `/api/courses/${course.courseId}/source`, verifiedExcerpt: "Source text content here.", aiDerived: false },
    ]);
  });

  it("returns no references for a manual course without a source and 404 for an unknown course", async () => {
    const { app, repository, root } = await setup();
    const courseRoot = path.join(root, "learning-journal", "manual");
    await mkdir(courseRoot, { recursive: true });
    repository.config.courses.push({ id: "manual", root: courseRoot, enabled: true });
    expect((await request(app).get("/api/courses/manual/source-references").expect(200)).body).toEqual([]);
    await request(app).get("/api/courses/unknown/source-references").expect(404);
  });

  it("does not read a registered source outside the managed courses directory", async () => {
    const { app, repository, root } = await setup();
    const outside = path.join(root, "private");
    await mkdir(outside);
    await writeFile(path.join(outside, "source.txt"), "Secret source content");
    repository.config.courses.push({ id: "outside", root: outside, enabled: true });
    expect((await request(app).get("/api/courses/outside/source-references").expect(200)).body).toEqual([]);
    await request(app).get("/api/courses/outside/source").expect(404);
  });

  it("blocks a managed course junction escaping to a private directory for both routes", async () => {
    const { app, repository, root } = await setup();
    const outside = path.join(root, "private");
    const courseRoot = path.join(root, "learning-journal", "linked");
    await mkdir(outside);
    await mkdir(path.dirname(courseRoot));
    await writeFile(path.join(outside, "source.txt"), "Secret source content");
    await symlink(outside, courseRoot, "junction");
    repository.config.courses.push({ id: "linked", root: courseRoot, enabled: true });
    expect((await request(app).get("/api/courses/linked/source-references").expect(200)).body).toEqual([]);
    await request(app).get("/api/courses/linked/source").expect(404);
  });

  it("does not serve another managed course through a course-directory junction", async () => {
    const { app, repository, root, importFile } = await setup();
    const other = await importFile(Buffer.from("Other course original content"), "other.txt");
    const alias = path.join(root, "learning-journal", "alias");
    await symlink(other.courseRoot, alias, "junction");
    repository.config.courses.push({ id: "alias", root: alias, enabled: true });
    await request(app).get("/api/courses/alias/source").expect(404);
    expect((await request(app).get("/api/courses/alias/source-references").expect(200)).body).toEqual([]);
  });

  it("rejects a directory named source.txt instead of treating it as a source file", async () => {
    const { app, repository, root } = await setup();
    const courseRoot = path.join(root, "learning-journal", "directory");
    await mkdir(path.join(courseRoot, "source.txt"), { recursive: true });
    repository.config.courses.push({ id: "directory", root: courseRoot, enabled: true });
    expect((await request(app).get("/api/courses/directory/source-references").expect(200)).body).toEqual([]);
    await request(app).get("/api/courses/directory/source").expect(404);
  });

  it("rejects a source-file symlink pointing outside the course", async ({ skip }) => {
    const { app, importFile, root } = await setup();
    const course = await importFile(Buffer.from("Source text content here."), "course.txt");
    const external = path.join(root, "secret.txt");
    await writeFile(external, "Secret source content");
    const source = path.join(course.courseRoot, "source.txt");
    await rm(source);
    await symlink(external, source, "file").catch((error: NodeJS.ErrnoException) => {
      if (process.platform === "win32" && error.code === "EPERM") skip("Windows does not grant file-symlink privileges");
      throw error;
    });
    expect((await request(app).get(course.url).expect(200)).body).toEqual([]);
    await request(app).get(`/api/courses/${course.courseId}/source`).expect(404);
  });

  it("does not read provenance or markers through an artifact symlink", async ({ skip }) => {
    const { app, importFile, root } = await setup();
    const course = await importFile(Buffer.from("Source text content here."), "course.txt");
    const external = path.join(root, "external-notes.md");
    const notes = path.join(course.courseRoot, "notes.md");
    await writeFile(external, await readFile(notes));
    await rm(notes);
    await symlink(external, notes, "file").catch((error: NodeJS.ErrnoException) => {
      if (process.platform === "win32" && error.code === "EPERM") skip("Windows does not grant file-symlink privileges");
      throw error;
    });
    const response = await request(app).get(course.url).expect(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].artifact).toBe("course");
  });

  it("degrades safely when a previously imported source can no longer be parsed", async () => {
    const { app, importFile } = await setup();
    const course = await importFile(pdf(["Chapter 1 Limits"]), "course.pdf");
    await writeFile(path.join(course.courseRoot, "source.pdf"), "broken");
    expect((await request(app).get(course.url).expect(200)).body).toEqual([]);
  });
});

describe("generated source provenance", () => {
  it.each(["not-used", "complete", "failed"] as const)("persists %s provenance in both artifacts", (aiStatus) => {
    const draft = createBasicDraft({ title: "Word course", pageCount: 1, pages: [{ page: 1, text: "Source text" }], outline: [], warnings: [], sourceFormat: "docx" }, "course.docx");
    const files = buildCourseFiles({ ...draft, aiStatus }, "course-test", "2026-09-29");
    for (const artifact of ["course.md", "notes.md"] as const) {
      expect(files[artifact].split("---")[1]).toContain(`aiStatus: ${aiStatus}`);
      expect(files[artifact]).not.toMatch(/第 1 页/);
      expect(files[artifact]).toContain("第 1 段文本（估算位置）");
    }
  });
});
