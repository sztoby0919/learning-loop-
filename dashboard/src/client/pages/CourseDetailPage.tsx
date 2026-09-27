import { ArrowLeft, Check, Circle, Sparkle, WarningCircle } from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import { Link, useSearchParams } from "react-router-dom";

import type { CourseDetail } from "../../shared/course.js";
import { MarkdownContent } from "../components/MarkdownContent.js";

export function CourseDetailPage({ course }: { course: CourseDetail }) {
  const [searchParams] = useSearchParams();
  const justImported = searchParams.get("from") === "import";
  const style = { "--course-color": course.accent } as CSSProperties;

  return (
    <article className="course-detail" style={style}>
      <Link className="back-link" to="/">
        <ArrowLeft size={18} aria-hidden="true" />
        返回学习总览
      </Link>

      {justImported && (
        <div className="import-success-banner" role="status">
          <Sparkle size={20} aria-hidden="true" />
          <span>课程创建成功！开始你的学习之旅吧。</span>
        </div>
      )}

      <header className="course-hero">
        <div>
          <p className="course-hero__label">课程进度</p>
          <h1>{course.title}</h1>
          <p className="course-hero__overview">{course.overviewMarkdown}</p>
        </div>
        <div className="course-hero__score" aria-label={`课程完成度 ${course.progress ?? 0}%`}>
          <strong>{course.progress === null ? "未设置" : `${course.progress}%`}</strong>
          <span>{course.completedTasks} / {course.totalTasks} 项任务</span>
        </div>
      </header>

      <Link className="btn btn--primary" to={`/courses/${course.id}/coach`}>开始诊断</Link>

      {(course.warning || course.warnings.length > 0) && (
        <div className="inline-warning" role="status">
          <WarningCircle size={20} aria-hidden="true" />
          <span>{course.warning ?? course.warnings.join("；")}</span>
        </div>
      )}

      <dl className="course-summary-strip">
        <div><dt>当前阶段</dt><dd>{course.currentStage ?? "全部完成"}</dd></div>
        <div><dt>掌握度</dt><dd>{course.mastery === null ? "暂无记录" : `${course.mastery} / 10`}</dd></div>
        <div><dt>下一步</dt><dd>{course.nextTask ?? "请在学习路线中添加任务"}</dd></div>
      </dl>

      <section className="detail-section" aria-labelledby="roadmap-heading">
        <div className="detail-section__heading">
          <h2 id="roadmap-heading">学习路线</h2>
          <span>{course.completedTasks} 项已完成</span>
        </div>
        {course.stages.length === 0 ? (
          <p className="empty-copy">请在 course.md 的“学习路线”中添加阶段和 checkbox 任务。</p>
        ) : (
          <div className="roadmap-list">
            {course.stages.map((stage) => {
              const completed = stage.tasks.length > 0 && stage.tasks.every((task) => task.completed);
              return (
                <details key={stage.title} open={stage.title === course.currentStage}>
                  <summary>
                    <span className={`stage-icon${completed ? " stage-icon--complete" : ""}`}>
                      {completed ? <Check size={15} weight="bold" /> : <Circle size={15} />}
                    </span>
                    <strong>{stage.title}</strong>
                    <span>{stage.tasks.filter((task) => task.completed).length} / {stage.tasks.length}</span>
                  </summary>
                  <ul>
                    {stage.tasks.map((task) => (
                      <li key={task.text}>
                        <input type="checkbox" checked={task.completed} readOnly aria-label={task.text} />
                        <span>{task.text}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        )}
      </section>

      <section className="detail-section" aria-labelledby="knowledge-heading">
        <div className="detail-section__heading"><h2 id="knowledge-heading">关键知识</h2></div>
        <MarkdownContent>{course.keyPointsMarkdown}</MarkdownContent>
      </section>

      <section className="detail-section" aria-labelledby="mistakes-heading">
        <div className="detail-section__heading"><h2 id="mistakes-heading">易错点</h2></div>
        <MarkdownContent>{course.mistakesMarkdown}</MarkdownContent>
      </section>

      <section className="detail-section" aria-labelledby="records-heading">
        <div className="detail-section__heading"><h2 id="records-heading">学习记录</h2></div>
        {course.records.length === 0 ? (
          <p className="empty-copy">请在 course.md 的“学习记录”表格中追加真实学习记录。</p>
        ) : (
          <div className="records-table-wrap">
            <table className="records-table" aria-label="学习记录">
              <thead><tr><th>日期</th><th>学习内容</th><th>掌握度</th><th>遇到困难</th><th>下一步</th></tr></thead>
              <tbody>
                {course.records.map((record, index) => (
                  <tr key={`${record.date}-${index}`}>
                    <td><time dateTime={record.date}>{record.date}</time></td>
                    <td>{record.content}</td>
                    <td>{record.mastery ?? "未评估"}</td>
                    <td>{record.difficulty}</td>
                    <td>{record.nextStep}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </article>
  );
}
