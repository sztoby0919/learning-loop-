import { Books } from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";

import type { CourseSummary } from "../../shared/course.js";
import { courseLabel } from "../course-label.js";

export function CourseCard({ course }: { course: CourseSummary }) {
  const Icon = Books;
  const label = courseLabel(course.id, course.title);
  const style = { "--course-color": course.accent } as CSSProperties;
  const unavailable = course.status !== "ready" || course.totalTasks === 0;

  return (
    <Link
      className={`course-card${course.status !== "ready" ? " course-card--warning" : ""}`}
      style={style}
      to={`/courses/${course.id}`}
      aria-label={`查看${label}课程`}
    >
      <span className="course-card__stripe" aria-hidden="true" />
      <div className="course-card__heading">
        <Icon size={28} weight="regular" aria-hidden="true" />
        <h3>{label}</h3>
      </div>

      {unavailable ? (
        <div className="course-card__empty">
          <strong>尚未设置学习路线</strong>
          <span>{course.warning ?? "请在 course.md 中添加 checkbox 任务"}</span>
        </div>
      ) : (
        <>
          <div className="course-card__progress-label">
            <span>进度</span>
            <strong>{course.progress}%</strong>
          </div>
          <div className="course-card__progress" aria-label={`完成度 ${course.progress}%`}>
            <span style={{ width: `${course.progress}%` }} />
          </div>
          <dl className="course-card__details">
            <div>
              <dt>当前阶段</dt>
              <dd>{course.currentStage ?? "已完成全部计划"}</dd>
            </div>
            <div>
              <dt>掌握度</dt>
              <dd className="course-card__mastery">{course.mastery === null ? "暂无记录" : `${course.mastery} / 10`}</dd>
            </div>
            <div>
              <dt>下一步</dt>
              <dd>{course.nextTask}</dd>
            </div>
          </dl>
        </>
      )}
    </Link>
  );
}
