import { Copy, LinkSimple } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { CourseSummary, ResourceItem } from "../../shared/course.js";

export function ResourcesPage({ courses, resources }: { courses: CourseSummary[]; resources: ResourceItem[] }) {
  const [courseId, setCourseId] = useState("all");
  const [status, setStatus] = useState("all");
  const statuses = [...new Set(resources.map((item) => item.status || "未设置"))];
  const visible = useMemo(() => resources.filter((item) => (courseId === "all" || item.courseId === courseId) && (status === "all" || (item.status || "未设置") === status)), [resources, courseId, status]);
  const meta = new Map(courses.map((course) => [course.id, course]));
  const isWeb = (value: string) => /^https?:\/\//.test(value) || /^\/api\/courses\/[a-z0-9-]+\/source$/.test(value);
  return <div className="workspace-page"><div className="page-tools"><label>课程<select value={courseId} onChange={(e) => setCourseId(e.target.value)}><option value="all">全部课程</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.shortTitle ?? course.title}</option>)}</select></label><label>资源状态<select aria-label="资源状态" value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">全部状态</option>{statuses.map((value) => <option key={value}>{value}</option>)}</select></label><span>{visible.length} 项资源</span></div><div className="resource-grid">{visible.map((item, index) => <article className="resource-card" key={`${item.courseId}:${item.name}:${index}`}><div className="resource-card__meta"><span style={{ color: meta.get(item.courseId)?.accent }}>{meta.get(item.courseId)?.shortTitle ?? item.courseId}</span><small>{item.type} · {item.status || "未设置"}</small></div><h2>{item.name}</h2><p>{item.note || "暂无备注"}</p><footer><span>{item.stage || "未关联阶段"}</span>{isWeb(item.location) ? <a href={item.location} target="_blank" rel="noreferrer"><LinkSimple />打开资源</a> : <button type="button" onClick={() => void navigator.clipboard?.writeText(item.location)}><Copy />复制路径</button>}</footer></article>)}</div></div>;
}
