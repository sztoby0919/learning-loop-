import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";

import type { PracticeSessionCreated, PracticeSessionConfirmed } from "../shared/course.js";
import type { AiService } from "./ai-service.js";
import type { AnswerFeedback, AssessmentQuestion, PublicAssessmentQuestion } from "./ai-types.js";
import { validateAssessmentQuestions } from "./ai-validators.js";
import { AssessmentError } from "./assessment-manager.js";
import { batchAtomicWrite, safeReadFile } from "./file-utils.js";
import { AiResponseFormatError } from "./openai-compatible-provider.js";
import { AiRequestError } from "./ai-request.js";
import { readMistakes, readReviewStreak, renderAttemptSession } from "./session-records.js";
import { prepareReviewUpdate, ReviewUpdateConflict } from "./review-completion.js";
import { parseReviewsMarkdown } from "./artifact-parser.js";
import { scheduleReviewsForCourse } from "./review-scheduler.js";
import type { WorkspaceRepository } from "./workspace-repository.js";

type Choice = "A" | "B" | "C" | "D";
const SESSION_LIFETIME_MS = 30 * 60 * 1000;
const publicQuestion = ({ id, question, options, knowledgePoint }: AssessmentQuestion): PublicAssessmentQuestion => ({ id, question, options, knowledgePoint });
const normalizeQuestion = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
const normalizeOption = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
// Only explicit answer declarations paired with a standalone A-D choice count as hints.
const answerCuePatterns = [
  /(?:正确\s*(?:的\s*)?(?:答案|选项)|(?:参考|标准)\s*答案)\s*(?:是|为)?\s*[:=]?\s*(?:选项\s*)?[A-D](?![\p{L}\p{N}])/giu,
  /答案\s*(?:是|为|[:=])\s*[:=]?\s*(?:选项\s*)?[A-D](?![\p{L}\p{N}])/giu,
  /(?:应|该|请)\s*选\s*[A-D](?![\p{L}\p{N}])/giu,
  /[A-D]\s*(?:选项|项)\s*(?:是|为)?\s*正确(?:答案)?/giu,
  /\b(?:correct answer|answer key)\s*(?::|=|is)?\s*[A-D]\b/giu,
  /\banswer\s*(?::|=|is)\s*[A-D]\b/giu,
];
// A choice followed immediately by a question particle, question mark, or a
// second alternative ending in a question mark is being asked about, not given.
const unansweredChoiceSuffix = /^\s*(?:(?:还是|或(?:者)?)\s*[A-D]\s*[?？]|(?:吗|么|呢)\s*[?？]?|[?？])/iu;
const hasAnswerCue = (question: AssessmentQuestion) => {
  const publicText = [question.question, ...question.options, question.knowledgePoint];
  const declaredChoice = publicText.some((text) => {
    const normalized = text.normalize("NFKC").replace(/[()\[\]【】]/gu, " ");
    return answerCuePatterns.some((pattern) => [...normalized.matchAll(pattern)].some((match) =>
      !unansweredChoiceSuffix.test(normalized.slice((match.index ?? 0) + match[0].length))));
  });
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
  kind: "targeted-practice" | "review-attempt";
  mistakeId?: string;
  review?: { topic: string; raw: string | null; hash: string | null };
}

