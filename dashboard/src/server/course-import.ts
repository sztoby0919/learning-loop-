export interface ExtractedDocument {
  title: string;
  pageCount: number;
  pages: Array<{ page: number; text: string }>;
  outline: Array<{ title: string; page: number }>;
  warnings: string[];
  sourceFormat: "pdf" | "docx" | "text";
}

export interface ImportDraft {
  title: string;
  originalFilename: string;
  pageCount: number;
  goal: string;
  weeklyHours: number | null;
  stages: Array<{ title: string; tasks: string[] }>;
  notes: Array<{ title: string; page: number; content: string }>;
  warnings: string[];
  aiStatus: "not-used" | "complete" | "failed";
  sourceFormat: "pdf" | "docx" | "text";
  deadlines?: Array<{ date: string; page: number; type: string; title: string }>;
}

const cleanLine = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
const heading = (value: string) => cleanLine(value).replace(/^#+\s*/, "").slice(0, 100);
const tableCell = (value: string) => cleanLine(value).replace(/\|/g, "\\|");
const yamlString = (value: string) => JSON.stringify(value);
const positionLabel = (format: ExtractedDocument["sourceFormat"], page: number) => format === "text" ? `第 ${page} 段文本` : `第 ${page} 页`;

export function createBasicDraft(source: ExtractedDocument, originalFilename: string): ImportDraft {
  const seen = new Set<string>();
  const sections = source.outline.filter((item) => {
    const title = heading(item.title);
    if (!title || item.page < 1 || item.page > source.pageCount || seen.has(title)) return false;
    seen.add(title);
    return true;
  }).slice(0, 60);
  const sourceLabel = source.sourceFormat === "docx" ? "Word 文档" : source.sourceFormat === "text" ? "文本文件" : "PDF";
  const stages = sections.length
    ? sections.map((item) => ({ title: heading(item.title), tasks: [`阅读“${heading(item.title)}”（从${positionLabel(source.sourceFormat, item.page)}开始），写下核心概念与疑问`] }))
    : [{ title: `阅读原始 ${sourceLabel}`, tasks: [`阅读原始 ${sourceLabel}，并标记需要进一步学习的章节（共 ${source.pageCount} ${source.sourceFormat === "text" ? "段文本" : "页"}）`] }];
  const notes = (sections.length ? sections : source.pages.slice(0, 1).map((page) => ({ title: "原文开头", page: page.page })))
    .map((item) => ({ title: heading(item.title), page: item.page, content: cleanLine(source.pages.find((page) => page.page === item.page)?.text ?? "").slice(0, 500) }))
    .filter((item) => item.content);
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
    warnings: [...source.warnings, ...(source.outline.length > 60 ? ["目录超过 60 项，仅预览前 60 项；可在创建后补充。"] : []), source.sourceFormat === "pdf" ? "公式、表格和图片可能无法从 PDF 文字层准确提取，请对照原文核查。" : source.sourceFormat === "docx" ? "公式、表格和图片可能无法从 Word 文档中准确提取，请对照原文核查。" : "纯文本/HTML 的文字已提取；图片和公式可能无法保留，请对照原文核查。"],
    aiStatus: "not-used",
    sourceFormat: source.sourceFormat,
    deadlines,
  };
}

export function buildCourseFiles(draft: ImportDraft, courseId: string, today: string): Record<"course.md" | "notes.md" | "reviews.md" | "resources.md" | "schedule.md", string> {
  const frontmatter = `---\ncourseId: ${courseId}\nupdated: ${today}\n---\n`;
  const sourceLabel = draft.sourceFormat === "docx" ? "Word 文档" : draft.sourceFormat === "text" ? "文本文件" : "PDF";
  const overview = [
    `来源：${draft.originalFilename}（${draft.pageCount} ${draft.sourceFormat === "text" ? "段文本" : "页"}）。`,
    draft.goal ? `学习目标：${cleanLine(draft.goal)}` : "学习目标：待补充。",
    draft.weeklyHours ? `每周计划学习：${draft.weeklyHours} 小时。` : "每周学习时间：未设置。",
    draft.aiStatus === "complete" ? `课程提纲经过 AI 辅助整理，请以原 ${sourceLabel} 核对。` : `课程提纲依据 ${sourceLabel} 目录生成，尚未经过 AI 完善。`,
  ].join("\n\n");
  const route = draft.stages.map((stage) => `### ${heading(stage.title)}\n${stage.tasks.map((task) => `- [ ] ${cleanLine(task)}`).join("\n")}`).join("\n\n");
  const keyPoints = draft.notes.length
    ? draft.notes.map((note) => `### ${heading(note.title)}\n\n来源：原 ${sourceLabel} ${positionLabel(draft.sourceFormat, note.page)}。\n\n${cleanLine(note.content)}`).join("\n\n")
    : `暂无可靠的原文摘录，请阅读 ${sourceLabel} 后补充。`;
  const scheduleRows = (draft.deadlines ?? []).map((item) => `| ${item.date} | ${tableCell(item.type)} | ${tableCell(item.title)} | 全课程 | 计划中 | 原 ${sourceLabel} ${positionLabel(draft.sourceFormat, item.page)} |`).join("\n");
  const resourceType = draft.sourceFormat === "docx" ? "DOCX" : /\.html?$/i.test(draft.originalFilename) ? "HTML" : draft.sourceFormat === "text" ? "TEXT" : "PDF";
  return {
    "course.md": `---\nid: ${courseId}\ntitle: ${yamlString(draft.title)}\nshortTitle: ${yamlString(draft.title.slice(0, 12))}\naccent: "#27624B"\nupdated: ${today}\norder: 999\narchived: false\n---\n\n# ${heading(draft.title)}\n\n## 课程概览\n\n${overview}\n\n## 学习路线\n\n${route}\n\n## 关键知识\n\n${keyPoints}\n\n## 易错点\n\n暂无个人易错点记录。\n\n## 学习记录\n\n| 日期 | 学习内容 | 掌握度 1-10 | 遇到困难 | 下一步 |\n| --- | --- | ---: | --- | --- |\n`,
    "notes.md": `${frontmatter}\n# ${heading(draft.title)}笔记\n\n${keyPoints.replace(/^### /gm, "## ")}\n`,
    "reviews.md": `${frontmatter}\n# 复习计划\n\n| 知识点 | 上次复习 | 下次复习 | 掌握度 1-10 | 复习证据 |\n| --- | --- | --- | ---: | --- |\n`,
    "resources.md": `${frontmatter}\n# 学习资源\n\n| 名称 | 类型 | URL 或本地路径 | 对应阶段 | 使用状态 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n| ${tableCell(draft.originalFilename)} | ${resourceType} | /api/courses/${courseId}/source | 全课程 | 使用中 | 原始导入文件 |\n`,
    "schedule.md": `${frontmatter}\n# 日程\n\n| 日期 | 类型 | 标题 | 对应阶段 | 状态 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n${scheduleRows}${scheduleRows ? "\n" : ""}`,
  };
}
