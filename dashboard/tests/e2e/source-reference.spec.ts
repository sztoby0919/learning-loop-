import { once } from "node:events";
import { rm, mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { createApp } from "../../src/server/app.js";
import { CourseEventBus } from "../../src/server/course-events.js";
import { CourseImportManager } from "../../src/server/course-import-manager.js";
import { WorkspaceRepository } from "../../src/server/workspace-repository.js";
import { positionedPdf } from "../../src/test/pdf-fixtures.js";

function textPdf(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 50 750 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
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

async function managedSourceServer() {
  const root = await mkdtemp(path.join(tmpdir(), "learning-loop-source-e2e-"));
  const today = () => "2026-09-29";
  const repository = new WorkspaceRepository({ configPath: path.join(root, "config.json"), courses: [] }, today);
  const events = new CourseEventBus();
  const imports = new CourseImportManager({
    root, repository, events, watchCourse: () => {}, today,
    aiEnricher: async (excerpt, draft) => excerpt.stageIds.map((stageId) => { const stage = draft.stages.find((stage) => stage.id === stageId)!; return { stageId, title: stage.title, tasks: stage.tasks, notes: draft.notes.filter((note) => note.stageId === stageId).map((note) => ({ ...note, provenance: "ai" as const })) }; }),
  });
  let server: Server | undefined;
  const cleanup = async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    imports.stopScheduledCleanup();
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("learning-loop-source-e2e-")) {
      throw new Error("Refusing to remove an unexpected test directory");
    }
    await rm(resolved, { recursive: true, force: true });
  };

  try {
    const pdfDraft = await imports.create(textPdf("Chapter 1 Limits"), "real-source.pdf");
    await imports.confirm(pdfDraft.id, pdfDraft.revision);
    const textDraft = await imports.create(new TextEncoder().encode("# Text chapter\nSource text content here."), "real-source.txt");
    const excerpt = await imports.aiExcerpt(textDraft.id, { expectedRevision: textDraft.revision, stageIds: [textDraft.draft.stages[0].id!] });
    const operation = await imports.startAi(textDraft.id, { consent: true, expectedRevision: excerpt.revision, stageIds: excerpt.stageIds, excerptHash: excerpt.excerptHash });
    await expect.poll(async () => (await imports.getAi(textDraft.id, operation.id)).status).toBe("complete");
    const candidate = (await imports.preview(textDraft.id)).candidate!;
    await imports.applyAi(textDraft.id, candidate.id, { expectedRevision: candidate.baseRevision, acceptedStageIds: excerpt.stageIds });
    await imports.confirm(textDraft.id, (await imports.preview(textDraft.id)).revision);
    const layoutDraft = await imports.create(positionedPdf([
      { text: "Second paragraph", x: 50, y: 650 },
      { text: "Chapter 1 Layout", x: 50, y: 750 },
      { text: "x_i = y^2 + ?", x: 50, y: 700 },
    ]), "layout-source.pdf");
    await imports.confirm(layoutDraft.id, layoutDraft.revision);
    server = createApp(repository, events, undefined, imports).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Temporary source server has no TCP address");
    return { origin: `http://127.0.0.1:${address.port}`, pdfId: pdfDraft.courseId, textId: textDraft.courseId, layoutId: layoutDraft.courseId, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

test("手工课程的真实空引用响应不显示失效来源入口", async ({ page }) => {
  await page.goto("/notes/calculus-101");
  await expect(page.getByRole("heading", { name: "极限与连续", level: 2 })).toBeVisible();
  await expect(page.getByRole("link", { name: /打开原文件/ })).toHaveCount(0);
});

test("PDF 多行摘录保留为纯文本并可打开原页，不把损坏公式渲染为数学结果", async ({ page }) => {
  const fixture = await managedSourceServer();
  try {
    await page.goto(`${fixture.origin}/notes/${fixture.layoutId}`);
    const excerpt = page.locator(".markdown-content pre code").first();
    await expect(excerpt).toHaveText(/^Chapter 1 Layout\n\nx_i = y\^2 \+ \?\n\nSecond paragraph\n$/);
    await expect(page.locator(".katex")).toHaveCount(0);
    await expect(page.getByText("待核对")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "打开原文件：Chapter 1 Layout" })).toHaveAttribute("href", `/api/courses/${fixture.layoutId}/source#page=1`);
    const response = await page.request.get(`${fixture.origin}/api/courses/${fixture.layoutId}/source-references`);
    expect((await response.json()).find((item: { artifact: string }) => item.artifact === "notes")).toMatchObject({ verifiedExcerpt: "Chapter 1 Layout x_i = y^2 + ? Second paragraph" });
    await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  } finally { await fixture.cleanup(); }
});

test("真实受管 PDF 可经键盘打开，AI 来源不显示待核对标识", async ({ page }) => {
  const fixture = await managedSourceServer();
  try {
    const pdfReferences = await page.request.get(`${fixture.origin}/api/courses/${fixture.pdfId}/source-references`);
    expect(pdfReferences.status()).toBe(200);
    expect(await pdfReferences.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifact: "course", kind: "pdf-page", position: 1, verifiedExcerpt: "Chapter 1 Limits", aiDerived: false }),
    ]));

    await page.goto(`${fixture.origin}/courses/${fixture.pdfId}`);
    await expect(page.locator(".source-reference").getByText("原 PDF 第 1 页", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("原文摘录：Chapter 1 Limits")).toBeVisible();
    const pdfLink = page.getByRole("link", { name: "打开原文件：Chapter 1 Limits" });
    await expect(pdfLink).toHaveAttribute("href", `/api/courses/${fixture.pdfId}/source#page=1`);
    await pdfLink.focus();
    await expect(pdfLink).toBeFocused();

    const sourcePath = `/api/courses/${fixture.pdfId}/source`;
    const responsePromise = page.context().waitForEvent("response", (response) => new URL(response.url()).pathname === sourcePath);
    const popupPromise = page.waitForEvent("popup");
    await page.keyboard.press("Enter");
    const [popup, response] = await Promise.all([popupPromise, responsePromise]);
    await expect(popup).toHaveURL(new RegExp(`${sourcePath}#page=1$`));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/pdf");
    // Chromium's built-in PDF viewer can replace the navigation response body with its HTML wrapper.
    const sourceBytes = await page.request.get(`${fixture.origin}${sourcePath}`);
    expect(sourceBytes.status()).toBe(200);
    expect(Buffer.from(await sourceBytes.body()).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    await popup.close();

    await page.goto(`${fixture.origin}/notes/${fixture.textId}`);
    await expect(page.locator(".source-reference").getByText("第 1 段文本（估算位置）", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("待核对")).toHaveCount(0);
    await expect(page.getByText(/原文摘录/)).toHaveCount(0);
    const textLink = page.getByRole("link", { name: /打开原文件/ }).first();
    await expect(textLink).toHaveAttribute("href", `/api/courses/${fixture.textId}/source`);
    const textResponsePromise = page.context().waitForEvent("response", (response) => new URL(response.url()).pathname === `/api/courses/${fixture.textId}/source`);
    const textPopupPromise = page.waitForEvent("popup");
    await textLink.click();
    const [textPopup, textResponse] = await Promise.all([textPopupPromise, textResponsePromise]);
    expect(textResponse.status()).toBe(200);
    expect(textResponse.headers()["content-type"]).toContain("text/plain");
    expect((await textResponse.text())).toContain("Source text content here.");
    await textPopup.close();
  } finally {
    await page.goto("about:blank").catch(() => {});
    await fixture.cleanup();
  }
});
