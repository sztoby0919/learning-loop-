import { useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";

import { cancelCourseImport, confirmCourseImport, enrichCourseImport, updateCourseImport, uploadCoursePdf, type CourseImportPreview } from "../api.js";

export function CourseImportPage() {
  const navigate = useNavigate();
  const [preview, setPreview] = useState<CourseImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [processingAi, setProcessingAi] = useState(false);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleError = (cause: unknown) => setError(cause instanceof Error ? cause.message : "操作失败，请稍后重试");
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) { setError("请选择 PDF 文件"); return; }
    if (file.size > 100 * 1024 * 1024) { setError("PDF 超过 100 MB，请压缩或拆分后导入"); return; }
    setBusy(true); setError(null);
    try { setPreview(await uploadCoursePdf(file)); }
    catch (cause) { handleError(cause); }
    finally { setBusy(false); }
  };
  const changeDraft = (change: Partial<CourseImportPreview["draft"]>) => {
    setPreview((current) => current ? { ...current, draft: { ...current.draft, ...change } } : current);
  };
  const changeStage = (index: number, change: Partial<CourseImportPreview["draft"]["stages"][number]>) => {
    if (!preview) return;
    changeDraft({ stages: preview.draft.stages.map((stage, position) => position === index ? { ...stage, ...change } : stage) });
  };
  const save = async (current: CourseImportPreview) => {
    const updated = await updateCourseImport(current);
    setPreview(updated);
    return updated;
  };
  const refreshPreview = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try { await save(preview); } catch (cause) { handleError(cause); } finally { setBusy(false); }
  };
  const enrich = async () => {
    if (!preview || !consent) return;
    setBusy(true); setProcessingAi(true); setError(null);
    try {
      const saved = await save(preview);
      setPreview(await enrichCourseImport(saved.id));
    } catch (cause) { handleError(cause); }
    finally { setProcessingAi(false); setBusy(false); }
  };
  const confirm = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const saved = await save(preview);
      const result = await confirmCourseImport(saved.id);
      navigate(`/courses/${result.courseId}`);
    } catch (cause) { handleError(cause); setBusy(false); }
  };
  const cancel = async () => {
    if (!preview) { navigate("/courses"); return; }
    setBusy(true); setError(null);
    try { await cancelCourseImport(preview.id); navigate("/courses"); }
    catch (cause) { handleError(cause); setBusy(false); }
  };

  return <div className="workspace-page import-page">
    <div className="section-heading"><h2>从 PDF 创建课程</h2><span>本地单用户 · 文字版 PDF</span></div>
    {!preview && <section className="workspace-panel import-upload">
      <h3>上传课件或教材</h3>
      <p>自动提取文字和目录，先预览草稿，再决定是否创建课程。首版不支持扫描版 PDF 或加密文件。</p>
      <label>选择 PDF 文件<input aria-label="选择 PDF 文件" type="file" accept=".pdf,application/pdf" onChange={(event) => void upload(event)} disabled={busy} /></label>
      <small>单个文件最多 100 MB、1,000 页；原 PDF 会保存在新课程资料中。</small>
    </section>}
    {busy && !processingAi && <p role="status">正在处理，请稍候…</p>}
    {error && <p className="import-error" role="alert">{error}</p>}
    {preview && <>
      <section className="workspace-panel import-summary">
        <h3>课程草稿</h3><p>{preview.draft.originalFilename} · {preview.draft.pageCount} 页</p>
        <label>课程名称<input aria-label="课程名称" value={preview.draft.title} onChange={(event) => changeDraft({ title: event.target.value })} disabled={busy} /></label>
        <label>学习目标（可选）<textarea aria-label="学习目标" value={preview.draft.goal} onChange={(event) => changeDraft({ goal: event.target.value })} disabled={busy} /></label>
        <label>每周学习时间（小时，可选）<input aria-label="每周学习时间" type="number" min="1" max="80" value={preview.draft.weeklyHours ?? ""} onChange={(event) => changeDraft({ weeklyHours: event.target.value ? Number(event.target.value) : null })} disabled={busy} /></label>
        {preview.draft.warnings.length > 0 && <div className="import-warnings"><strong>导入提醒</strong><ul>{preview.draft.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
      </section>
      <section className="workspace-panel import-stages"><h3>学习阶段与任务</h3><p>可以修改标题与任务；完成情况需在学习后记录。</p>
        {preview.draft.stages.map((stage, index) => <div className="import-stage" key={index}>
          <label>阶段 {index + 1}<input aria-label={`阶段 ${index + 1}`} value={stage.title} onChange={(event) => changeStage(index, { title: event.target.value })} disabled={busy} /></label>
          {stage.tasks.map((task, taskIndex) => <label key={taskIndex}>任务 {taskIndex + 1}<input aria-label={`阶段 ${index + 1} 任务 ${taskIndex + 1}`} value={task} onChange={(event) => changeStage(index, { tasks: stage.tasks.map((item, position) => position === taskIndex ? event.target.value : item) })} disabled={busy} /></label>)}
          <div className="import-actions"><button type="button" onClick={() => changeStage(index, { tasks: [...stage.tasks, "新任务"] })} disabled={busy}>添加任务</button><button type="button" onClick={() => changeDraft({ stages: preview.draft.stages.filter((_, position) => position !== index) })} disabled={busy || preview.draft.stages.length <= 1}>移除阶段</button></div>
        </div>)}
        <button type="button" onClick={() => changeDraft({ stages: [...preview.draft.stages, { title: "新阶段", tasks: ["新任务"] }] })} disabled={busy}>添加阶段</button>
      </section>
      <section className="workspace-panel import-ai"><h3>可选：AI 完善</h3>
        <p>仅在你同意后，将课程名称、你填写的学习目标和每周学习时间，以及目录和代表性页面摘录（摘录最多约 {preview.excerptChars.toLocaleString()} 字符）发送给已配置的模型服务；不会发送完整 PDF。生成结果只是章节级草稿，请核对原文。</p>
        {preview.aiAvailable ? <><label><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={busy} />同意发送上述摘录给模型服务</label><div className="import-ai-actions"><button type="button" onClick={() => void enrich()} disabled={!consent || busy}>AI 完善草稿</button>{processingAi && <span className="import-ai-progress" role="status" aria-label="AI 正在完善草稿"><span className="import-ai-spinner" aria-hidden="true" />正在完善草稿…</span>}</div></> : <p>未配置真实模型 API，当前可直接创建基础课程。</p>}
        {preview.draft.aiStatus === "complete" && <p>AI 已完善草稿，请在创建前核对提纲和笔记。</p>}
        {preview.draft.aiStatus === "failed" && <p>AI 完善失败，基础草稿仍可创建。</p>}
      </section>
      <section className="workspace-panel import-preview"><div className="section-heading"><h3>将生成的课程文件</h3><button type="button" onClick={() => void refreshPreview()} disabled={busy}>更新预览</button></div><p>编辑后点击“更新预览”；确认创建时也会自动保存当前编辑。</p>
        {Object.entries(preview.files).map(([name, content]) => <details key={name}><summary>{name}</summary><pre>{content}</pre></details>)}
        <p>另会保存原始 PDF，并创建空的 sessions/ 目录。</p>
      </section>
      <div className="import-actions"><button type="button" onClick={() => void cancel()} disabled={busy}>取消导入</button><button className="primary-button" type="button" onClick={() => void confirm()} disabled={busy}>确认创建课程</button></div>
    </>}
  </div>;
}
