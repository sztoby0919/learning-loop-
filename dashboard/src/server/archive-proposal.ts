import { createHash } from "node:crypto";
import path from "node:path";

import type { DiagnosisResult } from "./ai-types.js";
import { parseReviewsMarkdown } from "./artifact-parser.js";

export interface ProposedFile {
  name: string;
  filePath: string;
  before: string | null;
  after: string;
  expectedHash: string | null;
}

export class ArchiveProposalError extends Error {}

const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const tableCell = (value: string) => value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();

export function buildArchiveProposal(params: {
  courseRoot: string;
  assessmentId: string;
  courseMarkdown: string;
  reviewsMarkdown: string | null;
  diagnosis: DiagnosisResult;
  answers: Array<{ question: string; options?: string[]; answer: string; score: number; gap: string; correctAnswer: string; explanation: string; knowledgePoint?: string }>;
  today: string;
  mode?: "real" | "mock";
}): ProposedFile[] {
  const { courseRoot, assessmentId, courseMarkdown, diagnosis, answers, today } = params;
  const tasks = diagnosis.remediationTasks.slice(0, 5).map((task) => `- [ ] ${task.replace(/[\r\n]+/g, " ").trim()}`).join("\n");
  const mistakes = diagnosis.weakPoints.slice(0, 5).map((point) => `- **${point.knowledgePoint.replace(/[\r\n]+/g, " ").trim()}**：${point.evidence.replace(/[\r\n]+/g, " ").trim()}`).join("\n");
  let courseAfter = courseMarkdown;
  if (tasks) courseAfter = courseAfter.replace(/(?=^## 关键知识\s*$)/m, `### AI 诊断补救 ${today}\n${tasks}\n\n`);
  if (mistakes) courseAfter = courseAfter.replace(/(?=^## 学习记录\s*$)/m, `${mistakes}\n\n`);
  if (courseAfter === courseMarkdown && (tasks || mistakes)) throw new ArchiveProposalError("课程档案缺少必要章节，无法生成安全修改");

  const baseReviews = params.reviewsMarkdown ?? `---\ncourseId: ${diagnosis.courseId}\nupdated: ${today}\n---\n# 复习计划\n\n| 知识点 | 上次复习 | 下次复习 | 掌握度 1-10 | 复习证据 |\n| --- | --- | --- | ---: | --- |\n`;
  const rows = diagnosis.weakPoints.slice(0, 5).map((point) => `| ${tableCell(point.knowledgePoint)} |  | ${diagnosis.nextReviewDate} |  | ${tableCell(point.evidence)} |`).join("\n");
  let reviewsAfter = baseReviews;
  if (rows) {
    const lines = baseReviews.split(/\r?\n/);
    const headerIndex = lines.findIndex((line) => /^\|\s*(?:知识点|主题)\s*\|/.test(line));
    if (headerIndex < 0 || !/^\|\s*[-: |]+\|\s*$/.test(lines[headerIndex + 1] ?? "")) {
      throw new ArchiveProposalError("复习计划缺少知识点或主题表格，无法安全插入复习项");
    }
    const topics = diagnosis.weakPoints.slice(0, 5).map((point) => point.knowledgePoint.trim());
    let existingTopics: string[];
    try {
      const parsed = parseReviewsMarkdown(baseReviews, "reviews.md", today);
      if (parsed.warnings.length || parsed.courseId !== diagnosis.courseId) throw new Error("复习计划格式或课程不匹配");
      existingTopics = parsed.items.map((item) => item.topic);
    } catch {
      throw new ArchiveProposalError("复习计划格式无效，无法安全插入复习项");
    }
    if (new Set(topics).size !== topics.length || topics.some((topic) => existingTopics.includes(topic))) {
      throw new ArchiveProposalError("复习计划含重复知识点，无法安全插入复习项");
    }
    let insertAt = headerIndex + 2;
    while (insertAt < lines.length && /^\|.*\|\s*$/.test(lines[insertAt])) insertAt++;
    lines.splice(insertAt, 0, ...rows.split("\n"));
    reviewsAfter = lines.join("\n");
  }
  const initialAverageScore = answers.length ? Math.round(answers.reduce((sum, item) => sum + item.score, 0) / answers.length) : 0;
  const singleLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
  const sessionAfter = `---\nkind: ai-assessment\ncourseId: ${diagnosis.courseId}\nupdated: ${today}\nmode: ${params.mode ?? "mock"}\ninitialAverageScore: ${initialAverageScore}\nfinalAverageScore: ${initialAverageScore}\nweakPointCount: ${diagnosis.weakPoints.length}\n---\n# 诊断记录 ${today}\n\n课程：${diagnosis.courseId}\n\n${answers.map((item, index) => `## 第 ${index + 1} 题\n\n问题：${singleLine(item.question)}${item.options ? `\n\n选项：${item.options.map((option, optionIndex) => `${String.fromCharCode(65 + optionIndex)}. ${singleLine(option)}`).join(" | ")}` : ""}${item.knowledgePoint ? `\n\n知识点：${singleLine(item.knowledgePoint)}` : ""}\n\n选择：${singleLine(item.answer)}\n\n得分：${item.score}/100\n\n正确答案：${singleLine(item.correctAnswer)}\n\n解析：${singleLine(item.explanation)}${item.gap ? `\n\n待改进：${singleLine(item.gap)}` : ""}`).join("\n\n")}\n\n## 补救任务\n\n${tasks || "暂无"}\n`;

  return [
    { name: "course.md", filePath: path.join(courseRoot, "course.md"), before: courseMarkdown, after: courseAfter, expectedHash: hash(courseMarkdown) },
    { name: "reviews.md", filePath: path.join(courseRoot, "reviews.md"), before: params.reviewsMarkdown, after: reviewsAfter, expectedHash: params.reviewsMarkdown === null ? null : hash(params.reviewsMarkdown) },
    { name: `sessions/${today}-${assessmentId}.md`, filePath: path.join(courseRoot, "sessions", `${today}-${assessmentId}.md`), before: null, after: sessionAfter, expectedHash: null },
  ];
}
