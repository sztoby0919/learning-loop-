import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { BUNDLE_LIMITS, type CourseBundlePreview } from "../../shared/course-bundle.js";
import type { CourseImportPreview } from "../../shared/course-import.js";
import { cancelCourseBundle, confirmCourseBundle, fetchCourseBundle, updateCourseBundleTitle, uploadCourseFiles } from "../api.js";
import { BundleDocumentEditor, type BundleDocumentEditorHandle } from "../components/BundleDocumentEditor.js";
import { ImportNavigationGuard } from "../components/ImportNavigationGuard.js";

export function CourseBundlePage({ initialFiles = [] }: { initialFiles?: File[] }) {
  const [params, setParams] = useSearchParams(); const navigate = useNavigate();
  const bundleId = params.get("bundle"); const targetCourseId = params.get("append") ?? undefined;
  const [bundle, setBundle] = useState<CourseBundlePreview | null>(null);
  const [title, setTitle] = useState(""); const savedTitle = useRef("");
  const [busy, setBusy] = useState(false); const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState(""); const [progress, setProgress] = useState<number | null>(null);
  const [index, setIndex] = useState(0); const editor = useRef<BundleDocumentEditorHandle>(null);
  const requestLock = useRef(false); const initialStarted = useRef(false);
  const updatingDraftUrl = useRef(false);
  const dirty = useRef<() => boolean>(() => false);
  dirty.current = () => busy || aiBusy || Boolean(editor.current?.hasUnsavedChanges()) || (bundle !== null && title !== savedTitle.current);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty.current()) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const report = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const run = async (action: () => Promise<void>) => {
    if (requestLock.current) return;
    requestLock.current = true; setBusy(true); setError("");
    try { await action(); } catch (cause) { report(cause); } finally { requestLock.current = false; setBusy(false); }
  };
  const install = (preview: CourseBundlePreview) => { setBundle(preview); setTitle(preview.title); savedTitle.current = preview.title; };
  const upload = (files: File[]) => void run(async () => {
    if (!files.length || files.length > BUNDLE_LIMITS.files) throw new Error("每批请选择 1 到 10 个文件");
    if (files.reduce((sum, file) => sum + file.size, 0) > BUNDLE_LIMITS.totalBytes) throw new Error("整批文件超过 200 MB，请分批追加");
    for (const file of files) {
      const ext = file.name.toLowerCase().split(".").pop()!;
      const max = ({ pdf: 100, docx: 50, html: 20, htm: 20, md: 10, txt: 10, markdown: 10 } as Record<string, number>)[ext];
      if (!max) throw new Error(`不支持的文件：${file.name}`);
      if (file.size > max * 1048576) throw new Error(`${file.name} 超过 ${max} MB`);
    }
    setProgress(0);
    try {
      const result = await uploadCourseFiles(files, targetCourseId, setProgress); install(result);
      // Publishing the saved draft ID changes only this page's URL, not the user's edits.
      updatingDraftUrl.current = true;
      try { setParams({ bundle: result.id, ...(targetCourseId ? { append: targetCourseId } : {}) }, { replace: true }); }
      finally { updatingDraftUrl.current = false; }
    } finally { setProgress(null); }
  });
  useEffect(() => {
    if (bundleId && bundle?.id !== bundleId) void run(async () => install(await fetchCourseBundle(bundleId)));
    else if (!bundleId && initialFiles.length && !initialStarted.current) { initialStarted.current = true; upload(initialFiles); }
  }, [bundleId]);
  const updateDocument = (preview: CourseImportPreview) => setBundle((current) => current && ({ ...current, documents: current.documents.map((doc) => doc.id === preview.id ? preview : doc) }));
  const flushed = async () => {
    if (!bundle) throw new Error("请先上传课件");
    const saved = await editor.current?.flush();
    return saved ? { ...bundle, documents: bundle.documents.map((doc) => doc.id === saved.id ? saved : doc) } : bundle;
  };
  const confirm = () => void run(async () => {
    const snapshot = await flushed();
    if (!title.trim() || title.trim().length > 100) throw new Error("请填写不超过 100 字符的课程名称");
    if (snapshot.targetCourseId && !window.confirm("确认将这批课件的阶段、摘录和资源追加到现有课程？已有学习记录和完成状态会保留。")) return;
    const result = await confirmCourseBundle(snapshot, title.trim());
    editor.current?.allowDiscard(); savedTitle.current = title; dirty.current = () => false;
    navigate(`/courses/${result.courseId}${snapshot.targetCourseId ? "?from=append" : "?from=import"}`);
  });
  const cancel = () => void run(async () => {
    if (bundle && !window.confirm("删除整批草稿和上传副本？已有课程不会被修改。")) return;
    if (bundle) await cancelCourseBundle(bundle.id);
    editor.current?.allowDiscard(); savedTitle.current = title; dirty.current = () => false;
    navigate(targetCourseId ? `/courses/${targetCourseId}` : "/courses");
  });
  return <div className="workspace-page import-page">
    <ImportNavigationGuard hasUnsavedChanges={() => !updatingDraftUrl.current && dirty.current()} />
    <div className="section-heading"><h2>{targetCourseId || bundle?.targetCourseId ? "追加课件" : "多文件创建课程"}</h2><Link to={targetCourseId ? `/courses/${targetCourseId}` : "/courses"}>返回</Link></div>
    <p>每份文件分别解析和核对，按文件选择顺序合并。每批最多 10 个文件，总计 200 MB；PDF 页码始终指向各自原文件。</p>
    {!bundle && <section className="workspace-panel import-upload" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!busy) upload(Array.from(event.dataTransfer.files)); }}>
      <label>选择课件<input type="file" multiple accept=".pdf,.docx,.md,.txt,.markdown,.html,.htm" disabled={busy} onChange={(event) => upload(Array.from(event.target.files ?? []))} /></label>
      <p>PDF 最大 100 MB；Word 50 MB；HTML 20 MB；文本 10 MB。不支持扫描无文字层或加密 PDF。</p>
    </section>}
    {progress !== null && <p role="status">上传进度：{progress}% · 上传后仍需等待解析</p>}
    {error && <p role="alert">{error}</p>}
    {bundle && <>
      <section className="workspace-panel">
        <label>课程名称<input maxLength={100} disabled={busy || Boolean(bundle.targetCourseId)} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <p>{bundle.documents.length} 份课件 · 草稿保留至 {new Date(bundle.expiresAt).toLocaleString()}。课程名称在更新合并预览或确认时保存；各课件编辑自动保存。</p>
        <label>当前课件<select value={index} disabled={busy || aiBusy} onChange={(event) => { const next = Number(event.target.value); void run(async () => { await flushed(); setIndex(next); }); }}>
          {bundle.documents.map((doc, i) => <option key={doc.id} value={i}>{i + 1}. {doc.draft.originalFilename}</option>)}
        </select></label>
      </section>
      <BundleDocumentEditor ref={editor} key={bundle.documents[index].id} preview={bundle.documents[index]} onChanged={updateDocument} busy={busy} onBusyChange={setAiBusy} />
      <section className="workspace-panel import-preview"><h3>合并后的文件预览</h3><p>此处为最近一次读取的预览。修改课件后可更新；名称按当前输入确认。追加前请核对新增阶段和内容。</p>
        <button type="button" disabled={busy || aiBusy} onClick={() => void run(async () => { await flushed(); const preview = await updateCourseBundleTitle(bundle.id, title.trim(), bundle.revision); setBundle(preview); savedTitle.current = preview.title; })}>更新合并预览</button>
        {Object.entries(bundle.files).map(([name, raw]) => <details key={name}><summary>{name}</summary><pre>{raw}</pre></details>)}
      </section>
      <div className="import-actions"><button type="button" disabled={busy || aiBusy} onClick={cancel}>取消整批导入</button><button type="button" className="primary-button" disabled={busy || aiBusy} onClick={confirm}>{bundle.targetCourseId ? "确认追加课件" : "确认创建课程"}</button></div>
    </>}
  </div>;
}
