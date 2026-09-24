// 学习诊断页面组件
// 逐题展示、作答、反馈，最后生成诊断报告

import { useState, useCallback } from "react";
import type { CourseDetail } from "../../shared/course.js";
import type { AssessmentQuestion, AnswerFeedback, DiagnosisResult } from "../../server/ai-types.js";
import { DiffPreview } from "../components/DiffPreview.js";

interface CourseCoachPageProps {
  course: CourseDetail;
  onComplete: (result: DiagnosisResult) => void;
}

type CoachState =
  | { phase: "intro" }
  | { phase: "loading_questions" }
  | { phase: "answering"; questions: AssessmentQuestion[]; currentIndex: number; answers: Array<{ question: AssessmentQuestion; answer: string; feedback: AnswerFeedback }> }
  | { phase: "diagnosing" }
  | { phase: "review"; diagnosis: DiagnosisResult; answers: Array<{ question: AssessmentQuestion; answer: string; feedback: AnswerFeedback }> }
  | { phase: "applied"; diagnosis: DiagnosisResult }
  | { phase: "error"; message: string };

export function CourseCoachPage({ course, onComplete }: CourseCoachPageProps) {
  const [state, setState] = useState<CoachState>({ phase: "intro" });

  const startDiagnosis = useCallback(async () => {
    setState({ phase: "loading_questions" });
    try {
      // 调用 API 创建诊断
      const response = await fetch("/api/ai/assessments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId: course.id,
          topic: course.title,
          count: 5,
          difficulty: "medium",
          context: course.keyPointsMarkdown,
        }),
      });
      if (!response.ok) throw new Error("创建诊断失败");
      const data = await response.json();
      setState({
        phase: "answering",
        questions: data.questions,
        currentIndex: 0,
        answers: [],
      });
    } catch (error) {
      setState({ phase: "error", message: error instanceof Error ? error.message : "未知错误" });
    }
  }, [course]);

  const submitAnswer = useCallback(async (answer: string) => {
    if (state.phase !== "answering") return;
    const currentQuestion = state.questions[state.currentIndex];
    try {
      const response = await fetch(`/api/ai/assessments/${currentQuestion.id}/answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionId: currentQuestion.id,
          answer,
          context: course.keyPointsMarkdown,
        }),
      });
      if (!response.ok) throw new Error("提交答案失败");
      const feedback: AnswerFeedback = await response.json();

      const newAnswers = [...state.answers, { question: currentQuestion, answer, feedback }];
      const nextIndex = state.currentIndex + 1;

      if (nextIndex >= state.questions.length) {
        // 所有题目作答完成，开始诊断
        setState({ phase: "diagnosing" });
        const diagResponse = await fetch(`/api/ai/assessments/${course.id}/diagnosis`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            courseId: course.id,
            answers: newAnswers,
            learningRecords: course.records,
          }),
        });
        if (!diagResponse.ok) throw new Error("生成诊断结果失败");
        const diagnosis: DiagnosisResult = await diagResponse.json();
        setState({ phase: "review", diagnosis, answers: newAnswers });
      } else {
        setState({
          phase: "answering",
          questions: state.questions,
          currentIndex: nextIndex,
          answers: newAnswers,
        });
      }
    } catch (error) {
      setState({ phase: "error", message: error instanceof Error ? error.message : "未知错误" });
    }
  }, [state, course]);

  const applyDiagnosis = useCallback(async () => {
    if (state.phase !== "review") return;
    try {
      const response = await fetch(`/api/ai/assessments/${course.id}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId: course.id,
          diagnosis: state.diagnosis,
        }),
      });
      if (!response.ok) throw new Error("应用修改失败");
      setState({ phase: "applied", diagnosis: state.diagnosis });
      onComplete(state.diagnosis);
    } catch (error) {
      setState({ phase: "error", message: error instanceof Error ? error.message : "未知错误" });
    }
  }, [state, course, onComplete]);

  const rejectDiagnosis = useCallback(() => {
    setState({ phase: "intro" });
  }, []);

  // 渲染不同阶段
  switch (state.phase) {
    case "intro":
      return (
        <div className="coach-intro">
          <h2>学习诊断</h2>
          <p>通过作答来发现你的知识漏洞，AI 会生成针对性的补救方案。</p>
          <div className="coach-intro__info">
            <p>📋 课程：{course.title}</p>
            <p>📝 将生成 5 道简答题</p>
            <p>⏱️ 预计耗时 5-10 分钟</p>
          </div>
          <button className="btn btn--primary" onClick={startDiagnosis}>
            开始诊断
          </button>
        </div>
      );

    case "loading_questions":
      return (
        <div className="coach-loading">
          <div className="spinner" aria-hidden="true" />
          <p>AI 正在生成诊断题目...</p>
        </div>
      );

    case "answering": {
      const currentQuestion = state.questions[state.currentIndex];
      return (
        <div className="coach-answering">
          <div className="coach-progress">
            题目 {state.currentIndex + 1} / {state.questions.length}
          </div>
          <h3>{currentQuestion.question}</h3>
          <div className="coach-options">
            {currentQuestion.options.map((option, index) => (
              <button
                key={index}
                className="coach-option"
                onClick={() => submitAnswer(option)}
              >
                {option}
              </button>
            ))}
          </div>
          {state.answers.length > 0 && (
            <div className="coach-previous-feedback">
              <p>上一题反馈：{state.answers[state.answers.length - 1].feedback.evidence}</p>
            </div>
          )}
        </div>
      );
    }

    case "diagnosing":
      return (
        <div className="coach-loading">
          <div className="spinner" aria-hidden="true" />
          <p>AI 正在分析你的作答...</p>
        </div>
      );

    case "review":
      return (
        <DiffPreview
          diagnosis={state.diagnosis}
          onConfirm={applyDiagnosis}
          onReject={rejectDiagnosis}
          isApplying={false}
        />
      );

    case "applied":
      return (
        <div className="coach-applied">
          <h3>诊断完成！</h3>
          <p>已将 {state.diagnosis.weakPoints.length} 个薄弱点记录到学习档案。</p>
          <p>下次复习时间：{state.diagnosis.nextReviewDate}</p>
          <button className="btn btn--primary" onClick={() => setState({ phase: "intro" })}>
            返回
          </button>
        </div>
      );

    case "error":
      return (
        <div className="coach-error" role="alert">
          <p>出错了：{state.message}</p>
          <button className="btn btn--secondary" onClick={() => setState({ phase: "intro" })}>
            重试
          </button>
        </div>
      );
  }
}
