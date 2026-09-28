import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";

import type { PracticeSessionCreated, PracticeSessionConfirmed } from "../shared/course.js";
import type { AiService } from "./ai-service.js";
import type { AnswerFeedback, AssessmentQuestion, PublicAssessmentQuestion } from "./ai-types.js";
import { validateAssessmentQuestions } from "./ai-validators.js";
import { AssessmentError } from "./assessment-manager.js";
import { batchAtomicWrite } from "./file-utils.js";
import { AiResponseFormatError } from "./openai-compatible-provider.js";
import { readMistakes, renderAttemptSession } from "./session-records.js";
import type { WorkspaceRepository } from "./workspace-repository.js";

type Choice = "A" | "B" | "C" | "D";
const SESSION_LIFETIME_MS = 30 * 60 * 1000;
const publicQuestion = ({ id, question, options, knowledgePoint }: AssessmentQuestion): PublicAssessmentQuestion => ({ id, question, options, knowledgePoint });
const normalizeQuestion = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
const normalizeOption = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
// Only explicit answer declarations paired with a standalone A-D choice count as hints.
// Wording such as “正确答案是什么” or “分析选项 B 是否正确” remains a valid question.
const answerCuePatterns = [
  /(?:正确|参考|标准)答案\s*(?:是|为)?\s*[:=]?\s*(?:选项)?[A-D](?![\p{L}\p{N}])/iu,
  /答案\s*(?:是|为|[:=])\s*[:=]?\s*(?:选项)?[A-D](?![\p{L}\p{N}])/iu,
  /(?:应|该|请)\s*选\s*[A-D](?![\p{L}\p{N}])/iu,
  /[A-D]\s*(?:选项|项)\s*(?:是|为)?\s*正确(?:答案)?/iu,
  /\b(?:correct answer|answer key)\s*(?::|=|is)?\s*[A-D]\b/iu,
  /\banswer\s*(?::|=|is)\s*[A-D]\b/iu,
];
const hasAnswerCue = (question: AssessmentQuestion) => {
  const publicText = [question.question, ...question.options, question.knowledgePoint];
  const declaredChoice = publicText.some((text) => answerCuePatterns.some((pattern) =>
    pattern.test(text.normalize("NFKC").replace(/[()\[\]【】]/gu, " "))));
  const markedOption = question.options.some((option) =>
    /(?:\(|\[|【)\s*(?:正确答案|正确|correct)\s*(?:\)|\]|】)\s*$/iu.test(option.normalize("NFKC")));
  return declaredChoice || markedOption;
};

interface PracticeSession {
  id: string;
  courseId: string;
  question: AssessmentQuestion;
  createdAt: number;
  choice?: Choice;
  confirmed: boolean;
  confirming: boolean;
}

export class PracticeManager {
  private readonly sessions = new Map<string, PracticeSession>();

  constructor(
    private readonly repository: WorkspaceRepository,
    private readonly aiService: AiService,
    private readonly today: () => string,
    private readonly mode: "real" | "mock" = "mock",
    private readonly now: () => number = Date.now,
  ) {}

