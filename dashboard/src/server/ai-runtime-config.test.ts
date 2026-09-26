// @vitest-environment node

import { describe, expect, it } from "vitest";

import { resolveAiRuntimeConfig } from "./ai-runtime-config.js";

describe("resolveAiRuntimeConfig", () => {
  it("uses offline Mock only when no real API setting is supplied", () => {
    expect(resolveAiRuntimeConfig({}).mode).toBe("mock");
  });

  it("rejects partial real API settings instead of silently falling back to Mock", () => {
    expect(() => resolveAiRuntimeConfig({ AI_API_KEY: "private-test-token" })).toThrow(/AI_BASE_URL.*AI_MODEL/);
  });

  it("accepts a complete compatible API configuration and normalizes the base URL", () => {
    expect(resolveAiRuntimeConfig({ AI_BASE_URL: "https://example.invalid/v1/", AI_API_KEY: "private-test-token", AI_MODEL: "test-model" })).toMatchObject({ mode: "compatible", config: { baseUrl: "https://example.invalid/v1", model: "test-model", maxTokens: 4000 } });
  });

  it("rejects full chat completion URLs because the adapter appends the path", () => {
    expect(() => resolveAiRuntimeConfig({ AI_BASE_URL: "https://example.invalid/v1/chat/completions", AI_API_KEY: "private-test-token", AI_MODEL: "test-model" })).toThrow(/基础地址/);
  });

  it("does not treat example placeholders as real credentials", () => {
    expect(() => resolveAiRuntimeConfig({ AI_BASE_URL: "https://your-openai-compatible-endpoint/v1", AI_API_KEY: "your-api-key-here", AI_MODEL: "your-model-name" })).toThrow(/示例值/);
  });
});
