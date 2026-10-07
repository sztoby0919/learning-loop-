import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { CourseEditSnapshot } from "../../shared/course-management.js";
import { deleteCourse, fetchCourseEdit, saveCourseEdit } from "../api.js";
import { ImportNavigationGuard } from "./ImportNavigationGuard.js";

export function CourseManagementPanel({ courseId, title }: { courseId: string; title: string }) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<CourseEditSnapshot | null>(null);
  const [baseline, setBaseline] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const dirty = useRef(false);
  dirty.current = draft !== null && JSON.stringify(draft) !== baseline;
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard);
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const close = () => {
    if (dirty.current && !window.confirm("有未保存的课程编辑，确定放弃吗？")) return;
    setDraft(null); dirty.current = false;
  };
  const stageChange = (index: number, update: Partial<CourseEditSnapshot["stages"][number]>) => {
    setDraft((current) => current && ({ ...current, stages: current.stages.map((stage, i) => i === index ? { ...stage, ...update } : stage) }));
  };
  return <section className="course-management" aria-label="课程管理">
    <ImportNavigationGuard hasUnsavedChanges={() => dirty.current} />
    <div className="course-management__actions">
      <button className="btn" disabled={busy || draft !== null} onClick={() => void run(async () => { const snapshot = await fetchCourseEdit(courseId); setBaseline(JSON.stringify(snapshot)); setDraft(snapshot); })}>编辑课程</button>
      <button className="btn" disabled={busy || draft !== null} onClick={() => void run(async () => {
        const snapshot = await fetchCourseEdit(courseId);
        if (!window.confirm(`删除课程“${snapshot.title || title}”？\n课程将从应用中移除；本地课件、笔记、错题和学习记录会保留。`)) return;
        await deleteCourse(courseId, snapshot.expectedHash); navigate("/");
      })}>删除课程</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {draft && <form className="course-edit-form" onSubmit={(event) => { event.preventDefault(); void run(async () => {
      await saveCourseEdit(courseId, draft); setDraft(null); dirty.current = false; setMessage("课程已保存");
    }); }}>
      <h2>编辑课程</h2>
      <p>可修改名称、简介、学习阶段、任务及完成状态。笔记、错题和学习记录会保留。</p>
      <label>课程名称<input required maxLength={500} value={draft.title} disabled={busy} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
      <label>课程简介<textarea rows={4} maxLength={30000} value={draft.overviewMarkdown} disabled={busy} onChange={(event) => setDraft({ ...draft, overviewMarkdown: event.target.value })} /></label>
      {draft.stages.map((stage, index) => <fieldset key={index} disabled={busy}>
        <legend>阶段 {index + 1}</legend>
        <label>阶段名称<input required maxLength={500} value={stage.title} onChange={(event) => stageChange(index, { title: event.target.value })} /></label>
        {stage.tasks.map((task, taskIndex) => <div className="course-edit-task" key={taskIndex}>
          <label><input type="checkbox" aria-label={`任务 ${taskIndex + 1} 已完成`} checked={task.completed} onChange={(event) => stageChange(index, { tasks: stage.tasks.map((item, i) => i === taskIndex ? { ...item, completed: event.target.checked } : item) })} />已完成</label>
          <input aria-label={`阶段 ${index + 1} 任务 ${taskIndex + 1}`} required maxLength={500} value={task.text} onChange={(event) => stageChange(index, { tasks: stage.tasks.map((item, i) => i === taskIndex ? { ...item, text: event.target.value } : item) })} />
          <button type="button" className="btn" onClick={() => stageChange(index, { tasks: stage.tasks.filter((_, i) => i !== taskIndex) })}>移除任务</button>
        </div>)}
        <button type="button" className="btn" disabled={stage.tasks.length >= 300} onClick={() => stageChange(index, { tasks: [...stage.tasks, { text: "", completed: false }] })}>添加任务</button>
        <button type="button" className="btn" onClick={() => { if (window.confirm("移除该阶段及其任务？保存后生效。")) setDraft({ ...draft, stages: draft.stages.filter((_, i) => i !== index) }); }}>移除阶段</button>
      </fieldset>)}
      <div className="course-management__actions">
        <button type="button" className="btn" disabled={busy || draft.stages.length >= 100} onClick={() => setDraft({ ...draft, stages: [...draft.stages, { title: "", tasks: [] }] })}>添加阶段</button>
        <button className="btn btn--primary" disabled={busy} type="submit">{busy ? "保存中…" : "保存课程"}</button>
        <button className="btn" disabled={busy} type="button" onClick={close}>取消编辑</button>
      </div>
    </form>}
  </section>;
}