  async create(params: { courseId: string; mistakeId: string; kind: "targeted-practice" }): Promise<PracticeSessionCreated> {
    if (params.kind !== "targeted-practice") throw new AssessmentError("练习类型无效", 400);
    const configured = this.repository.config.courses.find((course) => course.id === params.courseId);
    if (!configured) throw new AssessmentError("未知课程", 404);
    const course = await this.repository.getCourse(params.courseId);
    if (!course) throw new AssessmentError("课程档案不可用", 409);
    const { items } = await readMistakes(configured.root, configured.id);
    const mistake = items.find((item) => item.id === params.mistakeId);
    if (!mistake) throw new AssessmentError("错题不存在或尚未确认", 404);

    const context = [
      `课程关键知识：\n${course.keyPointsMarkdown.slice(0, 12_000)}`,
      `原错题：${mistake.question}`,
      `知识点：${mistake.knowledgePoint ?? "未标注"}`,
      `上次选择：${mistake.selected}`,
      `正确答案：${mistake.correct}`,
      `解析：${mistake.explanation}`,
      "请围绕同一知识点生成一道不同于原错题的新四选一单选题，不要复用原题题干。",
    ].join("\n");
    let generated: AssessmentQuestion[];
    try {
      generated = await this.aiService.generateAssessmentQuestions({
        courseId: params.courseId,
        topic: mistake.knowledgePoint ?? course.title,
        count: 1,
        context,
      });
    } catch (error) {
      if (error instanceof AiResponseFormatError) throw error;
      throw new AssessmentError("生成练习题失败，请稍后重试", 502);
    }
    if (
      !validateAssessmentQuestions(generated).success
      || generated.length !== 1
      || !generated[0].question.trim()
      || !generated[0].explanation.trim()
      || !generated[0].knowledgePoint.trim()
      || new Set(generated[0].options.map(normalizeOption)).size !== 4
      || normalizeQuestion(generated[0].question) === normalizeQuestion(mistake.question)
      || (mistake.knowledgePoint && normalizeQuestion(generated[0].knowledgePoint) !== normalizeQuestion(mistake.knowledgePoint))
      || hasAnswerCue(generated[0])
    ) {
      throw new AssessmentError("模型生成的练习题无效或与原题相同，请重试", 502);
    }
    const question = this.mode === "mock"
      ? { ...generated[0], question: `【离线演示】${generated[0].question}` }
      : generated[0];
    const id = randomUUID();
    this.sessions.set(id, { id, courseId: params.courseId, question, createdAt: this.now(), confirmed: false, confirming: false });
    return { sessionId: id, question: publicQuestion(question), mode: this.mode };
  }

  private get(id: string): PracticeSession {
    const session = this.sessions.get(id);
    if (!session) throw new AssessmentError("练习会话不存在或服务已重启", 404);
    if (this.now() - session.createdAt >= SESSION_LIFETIME_MS) {
      this.sessions.delete(id);
      throw new AssessmentError("练习会话已过期，请重新生成", 404);
    }
    return session;
  }

  async answer(sessionId: string, questionId: string, choice: Choice): Promise<{ feedback: AnswerFeedback }> {
    const session = this.get(sessionId);
    if (session.choice || session.confirmed || session.confirming) throw new AssessmentError("练习已作答，不能再次选择", 409);
    if (session.question.id !== questionId) throw new AssessmentError("题目与练习会话不匹配", 409);
    if (!/^[A-D]$/.test(choice)) throw new AssessmentError("请选择 A、B、C 或 D 中的一个选项", 400);
    session.choice = choice;
    const correct = session.question.answer as Choice;
    const isCorrect = choice === correct;
    return { feedback: {
      questionId,
      isCorrect,
      score: isCorrect ? 100 : 0,
      correctPart: `${correct}. ${session.question.options[correct.charCodeAt(0) - 65]}`,
      gap: isCorrect ? "" : `你选择了 ${choice}. ${session.question.options[choice.charCodeAt(0) - 65]}`,
      evidence: session.question.explanation,
    } };
  }

  async confirm(sessionId: string): Promise<PracticeSessionConfirmed> {
    const session = this.get(sessionId);
    if (session.confirmed || session.confirming) throw new AssessmentError("练习已经保存", 409);
    if (!session.choice) throw new AssessmentError("请先完成练习", 409);
    const configured = this.repository.config.courses.find((course) => course.id === session.courseId);
    if (!configured) throw new AssessmentError("课程档案不可用", 409);
    session.confirming = true;
    try {
      const directory = path.join(configured.root, "sessions");
      try {
        const details = await lstat(directory);
        if (!details.isDirectory() || details.isSymbolicLink()) throw new AssessmentError("sessions 目录不可写", 409);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const confirmedAt = this.today();
      const fileName = `${confirmedAt}-${session.id}.md`;
      const filePath = path.join(directory, fileName);
      const content = renderAttemptSession({
        kind: "targeted-practice", courseId: session.courseId, confirmedAt, mode: this.mode,
        question: {
          question: session.question.question, options: session.question.options,
          selected: session.choice, correct: session.question.answer as Choice,
          explanation: session.question.explanation, knowledgePoint: session.question.knowledgePoint,
        },
      });
      const result = await batchAtomicWrite([{ filePath, content, expectedHash: null }]);
      if (!result.success) throw new AssessmentError(result.error ?? "保存练习失败", result.conflict ? 409 : 500);
      session.confirmed = true;
      return { courseId: session.courseId, mode: this.mode, sessionFile: fileName };
    } finally {
      session.confirming = false;
    }
  }
}
