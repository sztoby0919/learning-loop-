import { useEffect, useRef, useState } from "react";
import type { BackupManifest, RestorePreview } from "../../shared/course-backup.js";
import { BACKUP_LIMITS } from "../../shared/course-backup.js";
import { previewBackup, downloadBackup, uploadRestore, fetchRestore, confirmRestore, cancelRestore, ImportRequestError } from "../api.js";

function savePreviewUrl(id?: string) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("restore", id); else url.searchParams.delete("restore");
  window.history.replaceState(window.history.state, "", url);
}
export function CourseBackupPanel({ courses }: { courses: Array<{ id: string; title: string }> }) {
  const [scope, setScope] = useState(""); const [manifest, setManifest] = useState<BackupManifest | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null); const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(""); const locked = useRef(false);
  const [error, setError] = useState(""); const [restored, setRestored] = useState<string[]>([]);
  const [downloaded, setDownloaded] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const clearPreview = () => { setPreview(null); setFile(null); savePreviewUrl(); if (uploadInput.current) uploadInput.current.value = ""; };
  const run = async (label: string, action: () => Promise<void>, restoreAction = false) => {
    if (locked.current) return;
    locked.current = true; setBusy(label); setError("");
    try { await action(); } catch (cause) {
      if (restoreAction && cause instanceof ImportRequestError && [404, 410].includes(cause.status)) clearPreview();
      setError(cause instanceof Error ? cause.message : "操作失败，请重试");
    }
    finally { locked.current = false; setBusy(""); }
  };
  useEffect(() => {
    const id = new URL(window.location.href).searchParams.get("restore");
    if (!id) return;
    const controller = new AbortController(); setBusy("加载恢复预览…"); locked.current = true;
    void fetchRestore(id, controller.signal).then(setPreview).catch((cause) => { if (!controller.signal.aborted) { if (cause instanceof ImportRequestError && [404, 410].includes(cause.status)) clearPreview(); setError(cause instanceof Error ? cause.message : "无法加载恢复预览"); } }).finally(() => { if (!controller.signal.aborted) { locked.current = false; setBusy(""); } });
    return () => { controller.abort(); locked.current = false; };
  }, []);
  return <section className="workspace-panel course-backup-panel">
    <div className="section-heading"><h2>ZIP 备份与恢复</h2><span>仅在本地处理，不调用 AI</span></div>
    <p>安全 ZIP 操作仅支持 Windows 的本地目录，需要系统 Windows PowerShell 可用；其他系统暂不支持。辅助进程不可用时不会降级读写，普通课程和导入仍可使用。</p>
    <p>ZIP 包含笔记和学习记录，可能涉及个人信息，请妥善保管。不包含密钥、配置、草稿、缓存和外部链接目标。</p>
    <label>备份范围<select aria-label="备份范围" value={scope} disabled={Boolean(busy)} onChange={(event) => { setScope(event.target.value); setManifest(null); setDownloaded(false); }}>
      <option value="">全部课程</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}
    </select></label>
    <button type="button" disabled={Boolean(busy) || courses.length === 0} onClick={() => void run("读取备份范围…", async () => { setManifest(await previewBackup(scope || undefined)); setDownloaded(false); })}>预览 ZIP 备份</button>
    {manifest && <div className="backup-preview">
      <ul>{manifest.courses.map((course) => <li key={course.id}><strong>{course.title}</strong> — <span>{course.sourceIncluded ? "包含受管原课件" : "不包含原课件"}</span>{course.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</li>)}</ul>
      <small>只备份上列课程和受管原课件，不保证包含所有外部学习资源。下载时重新校验文件；并发编辑可能使下载失败，请停止编辑后重试。</small>
      <button type="button" disabled={Boolean(busy)} onClick={() => void run("生成 ZIP…", async () => { await downloadBackup(scope || undefined); setDownloaded(true); })}>确认下载 ZIP</button>
    </div>}
    {downloaded && <p role="status">ZIP 已生成并交给浏览器下载。</p>}
    <hr />
    <label>选择 ZIP 备份<input ref={uploadInput} aria-label="选择 ZIP 备份" type="file" accept=".zip,application/zip" disabled={Boolean(busy) || Boolean(preview)} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(""); setRestored([]); }} /></label>
    <small>压缩文件 ≤250 MiB，实际解压 ≤500 MiB，≤2,000 文件、≤50 门课程；单 Markdown ≤10 MiB。预览创建后固定 24 小时过期。</small>
    <button type="button" disabled={!file || Boolean(busy) || Boolean(preview)} onClick={() => void run("上传与校验中…", async () => {
      if (!file || !/\.zip$/i.test(file.name)) throw new Error("请选择 ZIP 文件");
      if (file.size > BACKUP_LIMITS.compressedBytes) throw new Error("ZIP 超过 250 MiB 限制");
      const result = await uploadRestore(file); setPreview(result); savePreviewUrl(result.id);
    })}>上传并校验 ZIP</button>
    {preview && <div className="backup-preview">
      <h3>将恢复为新课程，不覆盖已有课程</h3>
      <p>预览到期：{new Date(preview.expiresAt).toLocaleString()}</p>
      <ul>{preview.courses.map((course) => <li key={course.newId}><strong>{course.title}</strong> — {course.fileCount} 个文件，{course.sourceIncluded ? "含原课件" : "无原课件"}<code>{course.newId}</code>{course.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</li>)}</ul>
      <button type="button" disabled={Boolean(busy)} onClick={() => void run("恢复中…", async () => { const result = await confirmRestore(preview.id); setRestored(result.courseIds); clearPreview(); }, true)}>{busy === "恢复中…" ? busy : "确认恢复为新课程"}</button>
      <button type="button" disabled={Boolean(busy)} onClick={() => void run("取消中…", async () => { await cancelRestore(preview.id); clearPreview(); }, true)}>取消恢复</button>
    </div>}
    {busy && <p role="status"><span className="loading-spinner" aria-hidden="true" /> {busy}</p>}
    {error && <p role="alert">{error}。请检查后手动重试；确认响应丢失时可重复确认同一预览，不会重复建课。</p>}
    {restored.length > 0 && <div role="status"><p>成功恢复 {restored.length} 门课程，原有课程未覆盖。</p>{restored.map((id) => <p key={id}><a href={`/courses/${encodeURIComponent(id)}`}>查看恢复课程 {id}</a></p>)}<a href="/courses">查看课程列表</a></div>}
  </section>;
}
