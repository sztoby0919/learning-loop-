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
    aiEnricher: async (_excerpt, draft) => ({ stages: draft.stages, notes: draft.notes }),
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
    await imports.confirm(pdfDraft.id);
    const textDraft = await imports.create(new TextEncoder().encode("# Text chapter\nSource text content here."), "real-source.txt");
    await imports.enrich(textDraft.id, true);
    await imports.confirm(textDraft.id);
    server = createApp(repository, events, undefined, imports).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Temporary source server has no TCP address");
    return { origin: `http://127.0.0.1:${address.port}`, pdfId: pdfDraft.courseId, textId: textDraft.courseId, cleanup };
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

test("真实受管 PDF 可经键盘打开，文本估算位置与 AI 待核对来自真实接口", async ({ page }) => {
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
    await expect(page.getByText("待核对").first()).toBeVisible();
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
