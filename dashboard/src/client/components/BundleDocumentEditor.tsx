import { forwardRef, useImperativeHandle } from "react";
import type { CourseImportPreview } from "../../shared/course-import.js";
import { useImportAutosave } from "../hooks/useImportAutosave.js";
import { ImportAiPanel } from "./ImportAiPanel.js";
import { ImportQualityReport } from "./ImportQualityReport.js";
export interface BundleDocumentEditorHandle { flush: () => Promise<CourseImportPreview>; hasUnsavedChanges: () => boolean; allowDiscard: () => void }
export const BundleDocumentEditor = forwardRef<BundleDocumentEditorHandle, { preview: CourseImportPreview; onChanged: (preview: CourseImportPreview) => void; busy: boolean; onBusyChange: (busy: boolean) => void }>(function BundleDocumentEditor({ preview, onChanged, busy, onBusyChange }, ref) {
  const autosave = useImportAutosave(preview, onChanged);
  useImperativeHandle(ref, () => ({ flush: autosave.flush, hasUnsavedChanges: autosave.hasUnsavedChanges, allowDiscard: autosave.allowDiscard }), [autosave.flush, autosave.hasUnsavedChanges, autosave.allowDiscard]);
  const change = (draft: Partial<CourseImportPreview["draft"]>) => onChanged({ ...preview, draft: { ...preview.draft, ...draft } });
  const stageChange = (index: number, data: Partial<CourseImportPreview["draft"]["stages"][number]>) => change({ stages: preview.draft.stages.map((stage, i) => i === index ? { ...stage, ...data } : stage) });
  const blocked = busy || preview.operation?.status === "running";
  const structural = blocked || autosave.status === "saving";
  return <section className="workspace-panel bundle-document-editor">
    <h3>{preview.draft.originalFilename}</h3>
    <p>各文件独立解析，保留各自来源页码。编辑停顿约 800 毫秒后自动保存；合并时新任务均从未完成开始。</p>
    <p role="status" aria-label="课件草稿保存状态">{{ saved: "已保存", unsaved: "未保存", saving: "保存中…", invalid: "请填写有效阶段和任务", error: "保存失败", conflict: "修订冲突，请重新加载" }[autosave.status]}</p>
    {autosave.error && <div><p role="alert">{autosave.error.message}</p><button type="button" disabled={blocked} onClick={() => { if (window.confirm("丢弃此课件未保存的编辑并重新加载？")) void autosave.reload(); }}>重新加载课件草稿</button><button type="button" disabled={blocked} onClick={() => void autosave.retry().catch(() => {})}>重试保存</button></div>}
    <label>课件名称<input value={preview.draft.title} maxLength={100} disabled={blocked} onChange={(event) => change({ title: event.target.value })} /></label>
    <label>课件学习目标<textarea maxLength={500} value={preview.draft.goal} disabled={blocked} onChange={(event) => change({ goal: event.target.value })} /></label>
    {preview.draft.warnings.length > 0 && <details><summary>此课件导入提醒</summary><ul>{preview.draft.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
    <ImportQualityReport quality={preview.draft.quality} sourceUrl={preview.sourceUrl} />
    {preview.draft.stages.map((stage, index) => <fieldset disabled={blocked} key={stage.id ?? index}>
      <legend>阶段 {index + 1}</legend>
      <label>阶段名称<input aria-label={`阶段 ${index + 1}`} maxLength={100} value={stage.title} onChange={(event) => stageChange(index, { title: event.target.value })} /></label>
      {stage.tasks.map((task, taskIndex) => <div key={taskIndex}><label>任务 {taskIndex + 1}<input aria-label={`阶段 ${index + 1} 任务 ${taskIndex + 1}`} maxLength={300} value={task} onChange={(event) => stageChange(index, { tasks: stage.tasks.map((text, i) => i === taskIndex ? event.target.value : text) })} /></label><button type="button" disabled={structural || stage.tasks.length <= 1} onClick={() => stageChange(index, { tasks: stage.tasks.filter((_, i) => i !== taskIndex) })}>移除任务</button></div>)}
      <div className="import-actions">
        <button type="button" disabled={structural || stage.tasks.length >= 20} onClick={() => stageChange(index, { tasks: [...stage.tasks, "新任务"] })}>添加任务</button>
        <button type="button" disabled={structural || index === 0} onClick={() => { const stages = [...preview.draft.stages]; [stages[index - 1], stages[index]] = [stages[index], stages[index - 1]]; change({ stages }); }}>上移</button>
        <button type="button" disabled={structural || index === preview.draft.stages.length - 1} onClick={() => { const stages = [...preview.draft.stages]; [stages[index + 1], stages[index]] = [stages[index], stages[index + 1]]; change({ stages }); }}>下移</button>
        <button type="button" disabled={structural || preview.draft.stages.length <= 1} onClick={() => change({ stages: preview.draft.stages.filter((_, i) => i !== index) })}>移除阶段</button>
      </div>
    </fieldset>)}
    <button type="button" disabled={structural || preview.draft.stages.length >= 60} onClick={() => change({ stages: [...preview.draft.stages, { title: "新阶段", tasks: ["新任务"] }] })}>添加阶段</button>
    <ImportAiPanel preview={preview} flush={autosave.flush} onPreviewChanged={onChanged} onBusyChange={onBusyChange} />
  </section>;
});
