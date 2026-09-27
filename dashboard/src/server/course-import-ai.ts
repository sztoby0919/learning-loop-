import { z } from "zod";

import type { AiConfig } from "./ai-types.js";
import type { ImportDraft } from "./course-import.js";

const resultSchema = z.object({
  stages: z.array(z.object({ title: z.string().min(1).max(100), tasks: z.array(z.string().min(1).max(300)).min(1).max(20) })).min(1).max(60),
  notes: z.array(z.object({ title: z.string().min(1).max(100), page: z.number().int().positive(), content: z.string().min(1).max(1500) })).max(60),
});

export class CourseImportAiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function parseDraftJson(content: string): unknown {
  const fenced = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  const candidates = [content.trim(), ...fenced, ...(firstBrace >= 0 && lastBrace > firstBrace ? [content.slice(firstBrace, lastBrace + 1)] : [])];
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* Try another wrapper around the JSON. */ }
  }
  throw new CourseImportAiError("模型返回的数据格式不正确：没有可解析的 JSON 课程草稿，请尝试其他支持结构化输出的模型", 502);
}

function upstreamError(status: number): CourseImportAiError {
  if (status === 401 || status === 403) return new CourseImportAiError(`模型服务鉴权失败（HTTP ${status}），请检查 AI_API_KEY`, 502);
  if (status === 404) return new CourseImportAiError("模型接口或模型名称不存在（HTTP 404），请检查 AI_BASE_URL 和 AI_MODEL", 502);
  if (status === 429) return new CourseImportAiError("模型服务请求过于频繁或额度不足（HTTP 429），请稍后重试并检查额度", 503);
  if (status === 400 || status === 422) return new CourseImportAiError(`模型服务拒绝请求（HTTP ${status}），请检查 AI_MODEL 和接口支持的请求参数`, 502);
  return new CourseImportAiError(`模型服务返回 HTTP ${status}，请检查服务状态后重试`, 502);
}

export function createCourseImportAi(config: AiConfig, fetcher: typeof fetch = fetch) {
  return async (excerpt: string, draft: ImportDraft): Promise<Pick<ImportDraft, "stages" | "notes">> => {
    let response: Response;
    try {
      response = await fetcher(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(90_000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: Math.max(3000, config.maxTokens),
        messages: [
          { role: "system", content: "你是课程资料整理助手。只根据用户提供的文档摘录生成章节级课程草稿；不得编造未提供的章节、事实、页码、截止日期或个人学习记录。只返回 JSON 对象，结构为 {stages:[{title,tasks:[string]}],notes:[{title,page,content}]}。任务必须是待完成的学习动作；笔记注明可靠页码。" },
          { role: "user", content: `课程名：${draft.title}\n学习目标：${draft.goal || "未填写"}\n每周学习时间：${draft.weeklyHours ?? "未填写"}\n以下仅是文档的目录和代表性摘录，并非全文；不要声称覆盖全书。\n${excerpt}` },
        ],
      }),
      });
    } catch (error) {
      const errorName = error && typeof error === "object" && "name" in error ? error.name : undefined;
      if (errorName === "TimeoutError" || errorName === "AbortError") {
        throw new CourseImportAiError("模型服务请求超时（90 秒），基础草稿已保留，可稍后重试", 504);
      }
      throw new CourseImportAiError("无法连接模型服务，请检查 AI_BASE_URL 和网络连接", 502);
    }
    if (!response.ok) throw upstreamError(response.status);
    let payload: { choices?: Array<{ message?: { content?: unknown } }> };
    try { payload = await response.json() as typeof payload; }
    catch { throw new CourseImportAiError("模型服务响应不是有效 JSON，请确认接口兼容 Chat Completions", 502); }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new CourseImportAiError("模型返回的数据格式不正确：缺少文本内容", 502);
    const parsed = parseDraftJson(content);
    const result = resultSchema.safeParse(parsed);
    if (!result.success) throw new CourseImportAiError("模型返回的数据格式不正确：课程章节或笔记字段无效", 502);
    return result.data;
  };
}
