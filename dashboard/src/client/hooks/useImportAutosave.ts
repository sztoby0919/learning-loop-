import type { CourseImportPreview } from "../../shared/course-import.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchCourseImport, ImportRequestError, updateCourseImport } from "../api.js";

type Status = "saved" | "unsaved" | "saving" | "invalid" | "error" | "conflict";
const signature = (preview: CourseImportPreview) => JSON.stringify({ title: preview.draft.title, goal: preview.draft.goal, weeklyHours: preview.draft.weeklyHours, stages: preview.draft.stages.map(({ id, title, tasks }) => ({ id, title, tasks })) });
function valid(preview: CourseImportPreview) {
  const { title, goal, weeklyHours, stages } = preview.draft;
  return title.trim().length > 0 && title.length <= 100 && goal.length <= 500 && (weeklyHours === null || (Number.isInteger(weeklyHours) && weeklyHours >= 1 && weeklyHours <= 80)) && stages.length > 0 && stages.length <= 60 && stages.every((stage) => stage.title.trim() && stage.title.length <= 100 && stage.tasks.length > 0 && stage.tasks.length <= 20 && stage.tasks.every((task) => task.trim() && task.length <= 300));
}

export function useImportAutosave(preview: CourseImportPreview | null, onSaved: (saved: CourseImportPreview) => void) {
  const latest = useRef(preview);
  const callback = useRef(onSaved);
  const baseline = useRef(preview ? signature(preview) : "");
  const identity = useRef(preview?.id);
  const revision = useRef(preview?.revision);
  const pending = useRef<Promise<CourseImportPreview> | null>(null);
  const blocked = useRef<Error | null>(null);
  const mounted = useRef(true);
  const [status, setStatus] = useState<Status>("saved");
  const [error, setError] = useState<Error | null>(null);
  latest.current = preview; callback.current = onSaved;
  // A newly loaded draft or an explicit server response establishes a new baseline.
  if (identity.current !== preview?.id || (preview && preview.revision !== revision.current && !pending.current)) {
    identity.current = preview?.id; revision.current = preview?.revision;
    baseline.current = preview ? signature(preview) : ""; blocked.current = null;
  }

  const flush = useCallback(async (): Promise<CourseImportPreview> => {
    while (pending.current) await pending.current;
    const current = latest.current;
    if (!current) throw new Error("没有可保存的草稿");
    if (blocked.current) throw blocked.current;
    if (!valid(current)) { setStatus("invalid"); throw new Error("请填写有效的课程名称、阶段和任务"); }
    if (signature(current) === baseline.current) return current;
    const sent = { ...current, revision: revision.current };
    const sentSignature = signature(current);
    setStatus("saving"); setError(null);
    const operation = (async () => {
      try {
        const saved = await updateCourseImport(sent);
        if (!mounted.current || latest.current?.id !== sent.id) return saved;
        revision.current = saved.revision; baseline.current = signature(saved);
        const live = latest.current;
        const unchanged = signature(live) === sentSignature;
        // Structural controls are disabled during saving, so new stage IDs map by position.
        const merged = unchanged ? saved : { ...saved, draft: { ...live.draft, stages: live.draft.stages.map((stage, index) => stage.id ? stage : { ...stage, id: saved.draft.stages[index]?.id }) } };
        latest.current = merged; callback.current(merged);
        setStatus(unchanged ? "saved" : valid(merged) ? "unsaved" : "invalid");
        return merged;
      } catch (cause) {
        const failure = cause instanceof Error ? cause : new Error("保存草稿失败");
        if (mounted.current && latest.current?.id === sent.id) {
          blocked.current = failure; setError(failure);
          setStatus(failure instanceof ImportRequestError && failure.status === 409 ? "conflict" : "error");
        }
        throw failure;
      } finally { pending.current = null; }
    })();
    pending.current = operation;
    return operation;
  }, []);

  const editableSignature = preview ? signature(preview) : "";
  useEffect(() => {
    if (!preview || blocked.current) return;
    if (editableSignature === baseline.current) { if (!pending.current) setStatus("saved"); return; }
    if (!valid(preview)) { setStatus("invalid"); return; }
    if (!pending.current) setStatus("unsaved");
    const timer = window.setTimeout(() => { void flush().catch(() => {}); }, 800);
    return () => window.clearTimeout(timer);
  }, [editableSignature, preview?.id, preview?.revision, flush]);

  useEffect(() => {
    mounted.current = true;
    const warn = (event: BeforeUnloadEvent) => {
      if (pending.current || (latest.current && signature(latest.current) !== baseline.current)) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => { mounted.current = false; window.removeEventListener("beforeunload", warn); };
  }, []);

  const reload = useCallback(async () => {
    if (pending.current) await pending.current.catch(() => {});
    if (!latest.current) return;
    const saved = await fetchCourseImport(latest.current.id);
    revision.current = saved.revision; baseline.current = signature(saved); blocked.current = null;
    latest.current = saved; setError(null); setStatus("saved"); callback.current(saved);
  }, []);
  const retry = useCallback(async () => { blocked.current = null; setError(null); return flush(); }, [flush]);
  const hasUnsavedChanges = useCallback(() => Boolean(pending.current || (latest.current && signature(latest.current) !== baseline.current)), []);
  const allowDiscard = useCallback(() => { baseline.current = latest.current ? signature(latest.current) : ""; }, []);
  return { status, error, flush, reload, retry, hasUnsavedChanges, allowDiscard };
}
