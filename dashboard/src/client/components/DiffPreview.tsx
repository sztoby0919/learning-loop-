import type { DiagnosisResult } from "../../server/ai-types.js";

export interface FileChange {
  name: string;
  before: string | null;
  after: string;
}

export function DiffPreview({ diagnosis, files, onConfirm, onReject, isApplying }: {
  diagnosis: DiagnosisResult;
  files: FileChange[];
  onConfirm: () => void;
  onReject: () => void;
  isApplying: boolean;
}) {
  return <div className="diff-preview" aria-label="诊断结果预览">
    <header className="diff-preview__header">
      <h3>诊断结果与修改建议</h3>
      <p>请检查以下真实文件内容，确认后才会写入。</p>
    </header>
    <section className="diff-preview__section">
      <h4>薄弱知识点与证据</h4>
      {diagnosis.weakPoints.length ? <ul>{diagnosis.weakPoints.map((point, index) => <li key={index}><strong>{point.knowledgePoint}</strong>（{point.severity === "high" ? "高" : point.severity === "medium" ? "中" : "低"}优先级）：{point.evidence}</li>)}</ul> : <p>本次未发现明显薄弱点。</p>}
    </section>
    <section className="diff-preview__section">
      <h4>补救任务与复习</h4>
      <ol>{diagnosis.remediationTasks.map((task, index) => <li key={index}>{task}</li>)}</ol>
      <p>下次复习：{diagnosis.nextReviewDate}</p>
    </section>
    <section className="diff-preview__section diff-preview__changes">
      <h4>文件修改前后</h4>
      {files.map((file) => <div className="file-change" key={file.name}>
        <h5>{file.name}</h5>
        <div className="file-change__comparison">
          <div><strong>修改前</strong><pre className="file-change__diff">{file.before ?? "（新文件）"}</pre></div>
          <div><strong>修改后</strong><pre className="file-change__diff">{file.after}</pre></div>
        </div>
      </div>)}
    </section>
    <footer className="diff-preview__footer">
      <button className="btn btn--primary" onClick={onConfirm} disabled={isApplying}>{isApplying ? "正在应用..." : "确认应用修改"}</button>
      <button className="btn btn--secondary" onClick={onReject} disabled={isApplying}>拒绝修改</button>
    </footer>
  </div>;
}
