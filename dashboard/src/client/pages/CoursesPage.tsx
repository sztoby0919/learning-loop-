import type { CourseSummary } from "../../shared/course.js";
import { Link } from "react-router-dom";
import { CourseCard } from "../components/CourseCard.js";

export function CoursesPage({ courses }: { courses: CourseSummary[] }) {
  return <div className="workspace-page"><div className="section-heading"><h2>全部课程</h2><div className="import-actions"><span>{courses.length} 门课程</span><Link className="import-link" to="/courses/import">从 PDF 创建课程</Link></div></div><div className="course-grid">{courses.map((course) => <div className="course-with-health" key={course.id}><CourseCard course={course} />{course.artifacts && <p>{course.artifacts.filter((item) => item.status === "ready").length} / {course.artifacts.length} 个文件可用</p>}</div>)}</div></div>;
}
