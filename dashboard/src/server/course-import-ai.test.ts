import { describe, expect, it, vi } from "vitest";

import { createCourseImportAi } from "./course-import-ai.js";
import type { ImportDraft } from "./course-import.js";

const draft: ImportDraft = { title: "微积分", originalFilename: "course.pdf", pageCount: 10, goal: "学会极限", weeklyHours: 3, stages: [{ title: "阅读", tasks: ["读第 1 页"] }], notes: [], warnings: [], aiStatus: "not-used" };
const config = { baseUrl: "https://example.com/v1", apiKey: "secret", model: "moma-test", maxTokens: 4000, temperature: 0.7 };

describe("course import AI", () => {
  it("sends only the supplied excerpt and validates chapter-level JSON", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ stages: [{ title: "极限", tasks: ["解释极限定义"] }], notes: [{ title: "极限", page: 1, content: "极限描述趋近过程。" }] }) } }] }) });
    const result = await createCourseImportAi(config, fetcher)("[第 1 页] 极限定义", draft);
    expect(result.stages[0].tasks).toEqual(["解释极限定义"]);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://example.com/v1/chat/completions");
    expect(JSON.stringify(JSON.parse(init.body))).toContain("[第 1 页] 极限定义");
    expect(JSON.stringify(JSON.parse(init.body))).not.toContain("source.pdf");
  });

  it("rejects prose or malformed model output", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: "我建议你学习微积分" } }] }) });
    await expect(createCourseImportAi(config, fetcher)("极限定义", draft)).rejects.toThrow("格式");
  });

  it("accepts a valid JSON draft wrapped in model explanation and a code fence", async () => {
    const content = `已整理为章节草稿：\n\`\`\`json\n${JSON.stringify({ stages: [{ title: "极限", tasks: ["阅读第 1 页并解释极限"] }], notes: [{ title: "极限", page: 1, content: "来自第 1 页的极限定义。" }] })}\n\`\`\`\n请核对原文。`;
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
    const result = await createCourseImportAi(config, fetcher)("[第 1 页] 极限定义", draft);
    expect(result.stages[0].title).toBe("极限");
    expect(result.notes[0].page).toBe(1);
  });

  it("explains an upstream bad request without exposing the API key", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    const error = await createCourseImportAi(config, fetcher)("极限定义", draft).catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      status: 502,
      message: expect.stringContaining("HTTP 400"),
    });
    expect((error as Error).message).not.toContain("secret");
  });

  it("identifies a model timeout as a retryable gateway timeout", async () => {
    const fetcher = vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(createCourseImportAi(config, fetcher)("极限定义", draft)).rejects.toMatchObject({
      status: 504,
      message: expect.stringContaining("超时"),
    });
  });
});
