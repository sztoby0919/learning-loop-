import { useEffect, useRef, useState } from "react";

import type { CourseId, PracticeChoice, PracticeSessionCreated } from "../../shared/course.js";
import type { AnswerFeedback } from "../../server/ai-types.js";
import { answerPracticeSession, confirmPracticeSession, createPracticeSession, createReviewSession } from "../api.js";

type Phase = "idle" | "creating" | "question" | "answering" | "unknown" | "feedback" | "confirming" | "saved";

type PracticeFlowProps = { courseId: CourseId; onSaved: () => void } & ({ mistakeId: string; topic?: never } | { topic: string; mistakeId?: never });

export function PracticeFlow({ courseId, mistakeId, topic, onSaved }: PracticeFlowProps) {
  const isReview = topic !== undefined;
  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState<PracticeSessionCreated | null>(null);
  const [choice, setChoice] = useState<PracticeChoice | null>(null);
  const [feedback, setFeedback] = useState<AnswerFeedback | null>(null);
  const [error, setError] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const feedbackElement = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (phase === "feedback") feedbackElement.current?.focus();
  }, [phase]);

  async function start() {
    setError("");
    setPhase("creating");
    try {
      setSession(await (topic !== undefined ? createReviewSession(courseId, topic) : createPracticeSession(courseId, mistakeId!)));
      setChoice(null);
      setFeedback(null);
      setPhase("question");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("idle");
    }
  }

  async function submit() {
    if (phase !== "question" || !session || !choice) return;
    setError("");
    setPhase("answering");
    try {
      const result = await answerPracticeSession(session.sessionId, session.question.id, choice);
      setFeedback(result.feedback);
      setPhase("feedback");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`提交结果未知：${message}。请重新生成新题；为避免重复作答，不能再次提交这道题。`);
      setPhase("unknown");
    }
  }

  async function confirm() {
    if (phase !== "feedback" || !session) return;
    setError("");
    setPhase("confirming");
    try {
      const result = await confirmPracticeSession(session.sessionId);
      setAdvanced(result.advanced === true);
      setPhase("saved");
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("feedback");
    }
  }

  return (
    <div className="practice-flow">
      {phase === "idle" && <button type="button" className="btn btn--primary" onClick={start}>{isReview ? "开始复习" : "针对这道错题再练"}</button>}
      {phase === "creating" && <p role="status">{isReview ? "正在生成复习题…" : "正在生成针对性新题…"}</p>}
      {session && (phase === "question" || phase === "answering" || phase === "unknown" || phase === "feedback" || phase === "confirming") && (
        <section aria-label={isReview ? "复习作答" : "针对性练习"}>
          {session.mode === "mock" && <p className="practice-mode" role="note">Mock · 离线演示题，不代表真实掌握</p>}
          <p className="practice-topic">知识点：{session.question.knowledgePoint}</p>
          <h3>{session.question.question}</h3>
          {(phase === "question" || phase === "answering") && (
            <>
              <fieldset className="coach-choices" disabled={phase === "answering"}>
                <legend>选择一个答案</legend>
                {session.question.options.map((option, index) => {
                  const letter = String.fromCharCode(65 + index) as PracticeChoice;
                  return <label className="coach-choice" key={letter}>
                    <input type="radio" name={`practice-${session.sessionId}`} value={letter} checked={choice === letter} onChange={() => setChoice(letter)} />
                    <span>{letter}. {option}</span>
                  </label>;
                })}
              </fieldset>
              <button type="button" className="btn btn--primary" disabled={!choice || phase === "answering"} onClick={submit}>提交回答</button>
            </>
          )}
          {phase === "unknown" && <button type="button" className="btn btn--primary" onClick={start}>重新生成新题</button>}
          {feedback && (phase === "feedback" || phase === "confirming") && (
            <div className="practice-feedback" role="status" aria-label="练习反馈" aria-live="polite" tabIndex={-1} ref={feedbackElement}>
              <p>{feedback.isCorrect ? "回答正确" : "回答错误"} · 得分：{feedback.score} / 100</p>
              <p>正确答案：{feedback.correctPart}</p>
              {feedback.gap && <p>{feedback.gap}</p>}
              <p>解析：{feedback.evidence}</p>
              {isReview && <p>{session.mode === "mock" ? "演示题只保存作答记录，不改变真实复习计划。" : "确认后保存本次作答，并根据作答结果更新该知识点的下次复习日期。"}</p>}
              <button type="button" className="btn btn--primary" disabled={phase === "confirming"} onClick={confirm}>{phase === "confirming" ? "正在保存…" : isReview ? session.mode === "mock" ? "保存演示作答（不推进复习）" : "确认保存并更新复习计划" : "确认保存练习"}</button>
            </div>
          )}
        </section>
      )}
      {phase === "saved" && <p className="practice-saved" role="status">{isReview ? session?.mode === "mock" ? "Mock · 演示作答已保存，复习计划未推进。" : advanced ? "复习作答已保存，复习计划已更新。" : "复习作答已保存，复习计划未推进。" : session?.mode === "mock" ? "Mock · 演示练习已保存；这不代表真实掌握。" : "练习记录已保存。"}</p>}
      {error && <p className="inline-warning" role="alert">{error}</p>}
    </div>
  );
}
