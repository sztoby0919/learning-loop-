import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AiService } from "./ai-service.js";
import type { AnswerFeedback, AssessmentQuestion, DiagnosisResult, PublicAssessmentQuestion } from "./ai-types.js";
import { validateAssessmentQuestions, validateAnswerFeedback, validateDiagnosisResult } from "./ai-validators.js";
import { buildArchiveProposal, type ProposedFile } from "./archive-proposal.js";
import { batchAtomicWrite } from "./file-utils.js";
import type { WorkspaceRepository } from "./workspace-repository.js";

interface Assessment {
  id: string;
  courseId: string;
  questions: AssessmentQuestion[];
  answers: Array<{ question: AssessmentQuestion; answer: string; feedback: AnswerFeedback }>;
  diagnosis?: DiagnosisResult;
  files?: ProposedFile[];
  applied: boolean;
}

export class AssessmentError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const publicQuestion = ({ id, question, options, knowledgePoint }: AssessmentQuestion): PublicAssessmentQuestion => ({ id, question, options, knowledgePoint });

export class AssessmentManager {
  private readonly assessments = new Map<string, Assessment>();

  constructor(private readonly repository: WorkspaceRepository, private readonly aiService: AiService, private readonly today: () => string) {}

  async create(courseId: string) {
    const course = await this.repository.getCourse(courseId);
    if (!course) throw new AssessmentError("未知课程", 404);
    if (!course.keyPointsMarkdown.trim()) throw new AssessmentError("课程缺少关键知识内容", 400);
    const context = course.keyPointsMarkdown.slice(0, 12_000);
    const questions = await this.aiService.generateAssessmentQuestions({ courseId, topic: course.title, count: 5, context });
    if (!validateAssessmentQuestions(questions).success || new Set(questions.map((question) => question.id)).size !== questions.length) throw new AssessmentError("模型生成的题目无效", 502);
    const id = randomUUID();
    this.assessments.set(id, { id, courseId, questions, answers: [], applied: false });
    return { assessmentId: id, total: questions.length, question: publicQuestion(questions[0]) };
  }

  private get(id: string): Assessment {
    const assessment = this.assessments.get(id);
    if (!assessment) throw new AssessmentError("诊断会话不存在或服务已重启", 404);
    return assessment;
  }

  async answer(id: string, questionId: string, answer: string) {
    const assessment = this.get(id);
    const question = assessment.questions[assessment.answers.length];
    if (!question) throw new AssessmentError("诊断已完成", 409);
    if (question.id !== questionId) throw new AssessmentError("请按顺序回答当前题目", 409);
    if (!/^[A-D]$/.test(answer)) throw new AssessmentError("请选择 A、B、C 或 D 中的一个选项", 400);
    const isCorrect = answer === question.answer;
    const feedback: AnswerFeedback = {
      questionId: question.id,
      isCorrect,
      score: isCorrect ? 100 : 0,
      correctPart: `${question.answer}. ${question.options[question.answer.charCodeAt(0) - 65]}`,
      gap: isCorrect ? "" : `你选择了 ${answer}. ${question.options[answer.charCodeAt(0) - 65]}`,
      evidence: question.explanation,
    };
    assessment.answers.push({ question, answer, feedback });
    const next = assessment.questions[assessment.answers.length];
    return { feedback, nextQuestion: next ? publicQuestion(next) : null, completed: !next, answered: assessment.answers.length, total: assessment.questions.length };
  }

  async proposal(id: string) {
    const assessment = this.get(id);
    if (assessment.answers.length !== assessment.questions.length) throw new AssessmentError("请先完成所有题目", 409);
    if (!assessment.files) {
      const course = await this.repository.getCourse(assessment.courseId);
      const configured = this.repository.config.courses.find((item) => item.id === assessment.courseId);
      if (!course || !configured) throw new AssessmentError("课程档案不可用", 409);
      const courseMarkdown = await readFile(path.join(configured.root, "course.md"), "utf8");
      const reviewsMarkdown = await readFile(path.join(configured.root, "reviews.md"), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      assessment.diagnosis = await this.aiService.generateDiagnosis({ courseId: assessment.courseId, answers: assessment.answers, learningRecords: course.records });
      if (!validateDiagnosisResult(assessment.diagnosis).success || assessment.diagnosis.courseId !== assessment.courseId) {
        assessment.diagnosis = undefined;
        throw new AssessmentError("模型返回的诊断结果无效", 502);
      }
      assessment.files = buildArchiveProposal({ courseRoot: configured.root, assessmentId: id, courseMarkdown, reviewsMarkdown, diagnosis: assessment.diagnosis, answers: assessment.answers.map(({ question, answer, feedback }) => ({ question: question.question, answer: `${answer}. ${question.options[answer.charCodeAt(0) - 65]}`, correctAnswer: feedback.correctPart, explanation: feedback.evidence, score: feedback.score, gap: feedback.gap })), today: this.today() });
    }
    return { diagnosis: assessment.diagnosis!, files: assessment.files.map(({ name, before, after }) => ({ name, before, after })) };
  }

  async apply(id: string) {
    const assessment = this.get(id);
    if (assessment.applied) throw new AssessmentError("诊断已经写入", 409);
    if (!assessment.files) throw new AssessmentError("请先预览修改", 409);
    const result = await batchAtomicWrite(assessment.files.map(({ filePath, after, expectedHash }) => ({ filePath, content: after, expectedHash })));
    if (!result.success) throw new AssessmentError(result.error ?? "写入失败", result.conflict ? 409 : 500);
    assessment.applied = true;
    return { courseId: assessment.courseId, weakPointsApplied: assessment.diagnosis?.weakPoints.length ?? 0 };
  }
}
