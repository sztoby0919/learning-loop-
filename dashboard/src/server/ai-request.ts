import type { AiConfig } from "./ai-types.js";

export const AI_TIMEOUT_MS = 90_000;

// Messages are safe for the user; upstream response bodies and credentials never are.
export class AiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly retryable = false) { super(message); }
}

export function aiTimeoutError(): AiRequestError {
  return new AiRequestError("模型服务请求超时，已中止本地请求；请稍后重试，或减少本次内容。上游可能仍产生费用。", 504);
}

function upstreamError(status: number): AiRequestError {
  if (status === 401 || status === 403) return new AiRequestError(`模型服务鉴权失败（HTTP ${status}），请检查 AI_API_KEY 与访问权限`, 502);
  if (status === 404) return new AiRequestError("模型接口或模型名称不存在（HTTP 404），请检查 AI_BASE_URL 和 AI_MODEL", 502);
  if (status === 429) return new AiRequestError("模型服务请求过于频繁或额度不足（HTTP 429），请检查额度或稍后重试", 503);
  if (status === 400 || status === 422) return new AiRequestError(`模型服务拒绝请求（HTTP ${status}），请检查模型与接口支持的请求参数`, 502);
  return new AiRequestError(`模型服务暂时不可用（HTTP ${status}），请稍后重试`, 503, [500, 502, 503, 504].includes(status));
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function requestChatCompletion(
  config: AiConfig,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: { signal?: AbortSignal; fetcher?: typeof fetch; retries?: number } = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(aiTimeoutError()), AI_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const fetcher = options.fetcher ?? fetch;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        signal.throwIfAborted();
        const response = await fetcher(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST", signal, redirect: "error",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: config.model, messages, max_tokens: config.maxTokens, temperature: config.temperature, stream: false }),
        });
        if (!response.ok) throw upstreamError(response.status);
        let payload: unknown;
        try { payload = await response.json(); }
        catch (error) {
          if (signal.aborted) throw signal.reason;
          if (error && typeof error === "object" && "name" in error && error.name === "SyntaxError") {
            throw new AiRequestError("模型服务响应不是有效 JSON，请确认接口兼容 Chat Completions", 502);
          }
          throw error; // Body transport failures still qualify for bounded recovery.
        }
        signal.throwIfAborted();
        return payload;
      } catch (cause) {
        const name = cause && typeof cause === "object" && "name" in cause ? cause.name : "";
        const error = signal.aborted
          ? signal.reason instanceof AiRequestError ? signal.reason : new AiRequestError("模型请求已取消；不保证上游停止计费", 499)
          : cause instanceof AiRequestError ? cause
          : name === "TimeoutError" ? aiTimeoutError()
          : name === "AbortError" ? new AiRequestError("模型请求已取消；不保证上游停止计费", 499)
          : new AiRequestError("无法连接模型服务，请检查网络连接和 AI_BASE_URL", 502, true);
        if (!error.retryable || attempt >= (options.retries ?? 0) || signal.aborted) throw error;
        await abortableDelay(1000, signal);
      }
    }
  } catch (cause) {
    if (signal.aborted && !(cause instanceof AiRequestError)) {
      throw signal.reason instanceof AiRequestError ? signal.reason : new AiRequestError("模型请求已取消；不保证上游停止计费", 499);
    }
    throw cause;
  } finally { clearTimeout(timer); }
}
