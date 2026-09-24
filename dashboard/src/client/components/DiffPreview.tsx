// Diff 预览组件
// 显示 AI 建议的修改前后对比

import type { DiagnosisResult } from "../../server/ai-types.js";

interface DiffPreviewProps {
  diagnosis: DiagnosisResult;
  onConfirm: () => void;
  onReject: () => void;
  isApplying: boolean;
}

export function DiffPreview({ diagnosis, onConfirm, onReject, isApplying }: DiffPreviewProps) {
  return (
    <div className="diff-preview" role="dialog" aria-label="诊断结果预览">
      <header className="diff-preview__header">
        <h3>诊断结果与修改建议</h3>
        <p className="diff-preview__subtitle">
          以下修改将在您确认后应用到学习档案
        </p>
      </header>

      <section className="diff-preview__section">
        <h4>发现的薄弱知识点</h4>
        {diagnosis.weakPoints.length === 0 ? (
          <p className="empty-copy">未发现明显薄弱点，继续保持！</p>
        ) : (
          <ul className="weak-points-list">
            {diagnosis.weakPoints.map((point, index) => (
              <li key={index} className={`weak-point weak-point--${point.severity}`}>
                <div className="weak-point__header">
                  <strong>{point.knowledgePoint}</strong>
                  <span className={`severity-badge severity-badge--${point.severity}`}>
                    {point.severity === "high" ? "高优先级" : point.severity === "medium" ? "中优先级" : "低优先级"}
                  </span>
                </div>
                <p className="weak-point__evidence">证据：{point.evidence}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="diff-preview__section">
        <h4>建议的补救任务</h4>
        {diagnosis.remediationTasks.length === 0 ? (
          <p className="empty-copy">无需额外补救任务</p>
        ) : (
          <ol className="remediation-list">
            {diagnosis.remediationTasks.map((task, index) => (
              <li key={index}>{task}</li>
            ))}
          </ol>
        )}
      </section>

      <section className="diff-preview__section">
        <h4>下次复习时间</h4>
        <p className="next-review-date">{diagnosis.nextReviewDate}</p>
      </section>

      <section className="diff-preview__section diff-preview__changes">
        <h4>将修改的文件</h4>
        <div className="file-changes">
          <div className="file-change">
            <span className="file-change__name">course.md</span>
            <pre className="file-change__diff">{diagnosis.proposedChanges.courseMarkdown}</pre>
          </div>
          <div className="file-change">
            <span className="file-change__name">reviews.md</span>
            <pre className="file-change__diff">{diagnosis.proposedChanges.reviewsMarkdown}</pre>
          </div>
          <div className="file-change">
            <span className="file-change__name">mistakes.md</span>
            <pre className="file-change__diff">{diagnosis.proposedChanges.mistakesMarkdown}</pre>
          </div>
          <div className="file-change">
            <span className="file-change__name">sessions/ 新增记录</span>
            <pre className="file-change__diff">{diagnosis.proposedChanges.sessionMarkdown}</pre>
          </div>
        </div>
      </section>

      <footer className="diff-preview__footer">
        <button
          className="btn btn--primary"
          onClick={onConfirm}
          disabled={isApplying}
        >
          {isApplying ? "正在应用..." : "确认应用修改"}
        </button>
        <button
          className="btn btn--secondary"
          onClick={onReject}
          disabled={isApplying}
        >
          拒绝修改
        </button>
      </footer>
    </div>
  );
}
