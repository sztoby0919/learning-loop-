import type { AiConfig } from "./ai-types.js";

export interface AiRuntimeConfig {
  mode: "mock" | "compatible";
  config: AiConfig;
}

export function resolveAiRuntimeConfig(env: NodeJS.ProcessEnv): AiRuntimeConfig {
  const requestedMode = env.AI_MODE?.trim();
  if (requestedMode && requestedMode !== "mock" && requestedMode !== "compatible") throw new Error("AI_MODE 只能是 mock 或 compatible");

  const baseUrl = env.AI_BASE_URL?.trim() ?? "";
  const apiKey = env.AI_API_KEY?.trim() ?? "";
  const model = env.AI_MODEL?.trim() ?? "";
  const mockConfig: AiConfig = { baseUrl: "", apiKey: "", model: "mock-model", maxTokens: 2000, temperature: 0.7 };
  if (requestedMode === "mock" || (!requestedMode && !baseUrl && !apiKey && !model)) return { mode: "mock", config: mockConfig };

  if (!baseUrl || !apiKey || !model) throw new Error("真实模型需要完整配置 AI_BASE_URL、AI_API_KEY、AI_MODEL；离线演示请设置 AI_MODE=mock");
  if (baseUrl.includes("your-openai-compatible-endpoint") || apiKey === "your-api-key-here" || model === "your-model-name") throw new Error("AI 配置仍是示例值，请填入实际参数");

  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new Error("AI_BASE_URL 不是有效的基础地址"); }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) {
    throw new Error("AI_BASE_URL 必须使用 HTTPS，本地服务可使用 HTTP");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || /\/chat\/completions\/?$/.test(parsed.pathname)) {
    throw new Error("AI_BASE_URL 请填写基础地址，不要包含认证信息、查询参数或 /chat/completions");
  }
  const normalizedBaseUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  return { mode: "compatible", config: { baseUrl: normalizedBaseUrl, apiKey, model, maxTokens: 4000, temperature: 0.7 } };
}
