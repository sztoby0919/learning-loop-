import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PracticeFlow } from "./PracticeFlow.js";

const created = { sessionId: "review", mode: "real", question: { id: "q", question: "切线表示什么？", options: ["平均变化", "瞬时变化", "面积", "体积"], knowledgePoint: "导数" } };
const success = () => new Response(JSON.stringify(created));
const failure = (status = 502, retryable = true) => new Response(JSON.stringify({ error: "生成失败", retryable }), { status });
const showReview = () => render(<PracticeFlow courseId="calculus-101" topic="导数" onSaved={() => {}} />);
const start = async () => { await act(async () => { fireEvent.click(screen.getByRole("button", { name: "开始复习" })); }); };

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("retries invalid AI output automatically and stops once a real question is generated", async () => {
  const fetcher = vi.fn().mockImplementationOnce(() => failure()).mockImplementation(() => success());
  vi.stubGlobal("fetch", fetcher); showReview(); await start();
  expect(screen.getByRole("status")).toHaveTextContent("第 1 次尝试");
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.getByRole("heading")).toHaveTextContent(created.question.question);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("increases the retry delay and caps it at 30 seconds without stopping retries", async () => {
  const fetcher = vi.fn(() => failure()); vi.stubGlobal("fetch", fetcher); showReview(); await start();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const calls = fetcher.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
    expect(fetcher).toHaveBeenCalledTimes(calls);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetcher).toHaveBeenCalledTimes(calls + 1);
  }
});

it("cancels a scheduled retry and resets the attempt count when starting again", async () => {
  const fetcher = vi.fn(() => failure()); vi.stubGlobal("fetch", fetcher); showReview(); await start();
  fireEvent.click(screen.getByRole("button", { name: "取消生成" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetcher).toHaveBeenCalledOnce();
  await start(); expect(screen.getByRole("status")).toHaveTextContent("第 1 次尝试");
});

it("ignores a cancelled response arriving after a new generation has started", async () => {
  let resolveOld!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; })).mockImplementation(() => success());
  vi.stubGlobal("fetch", fetcher); showReview(); await start();
  fireEvent.click(screen.getByRole("button", { name: "取消生成" })); await start();
  await act(async () => { resolveOld(new Response(JSON.stringify({ ...created, question: { ...created.question, question: "旧请求的题目" } }))); });
  expect(screen.getByRole("heading")).toHaveTextContent(created.question.question);
  expect((fetcher.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
});

it.each([400, 404, 409, 502, 503])("stops a nonretryable HTTP %s error rather than retrying forever", async (status) => {
  const fetcher = vi.fn(() => failure(status, false)); vi.stubGlobal("fetch", fetcher); showReview(); await start();
  expect(screen.getByRole("button", { name: "开始复习" })).toBeEnabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetcher).toHaveBeenCalledOnce();
});

it("retries a browser network failure", async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementation(() => success());
  vi.stubGlobal("fetch", fetcher); showReview(); await start();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.getByRole("heading")).toHaveTextContent(created.question.question);
});

it("clears pending retries when leaving the review page", async () => {
  const fetcher = vi.fn((_url: string, _init?: RequestInit) => failure()); vi.stubGlobal("fetch", fetcher); const view = showReview(); await start();
  view.unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetcher).toHaveBeenCalledOnce();
  expect((fetcher.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
});
