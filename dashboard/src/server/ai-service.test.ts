// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { AiService } from "./ai-service.js";
import { OpenAiCompatibleProvider } from "./openai-compatible-provider.js";

const config = { baseUrl: "https://example.invalid/v1", apiKey: "private-key", model: "test", maxTokens: 2000, temperature: 0.2 };
const params = { courseId: "c", topic: "训练集", count: 1, context: "训练集拟合参数" };
const question = { id: "q1", question: "训练集的用途？", options: ["拟合参数", "最终评估", "删除参数", "展示界面"], answer: "A", explanation: "训练集用于拟合参数。", knowledgePoint: "训练集" };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("aborts the underlying model request on timeout instead of leaving it running or retrying", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined; let attempts = 0;
  vi.stubGlobal("fetch", (_url: unknown, init: RequestInit) => {
    attempts++; signal = init.signal!;
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  });
  const service = new AiService({ provider: new OpenAiCompatibleProvider(config), timeoutMs: 100, maxRetries: 1 });
  const result = service.generateAssessmentQuestions(params).catch((error) => error);
  await vi.advanceTimersByTimeAsync(1300);
  expect(await result).toMatchObject({ status: 504, message: expect.stringContaining("超时") });
  expect(signal?.aborted).toBe(true);
  expect(attempts).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("clears its deadline timer after a successful model response", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([question]) } }] }) }));
  const result = await new AiService({ provider: new OpenAiCompatibleProvider(config), timeoutMs: 100 }).generateAssessmentQuestions(params);
  expect(result).toEqual([question]);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not retry authentication failures or leak upstream credentials", async () => {
  let attempts = 0;
  vi.stubGlobal("fetch", async () => { attempts++; return { ok: false, status: 401, text: async () => "private-key rejected" }; });
  const service = new AiService({ provider: new OpenAiCompatibleProvider(config), maxRetries: 1 });
  const error = await service.generateAssessmentQuestions(params).catch((cause) => cause);
  expect(error).toMatchObject({ status: 502, message: expect.stringContaining("鉴权") });
  expect(error.message).not.toContain("private-key");
  expect(attempts).toBe(1);
});

it("recovers from one temporary upstream 500 within the same operation deadline", async () => {
  vi.useFakeTimers(); let attempts = 0;
  vi.stubGlobal("fetch", async () => {
    attempts++;
    return attempts === 1 ? { ok: false, status: 500 } : { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([question]) } }] }) };
  });
  const result = new AiService({ provider: new OpenAiCompatibleProvider(config), timeoutMs: 5000, maxRetries: 1 }).generateAssessmentQuestions(params);
  await vi.advanceTimersByTimeAsync(1001);
  expect(await result).toEqual([question]); expect(attempts).toBe(2); expect(vi.getTimerCount()).toBe(0);
});
