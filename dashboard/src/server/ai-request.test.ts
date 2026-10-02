// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { requestChatCompletion } from "./ai-request.js";

const config = { baseUrl: "https://example.invalid/v1", apiKey: "secret", model: "test", maxTokens: 2000, temperature: 0.2 };
const messages = [{ role: "user" as const, content: "公开测试材料" }];
afterEach(() => vi.useRealTimers());

it("cancels transient-error backoff without sending another request or leaking an abort reason", async () => {
  vi.useFakeTimers(); const controller = new AbortController(); let attempts = 0;
  const fetcher = (async () => { attempts++; return { ok: false, status: 500 }; }) as unknown as typeof fetch;
  const result = requestChatCompletion(config, messages, { signal: controller.signal, retries: 1, fetcher }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(0); controller.abort(new Error("secret abort reason"));
  const error = await result;
  expect(error).toMatchObject({ status: 499, message: expect.stringContaining("取消") });
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain("secret"); expect(attempts).toBe(1); expect(vi.getTimerCount()).toBe(0);
});

it("includes body reading and retry backoff in one bounded deadline", async () => {
  vi.useFakeTimers(); let attempts = 0; let activeSignal: AbortSignal | null | undefined;
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    attempts++;
    if (attempts === 1) return { ok: false, status: 500 };
    activeSignal = init.signal;
    return { ok: true, json: () => new Promise((_resolve, reject) => activeSignal!.addEventListener("abort", () => reject(activeSignal!.reason), { once: true })) };
  }) as unknown as typeof fetch;
  const result = requestChatCompletion(config, messages, { retries: 1, fetcher }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(90_001);
  expect(await result).toMatchObject({ status: 504 }); expect(attempts).toBe(2); expect(activeSignal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
});

it("retries a temporary response-body disconnect instead of labelling it invalid JSON", async () => {
  vi.useFakeTimers(); let attempts = 0;
  const fetcher = (async () => {
    attempts++;
    return { ok: true, json: async () => { if (attempts === 1) throw new TypeError("terminated: secret"); return { choices: [] }; } };
  }) as unknown as typeof fetch;
  const result = requestChatCompletion(config, messages, { retries: 1, fetcher }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(1001);
  expect(await result).toEqual({ choices: [] }); expect(attempts).toBe(2); expect(vi.getTimerCount()).toBe(0);
});

it("does not retry syntactically invalid upstream JSON or disclose its body", async () => {
  let attempts = 0;
  const fetcher = (async () => { attempts++; return { ok: true, json: async () => { throw new SyntaxError("secret invalid JSON"); } }; }) as unknown as typeof fetch;
  const error = await requestChatCompletion(config, messages, { retries: 1, fetcher }).catch((cause) => cause);
  expect(error).toMatchObject({ status: 502, retryable: false }); expect((error as Error).message).not.toContain("secret"); expect(attempts).toBe(1);
});
