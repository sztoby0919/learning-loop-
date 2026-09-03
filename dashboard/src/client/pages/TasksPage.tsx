import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { CourseSummary, TaskReference } from "../../shared/course.js";

export function TasksPage({ courses, tasks }: { courses: CourseSummary[]; tasks: TaskReference[] }) {
  const [courseId, setCourseId] = useState("all");
  const [status, setStatus] = useState("all");
  const visible = useMemo(() => tasks.filter((task) => (courseId === "all" || task.courseId === courseId) && (status === "all" || (status === "done") === task.completed)), [tasks, courseId, status]);
  return <div className="workspace-page">
    <div className="page-tools">
      <label>课程<select value={courseId} onChange={(event) => setCourseId(event.target.value)}><option value="all">全部课程</option>{courses.map((course) => <option value={course.id} key={course.id}>{course.shortTitle ?? course.title}</option>)}</select></label>
      <label>完成状态<select aria-label="完成状态" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option><option value="pending">待完成</option><option value="done">已完成</option></select></label>
      <span>{visible.filter((task) => task.completed).length} / {visible.length} 项完成</span>
    </div>
    {visible.length === 0 ? <p className="empty-copy">当前筛选下没有任务。</p> : <div className="task-groups">{courses.map((course) => {
      const courseTasks = visible.filter((task) => task.courseId === course.id);
      if (!courseTasks.length) return null;
      return <section className="workspace-panel" key={course.id}><div className="section-heading"><h2 style={{ color: course.accent }}>{course.shortTitle ?? course.title}</h2><Link to={`/courses/${course.id}`}>查看课程</Link></div><ul className="readonly-task-list">{courseTasks.map((task) => <li key={`${task.stage}:${task.text}`}><input type="checkbox" checked={task.completed} readOnly aria-label={task.text} /><div><span>{task.text}</span><small>{task.stage}</small></div></li>)}</ul></section>;
    })}</div>}
  </div>;
}
