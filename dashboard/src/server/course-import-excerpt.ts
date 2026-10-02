import type { AiExcerpt, DraftEntry } from "../shared/course-import.js";
import { createHash } from "node:crypto";
import { CourseImportAiError } from "./course-import-ai.js";

const LIMIT = 24000;
const auxiliary = /^(?:目录|目次|主要符号表|符号表|符号说明|前言|序言|序|致谢|tableofcontents|contents|listofsymbols|listofnotations|notations?|preface|foreword|acknowledgements?|附录.*|appendix.*|appendices.*)$/i;
export function buildAiExcerpt(entry: DraftEntry, stageIds: string[]): AiExcerpt {
  if (!stageIds.length || stageIds.length > 60 || new Set(stageIds).size !== stageIds.length) throw new CourseImportAiError("请选择不重复的来源章节", 400);
  const stages = stageIds.map((id) => entry.draft.stages.find((stage) => stage.id === id));
  if (stages.some((stage) => !stage?.source)) throw new CourseImportAiError("选择中包含未知章节或没有来源范围的手工阶段", 400);
  const selected = stages.map((stage) => stage!);
  const excluded = new Set(entry.source.outline.filter((item) => auxiliary.test(item.title.replace(/\s+/g, ""))).map((item) => item.page));
  const available = selected.map((stage) => entry.source.pages.filter((page) => page.page >= stage.source!.startPage && page.page <= Math.min(stage.source!.endPage, stage.source!.startPage + 1) && page.text.trim() && !excluded.has(page.page)).sort((a, b) => a.page - b.page));
  if (available.some((pages) => !pages.length)) throw new CourseImportAiError("所选章节开头两页没有可发送文字，请更换章节", 400);
  let text = `课程名：${entry.draft.title}\n学习目标：${entry.draft.goal || "未填写"}\n每周学习时间：${entry.draft.weeklyHours ?? "未填写"}\n以下仅是所选章节的目录和开头代表性摘录，并非全文；不要声称覆盖全书。\n所选目录：\n${selected.map((stage) => `${stage.id}: ${stage.title}（来源：${stage.source!.title}）`).join("\n")}\n`;
  const pages: AiExcerpt["pages"] = [];
  const blockHeader = (id: string, page: number) => `\n[章节 ${id}]\n[第 ${page} 页]\n`;
  // Reserve one complete marker and some actual text for every selected chapter.
  const share = Math.floor((LIMIT - text.length) / selected.length);
  for (let index = 0; index < selected.length; index += 1) {
    const id = selected[index].id!; const page = available[index][0];
    const header = blockHeader(id, page.page);
    const cap = Math.min(1200, share - header.length - 1);
    if (cap <= 0) throw new CourseImportAiError("所选目录超过发送预算，请减少章节", 400);
    const content = page.text.trim().slice(0, cap);
    pages.push({ stageId: id, page: page.page, text: content }); text += `${header}${content}\n`;
  }
  for (let index = 0; index < selected.length; index += 1) {
    const page = available[index][1]; if (!page) continue;
    const id = selected[index].id!; const header = blockHeader(id, page.page);
    const cap = Math.min(1200, LIMIT - text.length - header.length - 1);
    if (cap <= 0) continue;
    const content = page.text.trim().slice(0, cap);
    pages.push({ stageId: id, page: page.page, text: content }); text += `${header}${content}\n`;
  }
  const excerptHash = createHash("sha256").update(JSON.stringify({ revision: entry.revision, stageIds, text })).digest("hex");
  return { revision: entry.revision, stageIds: [...stageIds], excerptHash, text, pages, chars: text.length };
}
