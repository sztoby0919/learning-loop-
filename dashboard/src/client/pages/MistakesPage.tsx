import { ArrowLeft } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import type { CourseId, MistakeItem, PracticeAttempt } from "../../shared/course.js";
import { fetchMistakes } from "../api.js";
import { AppShell } from "../components/AppShell.js";
import { PracticeFlow } from "../components/PracticeFlow.js";

function AttemptHistory({ attempts, label = "再练历史" }: { attempts: PracticeAttempt[]; label?: string }) {
  return <section aria-label={label}>
    <h3>{label}</h3>
    <ol>{attempts.map((attempt) => <li key={attempt.id}>
      <p><time dateTime={attempt.date}>{attempt.date}</time> · {attempt.isCorrect ? "答对" : "答错"} · {attempt.mode === "real" ? "真实作答" : attempt.mode === "mock" ? "Mock · 离线演示，不代表真实掌握" : "来源模式未知"}</p>
      <h4>{attempt.question}</h4>
      <p>你的选择：{attempt.selected}</p><p>正确答案：{attempt.correct}</p><p>解析：{attempt.explanation}</p>
    </li>)}</ol>
  </section>;
}

export function MistakesPage({ courseId }: { courseId: CourseId }) {
  const [items, setItems] = useState<MistakeItem[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [unassociatedAttempts, setUnassociatedAttempts] = useState<PracticeAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadedCourseId, setLoadedCourseId] = useState(courseId);
  const [connection, setConnection] = useState<"connecting" | "live" | "warning">("connecting");
  const currentCourseId = useRef(courseId);
  const requestVersion = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  currentCourseId.current = courseId;

  const load = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const version = ++requestVersion.current;
    const isCurrent = () => !controller.signal.aborted && version === requestVersion.current && currentCourseId.current === courseId;
    try {
      const result = await fetchMistakes(courseId, controller.signal);
      if (!isCurrent()) return;
      setItems(result.items);
      setUnassociatedAttempts(result.unassociatedAttempts ?? []);
      setWarnings(result.warnings);
      setError("");
    } catch (cause) {
      if (!isCurrent()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent()) {
        setLoadedCourseId(courseId);
        setLoading(false);
      }
    }
  }, [courseId]);

  useEffect(() => {
    setLoading(true);
    void load();
    return () => {
      requestVersion.current += 1;
      activeRequest.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    const events = new EventSource("/api/events");
    const refresh = (event: MessageEvent<string>) => {
      try {
        if ((JSON.parse(event.data) as { courseId?: string }).courseId === courseId) void load();
      } catch { /* Ignore malformed events and keep the current list. */ }
    };
    events.addEventListener("journal-updated", refresh as EventListener);
    events.addEventListener("journal-warning", refresh as EventListener);
    events.onopen = () => setConnection("live");
    events.onerror = () => setConnection("warning");
    return () => events.close();
  }, [courseId, load]);

  const showingLoading = loading || loadedCourseId !== courseId;

  return <AppShell connection={connection}>
    <div className="mistakes-page">
      <Link className="back-link" to={`/courses/${courseId}`}><ArrowLeft size={18} aria-hidden="true" />返回课程</Link>
      <header className="page-header"><h1>错题本</h1><p>仅收录已确认的错误作答；再练会生成一道同知识点的新题。</p></header>
      {showingLoading && <p role="status">正在读取错题…</p>}
      {!showingLoading && error && <div className="page-error" role="alert">读取错题失败：{error}</div>}
      {!showingLoading && !error && <>
        {warnings.map((warning) => <p className="inline-warning" role="status" key={warning}>{warning}</p>)}
        {items.length === 0 ? <p className="empty-copy">暂无已确认的错题。完成诊断并确认保存后，错题会出现在这里。</p> : (
          <ol className="mistakes-list">
            {items.map((item) => <li className="mistake-card" key={item.id}>
              <div className="mistake-card__meta"><time dateTime={item.date}>{item.date}</time><span>{item.knowledgePoint ?? "未标注知识点"}</span>{item.mode === "mock" && <span className="practice-mode">Mock · 演示记录，不代表真实掌握</span>}</div>
              {item.mode === "unknown" && <p>来源模式未知</p>}
              {item.unassociated && <p>历史再练：来源未关联</p>}
              <h2>{item.question}</h2>
              <p>你的选择：{item.selected}</p>
              <p>正确答案：{item.correct}</p>
              <p>解析：{item.explanation}</p>
              {Boolean(item.attempts?.length) && <AttemptHistory attempts={item.attempts!} />}
              <PracticeFlow courseId={courseId} mistakeId={item.id} onSaved={() => void load()} />
            </li>)}
          </ol>
        )}
        {unassociatedAttempts.length > 0 && <AttemptHistory attempts={unassociatedAttempts} label="历史再练：来源未关联" />}
      </>}
    </div>
  </AppShell>;
}
