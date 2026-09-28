import { useState } from "react";

import type { CourseId, PracticeChoice, PracticeSessionCreated } from "../../shared/course.js";
import type { AnswerFeedback } from "../../server/ai-types.js";
import { answerPracticeSession, confirmPracticeSession, createPracticeSession } from "../api.js";

type Phase = "idle" | "creating" | "question" | "answering" | "feedback" | "confirming" | "saved";

export function PracticeFlow({ courseId, mistakeId, onSaved }: { courseId: CourseId; mistakeId: string; onSaved: () => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState<PracticeSessionCreated | null>(null);
  const [choice, setChoice] = useState<PracticeChoice | null>(null);
  const [feedback, setFeedback] = useState<AnswerFeedback | null>(null);
  const [error, setError] = useState("");

  async function start() {
    setError("");
    setPhase("creating");
    try {
      setSession(await createPracticeSession(courseId, mistakeId));
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
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("question");
    }
  }

  async function confirm() {
    if (phase !== "feedback" || !session) return;
    setError("");
    setPhase("confirming");
    try {
      await confirmPracticeSession(session.sessionId);
      setPhase("saved");
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("feedback");
    }
  }

  return (
    <div className="practice-flow">
      {phase === "idle" && <button type="button" className="btn btn--primary" onClick={start}>针对这道错题再练</button>}
      {phase === "creating" && <p role="status">正在生成针对性新题…</p>}
      {session && (phase === "question" || phase === "answering" || phase === "feedback" || phase === "confirming") && (
        <section aria-label="针对性练习">
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
          {feedback && (phase === "feedback" || phase === "confirming") && (
            <div className="practice-feedback">
              <p>{feedback.isCorrect ? "回答正确" : "回答错误"} · 得分：{feedback.score} / 100</p>
              <p>正确答案：{feedback.correctPart}</p>
              {feedback.gap && <p>{feedback.gap}</p>}
              <p>解析：{feedback.evidence}</p>
              <button type="button" className="btn btn--primary" disabled={phase === "confirming"} onClick={confirm}>{phase === "confirming" ? "正在保存…" : "确认保存练习"}</button>
            </div>
          )}
        </section>
      )}
      {phase === "saved" && <p className="practice-saved" role="status">{session?.mode === "mock" ? "Mock · 演示练习已保存；这不代表真实掌握。" : "练习记录已保存。"}</p>}
      {error && <p className="inline-warning" role="alert">{error}</p>}
    </div>
  );
}
