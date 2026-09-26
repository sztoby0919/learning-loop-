import { BookOpen, CheckSquare, Gauge, Note, WarningCircle } from "@phosphor-icons/react";
import type { LearningStats } from "../../shared/course.js";

export function StatsPage({ stats }: { stats: LearningStats }) {
  const metrics = [
    { label: "任务完成率", value: stats.completionRate === null ? "暂无" : `${stats.completionRate}%`, icon: CheckSquare },
    { label: "平均掌握度", value: stats.averageMastery === null ? "暂无" : `${stats.averageMastery} / 10`, icon: Gauge },
    { label: "诊断得分", value: stats.evidenceBasedMastery === null || stats.evidenceBasedMastery === undefined ? "暂无诊断" : `${stats.evidenceBasedMastery} / 10`, icon: Gauge },
    { label: "诊断次数", value: `${stats.diagnosisCount ?? 0} 次`, icon: Note },
    { label: "学习记录", value: `${stats.recordCount} 条`, icon: Note },
    { label: "待处理复习", value: `${stats.dueReviewCount} 项`, icon: BookOpen },
    { label: "最近诊断薄弱点", value: `${stats.weakPointCount ?? 0} 个`, icon: WarningCircle },
  ];
  return <div className="workspace-page"><div className="stats-metrics">{metrics.map(({ label, value, icon: Icon }) => <div key={label}><Icon size={26} /><span>{label}</span><strong>{value}</strong></div>)}</div><section className="workspace-panel"><div className="section-heading"><h2>课程对比</h2><span>{stats.completedTasks} / {stats.totalTasks} 项任务</span></div><div className="stats-course-list">{stats.courses.map((course) => <div key={course.courseId}><div><strong>{course.title}</strong><span>{course.mastery === null ? "暂无掌握度" : `${course.mastery} / 10`} · {course.recordCount} 条记录</span></div><div className="comparison-bar"><span style={{ width: `${course.progress ?? 0}%`, background: course.accent }} /></div><b>{course.progress === null ? "未设置" : `${course.progress}%`}</b></div>)}</div></section><section className="workspace-panel"><div className="section-heading"><h2>资源状态</h2></div><dl className="status-counts">{Object.entries(stats.resourceStatusCounts).map(([status, count]) => <div key={status}><dt>{status}</dt><dd>{count}</dd></div>)}</dl></section></div>;
}
