import { CheckSquare, Gauge, WarningCircle } from "@phosphor-icons/react";

import type { CoursesResponse } from "../../shared/course.js";
import { CourseCard } from "../components/CourseCard.js";
import { courseLabel } from "../course-label.js";

export function DashboardPage({ data }: { data: CoursesResponse }) {
  const readyCourses = data.courses.filter((course) => course.status === "ready");
  const completedTasks = data.courses.reduce((sum, course) => sum + course.completedTasks, 0);
  const totalTasks = data.courses.reduce((sum, course) => sum + course.totalTasks, 0);
  const masteryValues = readyCourses.flatMap((course) => course.mastery === null ? [] : [course.mastery]);
  const averageMastery = masteryValues.length
    ? (masteryValues.reduce((sum, value) => sum + value, 0) / masteryValues.length).toFixed(1)
    : "暂无";

  return (
    <div className="dashboard-page">
      <section className="section-block" aria-labelledby="continue-title">
        <div className="section-heading">
          <h2 id="continue-title">继续学习</h2>
          <span>{readyCourses.length} 门课程已连接</span>
        </div>
        <div className="course-grid">
          {data.courses.map((course) => <CourseCard key={course.id} course={course} />)}
        </div>
      </section>

      <div className="dashboard-lower-grid">
        <section className="overview-panel" aria-labelledby="overview-title">
          <div className="section-heading">
            <h2 id="overview-title">学习概况</h2>
          </div>
          <div className="metric-row">
            <div className="metric">
              <CheckSquare size={28} aria-hidden="true" />
              <span>完成任务</span>
              <strong>{completedTasks} / {totalTasks || 0}</strong>
            </div>
            <div className="metric">
              <Gauge size={28} aria-hidden="true" />
              <span>平均掌握度</span>
              <strong>{averageMastery}{averageMastery === "暂无" ? "" : " / 10"}</strong>
            </div>
          </div>
          <div className="comparison-list" aria-label="课程进度对比">
            {data.courses.map((course) => (
              <div className="comparison-row" key={course.id}>
                <div>
                  <span>{courseLabel(course.id, course.title)}</span>
                  <strong>{course.progress === null ? "未设置" : `${course.progress}%`}</strong>
                </div>
                <div className="comparison-bar">
                  <span style={{ width: `${course.progress ?? 0}%`, background: course.accent }} />
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="activity-panel" aria-labelledby="activity-title">
          <div className="section-heading">
            <h2 id="activity-title">最近学习记录</h2>
            {data.warningCount > 0 && (
              <span className="data-warning"><WarningCircle size={17} />学习记录需要检查</span>
            )}
          </div>
          {data.recentRecords.length === 0 ? (
            <p className="empty-copy">暂无学习记录。请在 course.md 的“学习记录”表格中添加内容。</p>
          ) : (
            <ol className="activity-list">
              {data.recentRecords.map((record, index) => (
                <li key={`${record.courseId}-${record.date}-${index}`}>
                  <div>
                    <strong style={{ color: record.accent }}>{courseLabel(record.courseId, record.courseTitle)}</strong>
                    <p>{record.content}</p>
                  </div>
                  <time dateTime={record.date}>{record.date}</time>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
