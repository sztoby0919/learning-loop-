import type { DraftEntry } from "../shared/course-import.js";
import { CourseImportAiError } from "./course-import-ai.js";

function assertRevision(entry: DraftEntry, expectedRevision: number): void {
  if (entry.state !== "open" || entry.operation?.status === "running" || entry.revision !== expectedRevision) throw new CourseImportAiError("草稿正在处理或修订已变化，请重新加载", 409);
}
export function applyAiSuggestions(entry: DraftEntry, candidateId: string, acceptedStageIds: string[], expectedRevision: number): DraftEntry {
  assertRevision(entry, expectedRevision);
  const candidate = entry.candidate;
  if (!candidate || candidate.id !== candidateId || candidate.baseRevision !== entry.revision) throw new CourseImportAiError("AI 候选不存在、已应用或已因编辑失效", 409);
  if (!acceptedStageIds.length || new Set(acceptedStageIds).size !== acceptedStageIds.length || acceptedStageIds.some((id) => !candidate.suggestions.some((item) => item.stageId === id))) throw new CourseImportAiError("接受章节 ID 无效，请重新选择候选", 409);
  const accepted = new Map(candidate.suggestions.filter((item) => acceptedStageIds.includes(item.stageId)).map((item) => [item.stageId, item]));
  const stages = entry.draft.stages.map((stage) => {
    const replacement = accepted.get(stage.id!);
    return replacement ? { ...stage, title: replacement.title, tasks: [...replacement.tasks] } : stage;
  });
  const notes = [...entry.draft.notes.filter((note) => !note.stageId || !accepted.has(note.stageId)), ...[...accepted.values()].flatMap((item) => item.notes.map((note) => ({ ...note, stageId: item.stageId, provenance: "ai" as const })))];
  if (notes.length > 60) throw new CourseImportAiError("应用后笔记超过 60 条，请减少接受章节或候选笔记", 400);
  return { ...entry, revision: entry.revision + 1, updatedAt: Date.now(), candidate: undefined,
    operation: entry.operation ? { ...entry.operation, candidate: undefined } : undefined,
    undo: { appliedRevision: entry.revision + 1, before: structuredClone(entry.draft) }, draft: { ...entry.draft, stages, notes, aiStatus: "complete" } };
}
export function undoAiSuggestions(entry: DraftEntry, expectedRevision: number): DraftEntry {
  assertRevision(entry, expectedRevision);
  if (!entry.undo || entry.undo.appliedRevision !== entry.revision) throw new CourseImportAiError("最近一次 AI 应用已因编辑失效，不能覆盖新的编辑", 409);
  return { ...entry, revision: entry.revision + 1, updatedAt: Date.now(), draft: structuredClone(entry.undo.before), candidate: undefined, operation: entry.operation ? { ...entry.operation, candidate: undefined } : undefined, undo: undefined };
}
