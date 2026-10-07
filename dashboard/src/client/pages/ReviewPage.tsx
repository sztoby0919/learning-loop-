import type { CourseSummary, ReviewItem, ReviewStatus, ScheduledReview } from "../../shared/course.js";
import { PracticeFlow } from "../components/PracticeFlow.js";

const STATUS_LABELS: Record<ReviewStatus, string> = { unscheduled: "未安排", upcoming: "即将复习", today: "今日复习", overdue: "已逾期" };

export function ReviewPage({ courses, reviews, scheduledReviews = [], onSaved = () => {} }: { courses: CourseSummary[]; reviews: ReviewItem[]; scheduledReviews?: ScheduledReview[]; onSaved?: () => void }) {
  const meta = new Map(courses.map((course) => [course.id, course]));
  const handwritten = new Set(reviews.map((item) => `${item.courseId}:${item.topic}`));
  const automatic: ReviewItem[] = scheduledReviews.filter((item) => !handwritten.has(`${item.courseId}:${item.topic}`)).map((item) => ({ courseId: item.courseId, topic: item.topic, lastReviewed: null, nextReview: item.nextReviewDate, mastery: item.mastery, evidence: `基于 ${item.recordDate} 的学习记录自动安排；尚无复习证据`, status: item.daysUntilReview < 0 ? "overdue" : item.daysUntilReview === 0 ? "today" : "upcoming" }));
  const visible = [...new Map([...reviews, ...automatic].map((item) => [`${item.courseId}:${item.topic}`, item])).values()];
  return <div className="workspace-page"><div className="review-summary">{(["overdue", "today", "upcoming", "unscheduled"] as ReviewStatus[]).map((status) => <div key={status}><strong>{visible.filter((item) => item.status === status).length}</strong><span>{STATUS_LABELS[status]}</span></div>)}</div>
    {visible.length === 0 ? <p className="empty-copy">目前没有待复习主题；学习记录会自动生成提醒。</p> : (
      <div className="data-table-wrap">
        <table className="data-table review-table">
          <thead><tr><th>课程</th><th>知识点</th><th>上次复习</th><th>下次复习</th><th>掌握度</th><th>状态</th><th>证据</th><th>操作</th></tr></thead>
          <tbody>{visible.map((item) => (
            <tr key={`${item.courseId}:${item.topic}`}>
              <td style={{ color: meta.get(item.courseId)?.accent }}>{meta.get(item.courseId)?.shortTitle ?? item.courseId}</td>
              <td>{item.topic}</td>
              <td>{item.lastReviewed ?? "未记录"}</td>
              <td>{item.nextReview ?? "未安排"}</td>
              <td>{item.mastery === null ? "未评估" : `${item.mastery} / 10`}</td>
              <td><span className={`status-text status-text--${item.status}`}>{STATUS_LABELS[item.status]}</span></td>
              <td>{item.evidence || "暂无证据"}</td>
              <td className="review-task-action"><PracticeFlow courseId={item.courseId} topic={item.topic} onSaved={onSaved} /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    )}
  </div>;
}
