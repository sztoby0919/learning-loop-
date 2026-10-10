import { useState } from "react";

import type { CourseDetail } from "../../shared/course.js";
import type { AnswerFeedback, DiagnosisResult, PublicAssessmentQuestion } from "../../server/ai-types.js";
import { DiffPreview, type FileChange } from "../components/DiffPreview.js";

type Phase = "intro" | "loading" | "question" | "feedback" | "report" | "applying" | "applied" | "error";

async function api<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error ?? `请求失败 (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function CourseCoachPage({ course, onComplete }: { course: CourseDetail; onComplete: (result: DiagnosisResult) => void }) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [assessmentId, setAssessmentId] = useState("");
  const [question, setQuestion] = useState<PublicAssessmentQuestion | null>(null);
  const [nextQuestion, setNextQuestion] = useState<PublicAssessmentQuestion | null>(null);
  const [total, setTotal] = useState(0);
  const [answered, setAnswered] = useState(0);
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<AnswerFeedback | null>(null);
  const [diagnosis, setDiagnosis] = useState<DiagnosisResult | null>(null);
  const [files, setFiles] = useState<FileChange[]>([]);
  const [error, setError] = useState("");
  const [canRetryReport, setCanRetryReport] = useState(false);

  const fail = (cause: unknown) => { setError(cause instanceof Error ? cause.message : "未知错误"); setPhase("error"); };

  async function start() {
    setCanRetryReport(false);
    setPhase("loading");
    try {
      const result = await api<{ assessmentId: string; total: number; question: PublicAssessmentQuestion }>("/api/ai/assessments", { courseId: course.id });
      setAssessmentId(result.assessmentId); setTotal(result.total); setAnswered(0); setQuestion(result.question); setAnswer(""); setPhase("question");
    } catch (cause) { fail(cause); }
  }

  async function submit() {
    if (!question || !answer.trim()) return;
    setPhase("loading");
    try {
      const result = await api<{ feedback: AnswerFeedback; nextQuestion: PublicAssessmentQuestion | null; answered: number }>(`/api/ai/assessments/${assessmentId}/answers`, { questionId: question.id, answer });
      setFeedback(result.feedback); setNextQuestion(result.nextQuestion); setAnswered(result.answered); setPhase("feedback");
    } catch (cause) { fail(cause); }
  }

  async function showReport() {
    if (nextQuestion) { setQuestion(nextQuestion); setAnswer(""); setFeedback(null); setPhase("question"); return; }
    setPhase("loading");
    setCanRetryReport(true);
    try {
      const result = await api<{ diagnosis: DiagnosisResult; files: FileChange[] }>(`/api/ai/assessments/${assessmentId}/proposal`);
      setDiagnosis(result.diagnosis); setFiles(result.files); setPhase("report");
    } catch (cause) { fail(cause); }
  }

  async function apply() {
    setCanRetryReport(false);
    setPhase("applying");
    try {
      await api(`/api/ai/assessments/${assessmentId}/apply`, {});
      setPhase("applied");
      if (diagnosis) onComplete(diagnosis);
    } catch (cause) { fail(cause); }
  }

  if (phase === "intro") return <div className="coach-intro"><h2>学习诊断</h2><p>围绕《{course.title}》完成单选题。每题提交后会显示正确答案与解析，不能重新选择；全部完成后可查看补救建议。</p><button className="btn btn--primary" onClick={start}>开始诊断</button></div>;
  if (phase === "loading") return <p role="status">正在处理，请稍候…</p>;
  if (phase === "error") return <div role="alert"><p>{error}</p>{canRetryReport && <><p>本次作答已保留，可以重新生成报告。</p><button className="btn btn--primary" onClick={showReport}>重新生成报告</button></>}<button className="btn btn--secondary" onClick={() => setPhase("intro")}>重新开始</button></div>;
  if (phase === "question" && question) return <div className="coach-answering"><p>题目 {answered + 1} / {total} · {question.knowledgePoint}</p><h2>{question.question}</h2><fieldset className="coach-choices"><legend>选择一个答案</legend>{question.options.map((option, index) => { const letter = String.fromCharCode(65 + index); return <label className="coach-choice" key={letter}><input type="radio" name="coach-answer" value={letter} checked={answer === letter} onChange={() => setAnswer(letter)} /><span>{letter}. {option}</span></label>; })}</fieldset><button className="btn btn--primary" onClick={submit} disabled={!answer}>提交回答</button></div>;
  if (phase === "feedback" && feedback) return <div className="coach-feedback"><h2>第 {answered} 题反馈</h2><p>{feedback.isCorrect ? "回答正确" : "回答错误"} · 得分：{feedback.score} / 100</p><p>正确答案：{feedback.correctPart}</p>{feedback.gap && <p>{feedback.gap}</p>}<p>解析：{feedback.evidence}</p><button className="btn btn--primary" onClick={showReport}>{nextQuestion ? "下一题" : "查看诊断报告"}</button></div>;
  if ((phase === "report" || phase === "applying") && diagnosis) return <DiffPreview diagnosis={diagnosis} files={files} onConfirm={apply} onReject={() => setPhase("intro")} isApplying={phase === "applying"} />;
  if (phase === "applied") return <div className="coach-applied"><h2>诊断完成</h2><p>学习档案已更新。下次复习：{diagnosis?.nextReviewDate}</p><a href="/review" className="btn btn--primary">查看复习任务</a></div>;
  return null;
}
