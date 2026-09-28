import { ArrowLeft } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { CourseId, MistakeItem } from "../../shared/course.js";
import { fetchMistakes } from "../api.js";
import { AppShell } from "../components/AppShell.js";
import { PracticeFlow } from "../components/PracticeFlow.js";

export function MistakesPage({ courseId }: { courseId: CourseId }) {
  const [items, setItems] = useState<MistakeItem[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<"connecting" | "live" | "warning">("connecting");

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await fetchMistakes(courseId, signal);
      setItems(result.items);
      setWarnings(result.warnings);
      setError("");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    setLoading(true);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
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

  return <AppShell connection={connection}>
    <div className="mistakes-page">
      <Link className="back-link" to={`/courses/${courseId}`}><ArrowLeft size={18} aria-hidden="true" />返回课程</Link>
      <header className="page-header"><h1>错题本</h1><p>仅收录已确认的错误作答；再练会生成一道同知识点的新题。</p></header>
      {loading && <p role="status">正在读取错题…</p>}
      {error && <div className="page-error" role="alert">读取错题失败：{error}</div>}
      {!loading && !error && <>
        {warnings.map((warning) => <p className="inline-warning" role="status" key={warning}>{warning}</p>)}
        {items.length === 0 ? <p className="empty-copy">暂无已确认的错题。完成诊断并确认保存后，错题会出现在这里。</p> : (
          <ol className="mistakes-list">
            {items.map((item) => <li className="mistake-card" key={item.id}>
              <div className="mistake-card__meta"><time dateTime={item.date}>{item.date}</time><span>{item.knowledgePoint ?? "未标注知识点"}</span>{item.mode === "mock" && <span className="practice-mode">Mock · 演示记录，不代表真实掌握</span>}</div>
              <h2>{item.question}</h2>
              <p>你的选择：{item.selected}</p>
              <p>正确答案：{item.correct}</p>
              <p>解析：{item.explanation}</p>
              <PracticeFlow courseId={courseId} mistakeId={item.id} onSaved={() => void load()} />
            </li>)}
          </ol>
        )}
      </>}
    </div>
  </AppShell>;
}
