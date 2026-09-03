import type { CourseSummary, ReviewItem, ReviewStatus } from "../../shared/course.js";

const STATUS_LABELS: Record<ReviewStatus, string> = { unscheduled: "未安排", upcoming: "即将复习", today: "今日复习", overdue: "已逾期" };

export function ReviewPage({ courses, reviews }: { courses: CourseSummary[]; reviews: ReviewItem[] }) {
  const meta = new Map(courses.map((course) => [course.id, course]));
  return <div className="workspace-page"><div className="review-summary">{(["overdue", "today", "upcoming", "unscheduled"] as ReviewStatus[]).map((status) => <div key={status}><strong>{reviews.filter((item) => item.status === status).length}</strong><span>{STATUS_LABELS[status]}</span></div>)}</div>
    {reviews.length === 0 ? <p className="empty-copy">reviews.md 中尚未添加复习主题。</p> : <div className="data-table-wrap"><table className="data-table"><thead><tr><th>课程</th><th>知识点</th><th>上次复习</th><th>下次复习</th><th>掌握度</th><th>状态</th><th>证据</th></tr></thead><tbody>{reviews.map((item, index) => <tr key={`${item.courseId}:${item.topic}:${index}`}><td style={{ color: meta.get(item.courseId)?.accent }}>{meta.get(item.courseId)?.shortTitle ?? item.courseId}</td><td>{item.topic}</td><td>{item.lastReviewed ?? "未记录"}</td><td>{item.nextReview ?? "未安排"}</td><td>{item.mastery === null ? "未评估" : `${item.mastery} / 10`}</td><td><span className={`status-text status-text--${item.status}`}>{STATUS_LABELS[item.status]}</span></td><td>{item.evidence || "暂无证据"}</td></tr>)}</tbody></table></div>}
  </div>;
}
