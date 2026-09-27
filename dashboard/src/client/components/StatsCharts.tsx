import type { LearningStats, CoursesResponse } from "../../shared/course.js";

export function StatsCharts({ stats, courses }: { stats: LearningStats; courses: CoursesResponse["courses"] }) {
  return (
    <section className="stats-panel" aria-labelledby="stats-title">
      <div className="section-heading"><h2 id="stats-title">学习统计</h2></div>
      <div className="stats-grid">
        <WeeklyStudyChart records={stats.weeklyRecords} />
        <CourseProgressChart courses={courses} />
        <StudyStreak stats={stats} />
      </div>
    </section>
  );
}
function WeeklyStudyChart({ records }: { records: LearningStats["weeklyRecords"] }) {
  const weekDays = ["一", "二", "三", "四", "五", "六", "日"];
  const data = records.map((record) => record.count);
  const maxValue = Math.max(...data, 1);

  return (
    <div className="stat-card">
      <h4>本周学习记录</h4>
      <div className="bar-chart">
        {data.map((value, i) => (
          <div className="bar-column" key={i}>
            <div className="bar" style={{ height: `${(value / maxValue) * 100}%` }} title={`${value} 条记录`} />
            <span className="bar-label">{weekDays[i]}</span>
          </div>
        ))}
      </div>
      <p className="stat-subtitle">共 {data.reduce((sum, count) => sum + count, 0)} 条记录</p>
    </div>
  );
}
function CourseProgressChart({ courses }: { courses: CoursesResponse["courses"] }) {
  const readyCourses = courses.filter((c) => c.status === "ready");
  const totalProgress = readyCourses.reduce((sum, c) => sum + (c.progress ?? 0), 0);
  const avgProgress = readyCourses.length ? Math.round(totalProgress / readyCourses.length) : 0;

  // SVG donut chart
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - avgProgress / 100);

  return (
    <div className="stat-card">
      <h4>平均进度</h4>
      <div className="donut-chart">
        <svg viewBox="0 0 100 100" width="90" height="90">
          <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--line)" strokeWidth="10" />
          <circle
            cx="50" cy="50" r={radius} fill="none" stroke="var(--accent)" strokeWidth="10"
            strokeDasharray={circumference} strokeDashoffset={offset}
            strokeLinecap="round" transform="rotate(-90 50 50)"
          />
          <text x="50" y="50" textAnchor="middle" dominantBaseline="central" className="donut-text">
            {avgProgress}%
          </text>
        </svg>
      </div>
      <p className="stat-subtitle">{readyCourses.length} 门课程</p>
    </div>
  );
}

function StudyStreak({ stats }: { stats: LearningStats }) {
  // Calculate streak from record dates
  const streak = stats.streakDays;

  return (
    <div className="stat-card">
      <h4>连续学习</h4>
      <div className="streak-display">
        <span className="streak-number">{streak}</span>
        <span className="streak-unit">天</span>
      </div>
      <p className="stat-subtitle">{streak > 0 ? "继续保持！" : "开始今天的学习"}</p>
    </div>
  );
}