export class PracticeManager {
  private readonly sessions = new Map<string, PracticeSession>();
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: WorkspaceRepository,
    private readonly aiService: AiService,
    private readonly today: () => string,
    private readonly mode: "real" | "mock" = "mock",
    private readonly now: () => number = Date.now,
  ) {}

  async create(params: { courseId: string; mistakeId: string; kind: "targeted-practice" } | { courseId: string; topic: string; kind: "review-attempt" }): Promise<PracticeSessionCreated> {
    if (params.kind !== "targeted-practice" && params.kind !== "review-attempt") throw new AssessmentError("练习类型无效", 400);
    const configured = this.repository.config.courses.find((course) => course.id === params.courseId);
    if (!configured) throw new AssessmentError("未知课程", 404);
    const course = await this.repository.getCourse(params.courseId);
    if (!course) throw new AssessmentError("课程档案不可用", 409);
    let sourceQuestion: string | undefined;
    let topic: string;
    let review: PracticeSession["review"];
    const contextParts = [`课程关键知识：\n${course.keyPointsMarkdown.slice(0, 12_000)}`];
    if (params.kind === "targeted-practice") {
      const { items } = await readMistakes(configured.root, configured.id);
      const mistake = items.find((item) => item.id === params.mistakeId);
      if (!mistake) throw new AssessmentError("错题不存在或尚未确认", 404);
      sourceQuestion = mistake.question;
      topic = mistake.knowledgePoint ?? "";
      contextParts.push(
        `原错题：${mistake.question}`,
        `知识点：${mistake.knowledgePoint ?? "未标注"}`,
        `上次选择：${mistake.selected}`,
        `正确答案：${mistake.correct}`,
        `解析：${mistake.explanation}`,
        "请围绕同一知识点生成一道不同于原错题的新四选一单选题，不要复用原题题干。",
      );
    } else {
      topic = params.topic.trim();
      if (!topic) throw new AssessmentError("复习主题无效", 400);
      const reviewsPath = path.join(configured.root, "reviews.md");
      try {
        const details = await lstat(reviewsPath);
        if (!details.isFile() || details.isSymbolicLink()) throw new AssessmentError("复习计划不是普通文件", 409);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const raw = await safeReadFile(reviewsPath);
      const explicit = raw === null ? [] : parseReviewsMarkdown(raw, reviewsPath, this.today()).items;
      const registered = explicit.some((item) => item.topic === topic) || scheduleReviewsForCourse(course, this.today()).some((item) => item.topic === topic);
      if (!registered) throw new AssessmentError("复习主题不存在或尚未登记", 404);
      review = { topic, raw, hash: raw === null ? null : createHash("sha256").update(raw).digest("hex") };
      contextParts.push(`复习知识点：${topic}`, "请围绕该知识点生成一道四选一单选复习题，知识点字段必须与复习知识点完全一致。");
    }
    const context = contextParts.join("\n");
    let instructions = `只生成一道简洁的四选一单选题，explanation 控制在 160 字以内。knowledgePoint 必须原样填写为 ${JSON.stringify(topic || course.title)}。${sourceQuestion ? `题干不得复用原题 ${JSON.stringify(sourceQuestion)}，请换用新情境。` : ""}`;
    let generated: AssessmentQuestion[];
    for (let attempt = 0; ; attempt++) {
      try {
        generated = await this.aiService.generateAssessmentQuestions({
          courseId: params.courseId,
          topic: topic || course.title,
          count: 1,
          context,
          instructions,
        });
        if (
          !validateAssessmentQuestions(generated).success
          || generated.length !== 1
          || !generated[0].question.trim()
          || !generated[0].explanation.trim()
          || !generated[0].knowledgePoint.trim()
          || new Set(generated[0].options.map(normalizeOption)).size !== 4
          || hasAnswerCue(generated[0])
        ) {
          throw new AssessmentError("模型生成的练习题格式无效、选项重复或泄露答案，请重试", 502);
        }
        if (topic && normalizeQuestion(generated[0].knowledgePoint) !== normalizeQuestion(topic))
          throw new AssessmentError(`生成题目的知识点与${params.kind === "review-attempt" ? "复习主题" : "原错题"}不一致，请重试`, 502);
        if (sourceQuestion && normalizeQuestion(generated[0].question) === normalizeQuestion(sourceQuestion))
          throw new AssessmentError("模型生成的练习题与原题相同，请重试", 502);
        break;
      } catch (error) {
        if (params.kind === "review-attempt" && attempt < 2 && (error instanceof AssessmentError && error.status === 502 || error instanceof AiResponseFormatError && error.retryable)) {
          instructions += `\n上次输出未通过校验：${error.message}。请针对该原因重新生成，不要重复上次的输出。`;
          continue;
        }
        if (error instanceof AssessmentError || error instanceof AiResponseFormatError || error instanceof AiRequestError) throw error;
        throw new AssessmentError("生成练习题失败，请稍后重试", 502);
      }
    }
    const question = this.mode === "mock"
      ? { ...generated[0], question: `【离线演示】${generated[0].question}` }
      : generated[0];
    const id = randomUUID();
    this.sessions.set(id, { id, courseId: params.courseId, question, createdAt: this.now(), confirmed: false, confirming: false, kind: params.kind, review, mistakeId: params.kind === "targeted-practice" ? params.mistakeId : undefined });
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
    const previousWrite = this.pendingWrites.get(configured.root);
    let releaseWrite!: () => void;
    const currentWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
    this.pendingWrites.set(configured.root, currentWrite);
    await previousWrite;
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
        kind: session.kind, courseId: session.courseId, confirmedAt, mode: this.mode,
        mistakeId: session.mistakeId,
        ...(session.review ? { completedAt: new Date(this.now()).toISOString() } : {}),
        question: {
          question: session.question.question, options: session.question.options,
          selected: session.choice, correct: session.question.answer as Choice,
          explanation: session.question.explanation, knowledgePoint: session.review?.topic ?? session.question.knowledgePoint,
        },
      });
      const operations: Parameters<typeof batchAtomicWrite>[0] = [{ filePath, content, expectedHash: null }];
      const advanced = Boolean(session.review && this.mode === "real");
      if (session.review && advanced) {
        const priorConsecutiveCorrectReviews = await readReviewStreak(configured.root, session.courseId, session.review.topic, confirmedAt);
        const isCorrect = session.choice === session.question.answer;
        try {
          operations.push({ filePath: path.join(configured.root, "reviews.md"), expectedHash: session.review.hash, content: prepareReviewUpdate(session.review.raw, {
            courseId: session.courseId, topic: session.review.topic, date: confirmedAt, isCorrect, priorConsecutiveCorrectReviews,
            evidence: `${isCorrect ? "答对" : "答错"} · ${isCorrect ? 100 : 0}/100 · sessions/${fileName}`,
          }) });
        } catch (error) {
          if (error instanceof ReviewUpdateConflict) throw new AssessmentError(error.message, 409);
          throw error;
        }
      }
      const result = await batchAtomicWrite(operations);
      if (!result.success) throw new AssessmentError(result.error ?? "保存练习失败", result.conflict ? 409 : 500);
      session.confirmed = true;
      return { courseId: session.courseId, mode: this.mode, sessionFile: fileName, ...(session.review ? { advanced } : {}) };
    } finally {
      releaseWrite();
      if (this.pendingWrites.get(configured.root) === currentWrite) this.pendingWrites.delete(configured.root);
      session.confirming = false;
    }
  }
}
