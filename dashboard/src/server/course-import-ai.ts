import { z } from "zod";
import { AiRequestError, requestChatCompletion } from "./ai-request.js";

import type { AiConfig } from "./ai-types.js";
import type { AiExcerpt, AiSuggestion, ImportDraft } from "../shared/course-import.js";

const resultSchema = z.object({
  suggestions: z.array(z.object({ stageId: z.string().uuid(), title: z.string().trim().min(1).max(100), tasks: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
    notes: z.array(z.object({ title: z.string().trim().min(1).max(100), page: z.number().int().positive(), content: z.string().trim().min(1).max(1500), stageId: z.string().uuid().optional(), provenance: z.literal("ai").optional() }).strict()).max(60),
  }).strict()).min(1).max(60),
}).strict();

export class CourseImportAiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function validateAiSuggestions(input: unknown, excerpt: AiExcerpt): AiSuggestion[] {
  const result = resultSchema.safeParse({ suggestions: input });
  const invalid = () => new CourseImportAiError("模型返回的数据格式不正确：章节 ID、笔记页码或字段无效", 502);
  if (!result.success) throw invalid();
  const suggestions = result.data.suggestions;
  const ids = suggestions.map((item) => item.stageId);
  if (ids.length !== excerpt.stageIds.length || new Set(ids).size !== ids.length || ids.some((id) => !excerpt.stageIds.includes(id)) || suggestions.reduce((sum, item) => sum + item.notes.length, 0) > 60) throw invalid();
  return suggestions.map((item) => {
    const pages = new Set(excerpt.pages.filter((page) => page.stageId === item.stageId).map((page) => page.page));
    if (item.notes.some((note) => !pages.has(note.page) || (note.stageId && note.stageId !== item.stageId))) throw invalid();
    return { ...item, notes: item.notes.map((note) => ({ ...note, stageId: item.stageId, provenance: "ai" })) };
  });
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

export function createCourseImportAi(config: AiConfig, fetcher: typeof fetch = fetch) {
  return async (excerpt: AiExcerpt, _draft: ImportDraft, signal: AbortSignal): Promise<AiSuggestion[]> => {
    let payload: { choices?: Array<{ message?: { content?: unknown } }> };
    try {
      payload = await requestChatCompletion({ ...config, temperature: 0.2, maxTokens: Math.max(3000, config.maxTokens) }, [
          { role: "system", content: "你是课程资料整理助手。只根据用户提供的文档摘录生成章节级建议；不得编造未提供的章节、事实、页码、截止日期或个人学习记录。文档文字层可能存在符号错乱或排版丢失，不得推测补全数学公式或表格关系；遇到不清楚的公式或表格，仅安排查看对应原页的学习任务，不把猜测写入笔记。只返回 JSON 对象，结构为 {suggestions:[{stageId,title,tasks:[string],notes:[{title,page,content}]}]}。每个所选章节 ID 必须且只能出现一次，不返回额外章节。笔记页码必须属于该章节实际发送页面。任务必须是待完成的学习动作。" },
          { role: "user", content: excerpt.text },
        ], { signal, fetcher, retries: 1 }) as typeof payload;
    } catch (error) {
      if (error instanceof AiRequestError) throw new CourseImportAiError(`${error.message}${error.status === 504 ? " 基础草稿已保留。" : ""}`, error.status);
      throw error;
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length > 200000) throw new CourseImportAiError("模型返回的数据格式不正确：缺少文本内容或内容过大", 502);
    const parsed = parseDraftJson(content);
    const result = resultSchema.safeParse(parsed);
    if (!result.success) throw new CourseImportAiError("模型返回的数据格式不正确：课程章节或笔记字段无效", 502);
    return validateAiSuggestions(result.data.suggestions, excerpt);
  };
}
