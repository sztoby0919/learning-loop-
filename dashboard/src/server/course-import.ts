import { randomUUID } from "node:crypto";

import type { ExtractedDocument, ImportDraft, ImportStage } from "../shared/course-import.js";
export type { ExtractedDocument, ImportDraft } from "../shared/course-import.js";

const cleanLine = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
const heading = (value: string) => cleanLine(value).replace(/^#+\s*/, "").slice(0, 100);
const tableCell = (value: string) => cleanLine(value).replace(/\|/g, "\\|");
const yamlString = (value: string) => JSON.stringify(value);
// Keep source headings inside a paragraph while preserving literal backslashes.
// The matching frontmatter flag lets readers reverse this encoding, not guess.
const excerptLine = (value: string) => cleanLine(value).replace(/\\/g, "\\\\").replace(/^#/, "\\#");
const plainExcerpt = (value: string) => value.replace(/\r\n?/g, "\n").trim();
const excerptBlock = (value: string) => {
  const text = plainExcerpt(value);
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  return `${fence}text\n${text}\n${fence}`;
};
const auxiliaryPdfTitle = (value: string) => /^(?:目录|目次|主要符号表|符号表|符号说明|前言|序言|序|致谢|tableofcontents|contents|listofsymbols|listofnotations|notation|notations|preface|foreword|acknowledgements?)$/i.test(value.replace(/\s+/g, ""));
const appendixTitle = (value: string) => /^(?:附录|appendix\b|appendices\b)/i.test(value.trim());
const positionLabel = (format: ExtractedDocument["sourceFormat"], page: number) => format === "pdf" ? `第 ${page} 页` : `第 ${page} 段文本${format === "docx" ? "（估算位置）" : ""}`;

export function createBasicDraft(source: ExtractedDocument, originalFilename: string): ImportDraft {
  const seen = new Set<string>();
  const validSections = source.outline.filter((item) => {
    const title = heading(item.title);
    if (!title || item.page < 1 || item.page > source.pageCount || seen.has(title)) return false;
    seen.add(title);
    return true;
  });
  const isPdf = source.sourceFormat === "pdf";
  const references = isPdf ? validSections.filter((item) => appendixTitle(item.title)).map((item) => ({ title: heading(`参考：${item.title}`), page: item.page })) : [];
  const learningSections = validSections.filter((item) => !isPdf || (!auxiliaryPdfTitle(item.title) && !appendixTitle(item.title)));
  const sections = learningSections.slice(0, 60);
  const sourceLabel = source.sourceFormat === "docx" ? "Word 文档" : source.sourceFormat === "text" ? "文本文件" : "PDF";
  const stages: ImportStage[] = sections.length
    ? sections.map((item) => ({ id: randomUUID(), title: heading(item.title), tasks: [`阅读“${heading(item.title)}”（从${positionLabel(source.sourceFormat, item.page)}开始），写下核心概念与疑问`], source: {
      title: heading(item.title), startPage: item.page,
      endPage: Math.min(...validSections.filter((next) => next.page > item.page).map((next) => next.page - 1), source.pageCount),
    } }))
    : [{ id: randomUUID(), title: `阅读原始 ${sourceLabel}`, tasks: [`阅读原始 ${sourceLabel}，并标记需要进一步学习的章节（共 ${source.pageCount} ${source.sourceFormat === "pdf" ? "页" : "段文本"}）`] }];
  const noteSections = sections.length ? sections : source.pages.filter((page) => page.text.trim()).slice(0, 1).map((page) => ({ title: "原文开头", page: page.page }));
  const makeNote = (item: { title: string; page: number }) => ({ title: heading(item.title), page: item.page, content: (isPdf ? plainExcerpt : cleanLine)(source.pages.find((page) => page.page === item.page)?.text ?? "").slice(0, 500), provenance: "source" as const,
    ...(stages.find((stage) => stage.source?.startPage === item.page && stage.source.title === heading(item.title))?.id ? { stageId: stages.find((stage) => stage.source?.startPage === item.page && stage.source.title === heading(item.title))!.id } : {}),
  });
  const referenceNotes = references.map(makeNote).filter((item) => item.content).slice(0, 60);
  const chapterNotes = noteSections.map(makeNote).filter((item) => item.content);
  const notes = [...chapterNotes.slice(0, 60 - referenceNotes.length), ...referenceNotes];
  const deadlines = source.pages.flatMap((page) => {
    const match = page.text.match(/(作业截止日期|提交截止日期|考试日期|截止日期|deadline|due date)\s*[:：]?\s*(\d{4})[-/]([01]?\d)[-/]([0-3]?\d)/i);
    if (!match) return [];
    const date = `${match[2]}-${match[3].padStart(2, "0")}-${match[4].padStart(2, "0")}`;
    const parsedDate = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== date) return [];
    const type = match[1].includes("考试") ? "考试" : match[1].includes("作业") ? "作业" : "截止事项";
    return [{ date, page: page.page, type, title: match[1] }];
  });
  return {
    title: heading(source.title) || heading(originalFilename.replace(new RegExp(`\\.${source.sourceFormat}$`, "i"), "")) || "未命名课程",
    originalFilename: cleanLine(originalFilename),
    pageCount: source.pageCount,
    goal: "",
    weeklyHours: null,
    stages,
    notes,
    references,
    ...(source.quality ? { quality: source.quality } : {}),
    warnings: [...source.warnings, ...(learningSections.length > 60 ? ["目录超过 60 项，仅预览前 60 项；可在创建后补充。"] : []), ...(learningSections.length < validSections.length ? ["目录、前言和符号表不默认列为学习阶段；附录保留为参考内容。"] : []), ...(noteSections.length + references.length > 60 ? ["摘录超过 60 项，优先预留附录摘录位置；所有附录页链接仍保留在资源中，请对照原文补充其余摘录。"] : []), source.sourceFormat === "pdf" ? "公式、表格和图片可能无法从 PDF 文字层准确提取，请对照原文核查；文字摘录不是已还原的公式或结构化表格。" : source.sourceFormat === "docx" ? "公式、表格和图片可能无法从 Word 文档中准确提取，请对照原文核查。" : "纯文本/HTML 的文字已提取；图片和公式可能无法保留，请对照原文核查。"],
    aiStatus: "not-used",
    sourceFormat: source.sourceFormat,
    deadlines,
  };
}

export function buildCourseFiles(draft: ImportDraft, courseId: string, today: string): Record<"course.md" | "notes.md" | "reviews.md" | "resources.md" | "schedule.md", string> {
  const encoding = draft.sourceFormat === "pdf" ? "fenced-text-v2" : "escaped-line-v1";
  const excerpt = draft.sourceFormat === "pdf" ? excerptBlock : excerptLine;
  const provenance = `sourceNoteProvenance: ${JSON.stringify({ version: 1, entries: draft.notes.flatMap((note, headingIndex) => note.provenance ? [{ headingIndex, heading: heading(note.title), page: note.page, provenance: note.provenance }] : []) })}\n`;
  const frontmatter = `---\ncourseId: ${courseId}\nupdated: ${today}\n---\n`;
  const sourceLabel = draft.sourceFormat === "docx" ? "Word 文档" : draft.sourceFormat === "text" ? "文本文件" : "PDF";
  const overview = [
    `来源：${draft.originalFilename}（${draft.pageCount} ${draft.sourceFormat === "pdf" ? "页" : "段文本"}）。`,
    draft.goal ? `学习目标：${cleanLine(draft.goal)}` : "学习目标：待补充。",
    draft.weeklyHours ? `每周计划学习：${draft.weeklyHours} 小时。` : "每周学习时间：未设置。",
    draft.aiStatus === "complete" ? `部分学习阶段已接受 AI 辅助建议，请以原 ${sourceLabel} 核对；其余阶段保留原始草稿。` : `课程提纲依据 ${sourceLabel} 目录生成，尚未经过 AI 完善。`,
  ].join("\n\n");
  const route = draft.stages.map((stage) => `### ${heading(stage.title)}\n${stage.tasks.map((task) => `- [ ] ${cleanLine(task)}`).join("\n")}`).join("\n\n");
  const keyPoints = (depth: 2 | 3) => draft.notes.length
    ? draft.notes.map((note) => `${"#".repeat(depth)} ${heading(note.title)}\n\n来源：原 ${sourceLabel} ${positionLabel(draft.sourceFormat, note.page)}。\n\n${excerpt(note.content)}`).join("\n\n")
    : `暂无可靠的原文摘录，请阅读 ${sourceLabel} 后补充。`;
  const scheduleRows = (draft.deadlines ?? []).map((item) => `| ${item.date} | ${tableCell(item.type)} | ${tableCell(item.title)} | 全课程 | 计划中 | 原 ${sourceLabel} ${positionLabel(draft.sourceFormat, item.page)} |`).join("\n");
  const resourceType = draft.sourceFormat === "docx" ? "DOCX" : /\.html?$/i.test(draft.originalFilename) ? "HTML" : draft.sourceFormat === "text" ? "TEXT" : "PDF";
  const references = draft.references ?? draft.notes.filter((note) => note.title.startsWith("参考："));
  const referenceRows = draft.sourceFormat === "pdf" ? references.map((item) => `| ${tableCell(item.title)} | PDF | /api/courses/${courseId}/source#page=${item.page} | 参考内容 | 未开始 | 原 PDF 第 ${item.page} 页 |\n`).join("") : "";
  return {
    "course.md": `---\nid: ${courseId}\ntitle: ${yamlString(draft.title)}\nshortTitle: ${yamlString(draft.title.slice(0, 12))}\naccent: "#27624B"\nupdated: ${today}\norder: 999\narchived: false\naiStatus: ${draft.aiStatus}\nsourceExcerptEncoding: ${encoding}\n${provenance}---\n\n# ${heading(draft.title)}\n\n## 课程概览\n\n${overview}\n\n## 学习路线\n\n${route}\n\n## 关键知识\n\n${keyPoints(3)}\n\n## 易错点\n\n暂无个人易错点记录。\n\n## 学习记录\n\n| 日期 | 学习内容 | 掌握度 1-10 | 遇到困难 | 下一步 |\n| --- | --- | ---: | --- | --- |\n`,
    "notes.md": `---\ncourseId: ${courseId}\nupdated: ${today}\naiStatus: ${draft.aiStatus}\nsourceExcerptEncoding: ${encoding}\n${provenance}---\n\n# ${heading(draft.title)}笔记\n\n${keyPoints(2)}\n`,
    "reviews.md": `${frontmatter}\n# 复习计划\n\n| 知识点 | 上次复习 | 下次复习 | 掌握度 1-10 | 复习证据 |\n| --- | --- | --- | ---: | --- |\n`,
    "resources.md": `${frontmatter}\n# 学习资源\n\n| 名称 | 类型 | URL 或本地路径 | 对应阶段 | 使用状态 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n| ${tableCell(draft.originalFilename)} | ${resourceType} | /api/courses/${courseId}/source | 全课程 | 使用中 | 原始导入文件 |\n${referenceRows}`,
    "schedule.md": `${frontmatter}\n# 日程\n\n| 日期 | 类型 | 标题 | 对应阶段 | 状态 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n${scheduleRows}${scheduleRows ? "\n" : ""}`,
  };
}
