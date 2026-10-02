import { describe, expect, it, vi } from "vitest";
import { createCourseImportAi } from "./course-import-ai.js";
import type { AiExcerpt, ImportDraft } from "../shared/course-import.js";

const stageId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const draft: ImportDraft = { title: "微积分", originalFilename: "course.pdf", pageCount: 10, goal: "学会极限", weeklyHours: 3, stages: [{ id: stageId, title: "阅读", tasks: ["读第 1 页"] }], notes: [], warnings: [], aiStatus: "not-used", sourceFormat: "pdf" };
const config = { baseUrl: "https://example.com/v1", apiKey: "secret", model: "moma-test", maxTokens: 4000, temperature: 0.7 };
const excerpt: AiExcerpt = { revision: 1, stageIds: [stageId], excerptHash: "a".repeat(64), text: "课程名：微积分\n学习目标：学会极限\n[第 1 页]\n极限定义", chars: 29, pages: [{ stageId, page: 1, text: "极限定义" }] };
const suggestion = { stageId, title: "极限", tasks: ["解释极限定义"], notes: [{ title: "极限", page: 1, content: "极限描述趋近过程。" }] };
const response = (content: string) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
const call = (fetcher: typeof fetch) => createCourseImportAi(config, fetcher)(excerpt, draft, new AbortController().signal);

describe("course import AI", () => {
  it("sends exactly the preview text and validates chapter-bound suggestions", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(JSON.stringify({ suggestions: [suggestion] })));
    const result = await call(fetcher);
    expect(result[0]).toMatchObject({ ...suggestion, notes: [{ ...suggestion.notes[0], stageId, provenance: "ai" }] });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://example.com/v1/chat/completions");
    const messages = JSON.parse(init.body).messages;
    expect(messages.find((message: { role: string }) => message.role === "user").content).toBe(excerpt.text);
    expect(JSON.stringify(messages)).not.toContain("source.pdf");
    expect(messages[0].content).toContain("不得推测补全数学公式或表格关系");
  });
  it("accepts valid suggestions wrapped in explanation and a JSON fence", async () => {
    const content = `已整理：\n\`\`\`json\n${JSON.stringify({ suggestions: [suggestion] })}\n\`\`\`\n请核对。`;
    expect((await call(vi.fn().mockResolvedValue(response(content))))[0].title).toBe("极限");
  });
  it.each([
    { suggestions: [] }, { suggestions: [suggestion, suggestion] },
    { suggestions: [{ ...suggestion, stageId: otherId }] },
    { suggestions: [suggestion, { ...suggestion, stageId: otherId }] },
    { suggestions: [{ ...suggestion, title: " " }] },
    { suggestions: [{ ...suggestion, notes: [{ ...suggestion.notes[0], page: 2 }] }] },
    { suggestions: [{ ...suggestion, notes: [{ ...suggestion.notes[0], stageId: otherId }] }] },
  ])("rejects missing, extra, repeated or cross-chapter model fields %#", async (result) => {
    await expect(call(vi.fn().mockResolvedValue(response(JSON.stringify(result))))).rejects.toThrow("格式");
  });
  it("rejects prose or malformed output", async () => {
    await expect(call(vi.fn().mockResolvedValue(response("我建议你学习微积分")))).rejects.toThrow("格式");
  });
  it("does not expose the key in upstream errors", async () => {
    const error = await call(vi.fn().mockResolvedValue({ ok: false, status: 400 })).catch((cause) => cause);
    expect(error).toMatchObject({ status: 502, message: expect.stringContaining("HTTP 400") });
    expect(error.message).not.toContain("secret");
  });
  it("passes cancellation to fetch and distinguishes it from timeout", async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => { expect(init.signal!.aborted).toBe(true); throw new DOMException("aborted", "AbortError"); });
    await expect(createCourseImportAi(config, fetcher as typeof fetch)(excerpt, draft, controller.signal)).rejects.toMatchObject({ status: 499, message: expect.stringContaining("取消") });
  });
  it("identifies timeout without paid retries", async () => {
    const fetcher = vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(call(fetcher)).rejects.toMatchObject({ status: 504, message: expect.stringContaining("超时") });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("recovers from one transient server error without changing the consented excerpt", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValueOnce(response(JSON.stringify({ suggestions: [suggestion] })));
    expect((await call(fetcher))[0].title).toBe("极限");
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) expect(JSON.parse(init.body).messages[1].content).toBe(excerpt.text);
  });
});
