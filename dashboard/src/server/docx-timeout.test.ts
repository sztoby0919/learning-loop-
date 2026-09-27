import { afterEach, expect, it, vi } from "vitest";

vi.mock("mammoth", () => ({
  convertToHtml: () => new Promise((resolve) => setTimeout(() => resolve({ value: "<h1>标题</h1>", messages: [] }), 50_000)),
  extractRawText: () => new Promise(() => {}),
}));

import { extractDocx } from "./docx-extractor.js";

afterEach(() => vi.useRealTimers());

it("times out the whole DOCX conversion after 60 seconds, not each step separately", async () => {
  vi.useFakeTimers();
  const rejected = vi.fn();
  void extractDocx(new Uint8Array([0x50, 0x4B, 0x03, 0x04]), "slow.docx").catch(rejected);
  await vi.advanceTimersByTimeAsync(60_001);
  expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("超时") }));
});
