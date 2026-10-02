import { useEffect, useRef, useState } from "react";
import type { AiExcerpt, CourseImportPreview } from "../../shared/course-import.js";
import { applyImportAi, cancelImportAi, fetchCourseImport, getImportAi, ImportRequestError, previewImportAi, rejectImportAi, startImportAi, undoImportAi } from "../api.js";
const scope = (preview: CourseImportPreview) => JSON.stringify({ title: preview.draft.title, goal: preview.draft.goal, weeklyHours: preview.draft.weeklyHours, stages: preview.draft.stages.map((stage) => ({ id: stage.id, title: stage.title, source: stage.source })) });

export function ImportAiPanel({ preview, flush, onPreviewChanged, onBusyChange }: { preview: CourseImportPreview; flush: () => Promise<CourseImportPreview>; onPreviewChanged: (preview: CourseImportPreview) => void; onBusyChange?: (busy: boolean) => void }) {
  const [selected, setSelected] = useState<string[]>(() => preview.draft.stages.filter((stage) => stage.source && stage.id).map((stage) => stage.id!));
  const [excerpt, setExcerpt] = useState<AiExcerpt | null>(null);
  const [consent, setConsent] = useState(false);
  const [accepted, setAccepted] = useState<string[]>([]);
  const [localBusy, setLocalBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [elapsed, setElapsed] = useState(() => Math.max(0, Math.floor((Date.now() - (preview.operation?.startedAt ?? Date.now())) / 1000)));
  const latest = useRef({ preview, onPreviewChanged, onBusyChange }); latest.current = { preview, onPreviewChanged, onBusyChange };
  const alive = useRef(true);
  const running = preview.operation?.status === "running";
  const requestLock = useRef(false);
  const excerptScope = useRef("");
  const metadata = scope(preview);
  const selectableIds = JSON.stringify(preview.draft.stages.filter((stage) => stage.id && stage.source).map((stage) => stage.id));

  useEffect(() => {
    const allowed = new Set<string>(JSON.parse(selectableIds));
    setSelected((current) => current.filter((id) => allowed.has(id)));
    setExcerpt(null); setConsent(false);
  }, [selectableIds]);

  useEffect(() => { if (excerpt && (excerpt.revision !== preview.revision || excerptScope.current !== metadata)) { setExcerpt(null); setConsent(false); } }, [metadata, preview.revision, excerpt]);
  useEffect(() => { setAccepted([]); }, [preview.candidate?.id]);
  useEffect(() => { onBusyChange?.(running || localBusy); }, [running, localBusy, onBusyChange]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    const operation = preview.operation;
    if (!operation || operation.status !== "running") return;
    let active = true; let polling = false;
    const controller = new AbortController();
    const tick = async () => {
      if (!active) return;
      setElapsed(Math.max(0, Math.floor((Date.now() - operation.startedAt) / 1000)));
      if (polling) return;
      polling = true;
      try {
        const updated = await getImportAi(preview.id, operation.id, controller.signal);
        if (!active) return;
        if (updated.status !== "running") {
          const current = await fetchCourseImport(preview.id, controller.signal);
          if (active && latest.current.preview.operation?.id === operation.id) latest.current.onPreviewChanged(current);
        }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause : new Error("读取 AI 状态失败，草稿已保留")); }
      finally { polling = false; }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 1000);
    return () => { active = false; controller.abort(); window.clearInterval(timer); };
  }, [preview.id, preview.operation?.id, preview.operation?.status]);

  const perform = async (action: () => Promise<void>) => {
    if (requestLock.current) return;
    requestLock.current = true; setLocalBusy(true); setError(null);
    try { await action(); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause : new Error("操作失败，草稿已保留")); }
    finally { requestLock.current = false; if (alive.current) setLocalBusy(false); }
  };
  const inspect = () => perform(async () => {
    const saved = await flush();
    const result = await previewImportAi(saved.id, saved.revision!, selected);
    if (alive.current) { excerptScope.current = scope(saved); setExcerpt(result); setConsent(false); }
  });
  const start = () => perform(async () => {
    if (!excerpt || !consent) return;
    const saved = await flush();
    if (saved.revision !== excerpt.revision) { setExcerpt(null); setConsent(false); throw new Error("草稿已改变，请重新查看发送摘录并同意"); }
    setStarting(true);
    try { const operation = await startImportAi(saved.id, excerpt); if (alive.current) onPreviewChanged({ ...saved, candidate: undefined, operation }); }
    finally { if (alive.current) setStarting(false); }
  });
  const cancel = () => perform(async () => {
    if (!preview.operation) return;
    const operation = await cancelImportAi(preview.id, preview.operation.id);
    const current = await fetchCourseImport(preview.id);
    if (alive.current) onPreviewChanged({ ...current, operation });
  });
  const apply = () => perform(async () => {
    if (!preview.candidate) return;
    const saved = await flush();
    const current = await applyImportAi(saved.id, preview.candidate.id, saved.revision!, accepted);
    if (alive.current) onPreviewChanged(current);
  });
  const reject = () => perform(async () => {
    if (!preview.candidate) return;
    const saved = await flush();
    const current = await rejectImportAi(saved.id, preview.candidate.id, saved.revision!);
    if (alive.current) onPreviewChanged(current);
  });
  const undo = () => perform(async () => {
    const saved = await flush();
    const current = await undoImportAi(saved.id, saved.revision!);
    if (alive.current) onPreviewChanged(current);
  });
  const reload = () => perform(async () => {
    if (!window.confirm("重新加载将丢弃当前未保存编辑，继续吗？")) return;
    const current = await fetchCourseImport(preview.id);
    if (alive.current) onPreviewChanged(current);
  });

  return <section className="workspace-panel import-ai"><h3>可选：AI 完善</h3>
    <p>只发送所选来源章节开头最多两页，每页最多 1,200 字符，总量不超过 24,000 字符，含课程名称、目标和每周时间。不会发送完整文档。候选仅是章节级建议，不会直接覆盖草稿。</p>
    <p>临时服务错误最多自动重试一次，共用 90 秒总期限，可能增加调用费用；超时、鉴权失败、额度不足和格式错误不会自动重试。</p>
    {!preview.aiAvailable ? <p>未配置真实模型 API，当前可直接创建基础课程。</p> : <>
      <fieldset disabled={running || localBusy || Boolean(preview.candidate)}><legend>选择来源章节</legend>{preview.draft.stages.map((stage, index) => <label key={stage.id ?? index}><input type="checkbox" aria-label={`完善 ${stage.title}`} disabled={!stage.source || !stage.id} checked={Boolean(stage.id && selected.includes(stage.id))} onChange={(event) => { setSelected(event.target.checked ? [...selected, stage.id!] : selected.filter((id) => id !== stage.id)); setExcerpt(null); setConsent(false); }} />{stage.title}{!stage.source && "（手工阶段：无来源范围，不能 AI 完善）"}</label>)}</fieldset>
      <button type="button" onClick={() => void inspect()} disabled={!selected.length || running || localBusy || Boolean(preview.candidate)}>查看将发送的摘录</button>
      {excerpt && <div className="import-ai-excerpt"><p>实际发送：{excerpt.chars.toLocaleString()} 字符 · 修订 {excerpt.revision}</p><ul>{excerpt.pages.map((page) => <li key={`${page.stageId}-${page.page}`}>{preview.draft.stages.find((stage) => stage.id === page.stageId)?.title} · 第 {page.page} {preview.draft.sourceFormat === "pdf" ? "页" : "段文本（估算位置）"} · {page.text.length} 字符</li>)}</ul><details><summary>查看实际发送正文与目录</summary><pre>{excerpt.text}</pre></details><label><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={running || localBusy} />同意发送以上实际摘录给已配置的模型服务</label></div>}
      <div className="import-ai-actions"><button type="button" onClick={() => void start()} disabled={!excerpt || !consent || running || localBusy || Boolean(preview.candidate)}>AI 完善草稿</button>
        {(running || starting) && <span className="import-ai-progress" role="status" aria-label="AI 正在完善草稿"><span className="import-ai-spinner" aria-hidden="true" />{starting ? "正在启动 AI 请求…" : `正在完善草稿…已等待 ${elapsed} 秒`}</span>}
        {running && <button type="button" disabled={localBusy} onClick={() => void cancel()}>取消 AI 请求</button>}
      </div>
      {running && <p>最长等待 90 秒；取消会中止服务器请求，但不保证模型提供商停止计费。重新打开此草稿会继续读取已有操作，不会重新调用模型。</p>}
    </>}
    {error && <div><p role="alert">{error.message}</p>{error instanceof ImportRequestError && error.status === 409 && <button type="button" disabled={localBusy || running} onClick={() => void reload()}>重新加载草稿</button>}</div>}
    {preview.operation?.error && !running && <p>{preview.operation.error}</p>}
    {preview.candidate && <div className="import-ai-candidates"><h4>比较候选建议</h4><p>仅应用勾选的章节，其余候选会丢弃；未选章节的原草稿保持不变。</p>{preview.candidate.suggestions.map((suggestion) => {
      const original = preview.draft.stages.find((stage) => stage.id === suggestion.stageId);
      return <article key={suggestion.stageId}><label><input type="checkbox" aria-label={`接受 ${original?.title} 的建议`} checked={accepted.includes(suggestion.stageId)} disabled={localBusy} onChange={(event) => setAccepted(event.target.checked ? [...accepted, suggestion.stageId] : accepted.filter((id) => id !== suggestion.stageId))} />接受 {original?.title} 的建议</label><div className="import-ai-comparison"><div><h5>原草稿</h5><p>{original?.title}</p><ul>{original?.tasks.map((task, index) => <li key={index}>{task}</li>)}</ul>{preview.draft.notes.filter((note) => note.stageId === suggestion.stageId).map((note, index) => <pre key={index}>{note.content}</pre>)}</div><div><h5>AI 建议</h5><p>{suggestion.title}</p><ul>{suggestion.tasks.map((task, index) => <li key={index}>{task}</li>)}</ul>{suggestion.notes.map((note, index) => <div key={index}><p>{note.title} · 来源位置 {note.page} · AI 归纳</p><pre>{note.content}</pre></div>)}</div></div></article>;
    })}<div className="import-actions"><button type="button" disabled={!accepted.length || localBusy} onClick={() => void apply()}>应用所选建议</button><button type="button" disabled={localBusy} onClick={() => void reject()}>拒绝全部建议</button></div></div>}
    {preview.canUndo && <button type="button" disabled={localBusy || running} onClick={() => void undo()}>撤销最近一次 AI 应用</button>}
    {preview.draft.aiStatus === "complete" && <p>已应用所选 AI 建议；仍保留逐条原文摘录与 AI 归纳的区别，请对照来源。</p>}
  </section>;
}
