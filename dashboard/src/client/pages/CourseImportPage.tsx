import { useState, useCallback, useRef, useEffect, type ChangeEvent, type DragEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { cancelCourseImport, confirmCourseImport, fetchCourseImport, listCourseImports, uploadCourseFile, type CourseImportPreview, type UploadProgressCallback } from "../api.js";
import type { DraftSummary } from "../../shared/course-import.js";
import { useImportAutosave } from "../hooks/useImportAutosave.js";
import { ImportQualityReport } from "../components/ImportQualityReport.js";
import { ImportAiPanel } from "../components/ImportAiPanel.js";
import { ImportNavigationGuard } from "../components/ImportNavigationGuard.js";

export function CourseImportPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [preview, setPreview] = useState<CourseImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const processingAi = preview?.operation?.status === "running";
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [lastUpload, setLastUpload] = useState<File | null>(null);
  const uploadLock = useRef(false);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const autosave = useImportAutosave(preview, setPreview);
  const structuralBusy = busy || autosave.status === "saving";
  const requestedDraft = searchParams.get("draft");

  useEffect(() => {
    let active = true;
    if (requestedDraft) {
      if (preview?.id === requestedDraft) return;
      setBusy(true);
      void fetchCourseImport(requestedDraft).then((saved) => { if (active) { setPreview(saved); setError(null); } }).catch((cause) => { if (active) handleError(cause); }).finally(() => { if (active) setBusy(false); });
    } else if (!preview) {
      void listCourseImports().then((entries) => { if (active) setDrafts(Array.isArray(entries) ? entries : []); }).catch(() => { if (active) setRecoveryError("暂时无法读取已保存草稿，请稍后重新打开此页。"); });
    }
    return () => { active = false; };
  }, [requestedDraft]);

  const handleError = (cause: unknown) => setError(cause instanceof Error ? cause.message : "操作失败，请稍后重试");

  const doUpload = useCallback(async (file: File) => {
    if (uploadLock.current) return;
    setLastUpload(null);
    const isPdf = /\.pdf$/i.test(file.name);
    const isDocx = /\.docx$/i.test(file.name);
    const isText = /\.(md|txt|markdown)$/i.test(file.name);
    const isHtml = /\.html?$/i.test(file.name);
    if (!isPdf && !isDocx && !isText && !isHtml) { setError("请选择 PDF、Word (.docx)、Markdown (.md/.txt) 或 HTML 文件"); return; }
    const maxBytes = isPdf ? 100 * 1024 * 1024 : isDocx ? 50 * 1024 * 1024 : isHtml ? 20 * 1024 * 1024 : 10 * 1024 * 1024;
    const maxLabel = isPdf ? "100 MB" : isDocx ? "50 MB" : isHtml ? "20 MB" : "10 MB";
    if (file.size > maxBytes) { setError(`文件超过 ${maxLabel}，请压缩或拆分后导入`); return; }
    uploadLock.current = true;
    setLastUpload(file);
    setBusy(true); setError(null); setUploadProgress(0);
    const onProgress: UploadProgressCallback = (percent) => setUploadProgress(percent);
    try {
      const result = await uploadCourseFile(file, onProgress);
      setPreview(result);
      setSearchParams({ draft: result.id }, { replace: true });
      setLastUpload(null);
      setUploadProgress(null);
    } catch (cause) {
      handleError(cause);
      setUploadProgress(null);
    } finally {
      uploadLock.current = false;
      setBusy(false);
    }
  }, []);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) await doUpload(file);
  };

  const handleDrop = useCallback((event: DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer.files[0];
    if (file) void doUpload(file);
  }, [doUpload]);

  const handleDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const retryUpload = useCallback(() => {
    if (lastUpload) void doUpload(lastUpload);
  }, [doUpload, lastUpload]);

  const changeDraft = (change: Partial<CourseImportPreview["draft"]>) => {
    setPreview((current) => current ? { ...current, draft: { ...current.draft, ...change } } : current);
  };

  const changeStage = (index: number, change: Partial<CourseImportPreview["draft"]["stages"][number]>) => {
    if (!preview) return;
    changeDraft({ stages: preview.draft.stages.map((stage, position) => position === index ? { ...stage, ...change } : stage) });
  };

  const moveStage = (index: number, direction: -1 | 1) => {
    if (!preview) return;
    const target = index + direction;
    if (target < 0 || target >= preview.draft.stages.length) return;
    const stages = [...preview.draft.stages];
    [stages[index], stages[target]] = [stages[target], stages[index]];
    changeDraft({ stages });
  };

  const refreshPreview = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try { await autosave.flush(); } catch (cause) { handleError(cause); } finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const saved = await autosave.flush();
      const result = await confirmCourseImport(saved.id, saved.revision);
      navigate(`/courses/${result.courseId}?from=import`);
    } catch (cause) { handleError(cause); setBusy(false); }
  };

  const cancel = async () => {
    if (!preview) { navigate("/courses"); return; }
    if (!window.confirm("删除这个草稿和上传副本？此操作不可恢复。")) return;
    setBusy(true); setError(null);
    try { await cancelCourseImport(preview.id); autosave.allowDiscard(); navigate("/courses"); }
    catch (cause) { handleError(cause); setBusy(false); }
  };

  const deleteDraft = async (draft: DraftSummary) => {
    if (!window.confirm(`删除“${draft.title}”草稿和上传副本？此操作不可恢复。`)) return;
    setBusy(true); setError(null);
    try { await cancelCourseImport(draft.id); setDrafts((entries) => entries.filter((entry) => entry.id !== draft.id)); }
    catch (cause) { handleError(cause); }
    finally { setBusy(false); }
  };
  const reloadDraft = async () => {
    if (!window.confirm("重新加载将丢弃当前未保存的编辑，继续吗？")) return;
    setBusy(true);
    try { await autosave.reload(); setError(null); } catch (cause) { handleError(cause); } finally { setBusy(false); }
  };

  const acceptTypes = ".pdf,.docx,.md,.txt,.markdown,.html,.htm,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/html";

  const sourceFormatLabel = (format: string) => {
    if (format === "docx") return "Word";
    if (format === "text") return "TEXT";
    return "PDF";
  };

  return <div className="workspace-page import-page">
    <ImportNavigationGuard hasUnsavedChanges={autosave.hasUnsavedChanges} />
    <div className="section-heading"><h2>从文档创建课程</h2><span>本地单用户 · PDF / Word / Markdown / HTML</span></div>
    {!preview && !requestedDraft && <section className="workspace-panel import-recovery"><h3>继续已保存的草稿</h3><p>草稿自上传起保留 7 天，编辑不会延长有效期。只有显示“已保存”的内容可以恢复。</p>{recoveryError && <p>{recoveryError}</p>}{drafts.map((draft) => <div className="import-recovery-entry" key={draft.id}><span>{draft.title}</span><span>到期：{new Date(draft.expiresAt).toLocaleString()}</span>{draft.warning && <span>{draft.warning}</span>}<div className="import-actions"><button type="button" disabled={busy || draft.status !== "ready"} onClick={() => setSearchParams({ draft: draft.id })}>继续编辑</button><button type="button" aria-label={`删除${draft.title}草稿`} disabled={busy} onClick={() => void deleteDraft(draft)}>删除草稿</button></div></div>)}</section>}
    {!preview && <section
      className={`workspace-panel import-upload ${dragOver ? "drag-over" : ""}`}
      onDrop={(e) => void handleDrop(e)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <h3>上传课件或教材</h3>
      <p>自动提取文字和目录，先预览草稿，再决定是否创建课程。支持 PDF、Word (.docx)、Markdown (.md/.txt) 和 HTML；不支持扫描版或加密文件。</p>
      <label>选择文件<input aria-label="选择文件" type="file" accept={acceptTypes} onChange={(event) => void upload(event)} disabled={busy} /></label>
      <small>PDF 最大 100 MB / Word 最大 50 MB / HTML 最大 20 MB / 文本最大 10 MB，最多 1,000 页或等价文本长度；原文档会保存在新课程资料中。</small>
      {uploadProgress !== null && (
        <div className="import-progress">
          <div className="import-progress-bar" style={{ width: `${uploadProgress}%` }} />
          <span>{uploadProgress}%</span>
        </div>
      )}
    </section>}
    {busy && !processingAi && uploadProgress === null && <p role="status">正在处理，请稍候…</p>}
    {error && (
      <div className="import-error-wrapper">
        <p className="import-error" role="alert">{error}</p>
        {!preview && lastUpload && <button type="button" onClick={retryUpload} disabled={busy}>重试</button>}
      </div>
    )}
    {preview && <>
      <section className="workspace-panel import-summary">
        <h3>课程草稿</h3>
        <p role="status" aria-label="草稿保存状态">{{ saved: "已保存", unsaved: "未保存", saving: "保存中…", invalid: "未保存：请填写有效的名称、阶段和任务", error: "保存失败", conflict: "修订冲突：未覆盖已保存内容" }[autosave.status]}</p>
        {preview.expiresAt && <p>草稿到期：{new Date(preview.expiresAt).toLocaleString()}</p>}
        {autosave.error && <div><p role="alert">{autosave.error.message}</p>{autosave.status === "conflict" ? <button type="button" disabled={busy} onClick={() => void reloadDraft()}>重新加载已保存草稿</button> : <button type="button" disabled={busy} onClick={() => void autosave.retry().catch(handleError)}>重试保存</button>}</div>}
        <p>
          {preview.draft.originalFilename} · {preview.draft.pageCount} {preview.draft.sourceFormat === "text" ? "段文本" : "页"}
          <span className={`file-type-badge ${preview.draft.sourceFormat}`}>
            {sourceFormatLabel(preview.draft.sourceFormat)}
          </span>
        </p>
        <label>课程名称<input aria-label="课程名称" value={preview.draft.title} onChange={(event) => changeDraft({ title: event.target.value })} disabled={busy} /></label>
        <label>学习目标（可选）<textarea aria-label="学习目标" value={preview.draft.goal} onChange={(event) => changeDraft({ goal: event.target.value })} disabled={busy} /></label>
        <label>每周学习时间（小时，可选）<input aria-label="每周学习时间" type="number" min="1" max="80" value={preview.draft.weeklyHours ?? ""} onChange={(event) => changeDraft({ weeklyHours: event.target.value ? Number(event.target.value) : null })} disabled={busy} /></label>
        {preview.draft.warnings.length > 0 && <div className="import-warnings"><strong>导入提醒</strong><ul>{preview.draft.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
      </section>
      <ImportQualityReport quality={preview.draft.quality} sourceUrl={preview.sourceUrl} />
      <section className="workspace-panel import-stages"><h3>学习阶段与任务</h3><p>可以修改标题与任务；完成情况需在学习后记录。</p>
        {preview.draft.stages.map((stage, index) => <div className="import-stage" key={stage.id ?? index}>
          <div className="import-stage-header">
            <label>阶段 {index + 1}<input aria-label={`阶段 ${index + 1}`} value={stage.title} onChange={(event) => changeStage(index, { title: event.target.value })} disabled={busy} /></label>
            <div className="import-stage-move">
              <button type="button" onClick={() => moveStage(index, -1)} disabled={structuralBusy || index === 0} title="上移">↑</button>
              <button type="button" onClick={() => moveStage(index, 1)} disabled={structuralBusy || index === preview.draft.stages.length - 1} title="下移">↓</button>
            </div>
          </div>
          {stage.tasks.map((task, taskIndex) => <label key={taskIndex}>任务 {taskIndex + 1}<input aria-label={`阶段 ${index + 1} 任务 ${taskIndex + 1}`} value={task} onChange={(event) => changeStage(index, { tasks: stage.tasks.map((item, position) => position === taskIndex ? event.target.value : item) })} disabled={busy} /></label>)}
          <div className="import-actions"><button type="button" onClick={() => changeStage(index, { tasks: [...stage.tasks, "新任务"] })} disabled={structuralBusy}>添加任务</button><button type="button" onClick={() => changeDraft({ stages: preview.draft.stages.filter((_, position) => position !== index) })} disabled={structuralBusy || preview.draft.stages.length <= 1}>移除阶段</button></div>
        </div>)}
        <button type="button" onClick={() => changeDraft({ stages: [...preview.draft.stages, { title: "新阶段", tasks: ["新任务"] }] })} disabled={structuralBusy}>添加阶段</button>
      </section>
      <ImportAiPanel preview={preview} flush={autosave.flush} onPreviewChanged={setPreview} onBusyChange={setBusy} />
      <section className="workspace-panel import-preview"><div className="section-heading"><h3>将生成的课程文件</h3><button type="button" onClick={() => void refreshPreview()} disabled={busy}>更新预览</button></div><p>编辑停顿约 800 毫秒后自动保存；更新预览和确认创建会等待保存完成。</p>
        {Object.entries(preview.files).map(([name, content]) => <details key={name}><summary>{name}</summary><pre>{content}</pre></details>)}
        <p>另会保存原始文档文件，并创建空的 sessions/ 目录。</p>
      </section>
      <div className="import-actions"><button type="button" onClick={() => void cancel()} disabled={busy}>取消导入</button><button className="primary-button" type="button" onClick={() => void confirm()} disabled={busy}>确认创建课程</button></div>
    </>}
  </div>;
}
