import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createApp } from "../../src/server/app.js";
import { createCourseImportAi } from "../../src/server/course-import-ai.js";
import { CourseEventBus } from "../../src/server/course-events.js";
import { CourseImportManager } from "../../src/server/course-import-manager.js";
import { WorkspaceRepository } from "../../src/server/workspace-repository.js";
import { textPdf } from "../../src/test/pdf-fixtures.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "learning-loop-ai-e2e-"));
  const today = () => "2026-10-02";
  const repository = new WorkspaceRepository({ configPath: path.join(root, "config.json"), courses: [] }, today);
  const events = new CourseEventBus();
  const requests: Array<{ text: string; signal: AbortSignal }> = [];
  let release: (() => void) | undefined;
  // Exercises the real Chat Completions adapter while replacing only its upstream fetch.
  // It deliberately ignores abort to prove late upstream responses cannot publish candidates.
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    const text = JSON.parse(String(init.body)).messages[1].content as string;
    requests.push({ text, signal: init.signal! });
    if (text.includes("学习目标：等待取消")) await new Promise<void>((resolve) => { release = resolve; });
    const suggestions = [...text.matchAll(/^([a-f0-9-]{36}): (.+?)（来源：/gm)].map((match) => {
      const pageMatch = new RegExp(`\\[章节 ${match[1]}\\]\\n\\[第 (\\d+) 页\\]`).exec(text);
      return { stageId: match[1], title: `AI ${match[2]}`, tasks: [`核对 ${match[2]} 的来源`], notes: [{ title: `AI ${match[2]} 笔记`, page: Number(pageMatch![1]), content: "仅依据发送摘录的建议" }] };
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions }) } }] }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const imports = new CourseImportManager({ root, repository, events, today, watchCourse: () => {}, aiEnricher: createCourseImportAi({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only", model: "fixture", temperature: 0.2, maxTokens: 4000 }, fetcher) });
  await imports.initialize();
  const server = createApp(repository, events, undefined, imports).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test address");
  return { origin: `http://127.0.0.1:${address.port}`, requests, release: () => release?.(), cleanup: async () => {
    release?.(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); imports.stopScheduledCleanup();
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("learning-loop-ai-e2e-")) throw new Error("Unsafe cleanup");
    await rm(resolved, { recursive: true, force: true });
  } };
}

test("AI 只发送选择章节，候选刷新保留，部分应用及撤销不额外调用模型", async ({ page }) => {
  const service = await fixture();
  try {
    await page.goto(`${service.origin}/courses/import`);
    await page.getByLabel("选择文件").setInputFiles({ name: "chapters.pdf", mimeType: "application/pdf", buffer: Buffer.from(textPdf(["Chapter 1 Source", "Chapter 2 Source"])) });
    await expect(page.getByLabel("阶段 1", { exact: true })).toHaveValue("Chapter 1 Source");
    await page.getByLabel("完善 Chapter 2 Source").uncheck();
    await page.getByRole("button", { name: "查看将发送的摘录" }).click();
    await expect(page.getByLabel(/同意发送/)).toBeVisible();
    expect(service.requests).toHaveLength(0);
    await page.getByLabel(/同意发送/).check();
    await page.getByRole("button", { name: "AI 完善草稿" }).click();
    await expect(page.getByRole("heading", { name: "比较候选建议" })).toBeVisible();
    expect(service.requests).toHaveLength(1);
    expect(service.requests[0].text).toContain("Chapter 1 Source");
    expect(service.requests[0].text).not.toContain("Chapter 2 Source");
    await expect(page.getByLabel("阶段 1", { exact: true })).toHaveValue("Chapter 1 Source");
    await page.reload();
    await expect(page.getByRole("heading", { name: "比较候选建议" })).toBeVisible();
    await page.getByLabel("接受 Chapter 1 Source 的建议").check();
    await page.getByRole("button", { name: "应用所选建议" }).click();
    await expect(page.getByLabel("阶段 1", { exact: true })).toHaveValue("AI Chapter 1 Source");
    await expect(page.getByLabel("阶段 2", { exact: true })).toHaveValue("Chapter 2 Source");
    await page.reload();
    await page.getByRole("button", { name: "撤销最近一次 AI 应用" }).click();
    await expect(page.getByLabel("阶段 1", { exact: true })).toHaveValue("Chapter 1 Source");
    expect(service.requests).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await service.cleanup(); }
});

test("AI 等待可刷新恢复，不重发请求，取消后迟到结果不能保存", async ({ page }) => {
  const service = await fixture();
  try {
    await page.goto(`${service.origin}/courses/import`);
    await page.getByLabel("选择文件").setInputFiles({ name: "waiting.pdf", mimeType: "application/pdf", buffer: Buffer.from(textPdf(["Chapter 1 Source", "Chapter 2 Source"])) });
    await expect(page.getByLabel("课程名称")).toBeVisible();
    await page.getByLabel("学习目标").fill("等待取消");
    await page.getByRole("button", { name: "查看将发送的摘录" }).click();
    await page.getByLabel(/同意发送/).check();
    await page.getByRole("button", { name: "AI 完善草稿" }).click();
    await expect(page.getByRole("status", { name: "AI 正在完善草稿" })).toContainText("已等待");
    await expect(page.getByLabel("课程名称")).toBeDisabled();
    await page.reload();
    await expect(page.getByRole("button", { name: "取消 AI 请求" })).toBeEnabled();
    expect(service.requests).toHaveLength(1);
    await page.getByRole("button", { name: "取消 AI 请求" }).click();
    await expect(page.getByText("模型请求已取消；不保证上游停止计费", { exact: true })).toBeVisible();
    expect(service.requests[0].signal.aborted).toBe(true);
    service.release();
    const draftId = new URL(page.url()).searchParams.get("draft")!;
    await expect.poll(async () => (await (await page.request.get(`${service.origin}/api/course-imports/${draftId}`)).json()).operation.status).toBe("cancelled");
    const current = await (await page.request.get(`${service.origin}/api/course-imports/${draftId}`)).json();
    expect(current.candidate).toBeUndefined(); expect(current.draft.aiStatus).toBe("not-used");
    await expect(page.getByLabel("学习目标")).toHaveValue("等待取消");
    await expect(page.getByLabel("课程名称")).toBeEnabled();
    expect(service.requests).toHaveLength(1);
  } finally { await service.cleanup(); }
});
