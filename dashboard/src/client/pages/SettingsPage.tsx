import { ArrowDown, ArrowUp, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import type { CourseArtifactHealth, CourseSummary } from "../../shared/course.js";
import { usePreferences } from "../preferences.js";

export interface SettingsData {
  configPath: string;
  courses: Array<{ id: string; root: string; artifacts: CourseArtifactHealth[] }>;
}

function healthDescription(item: CourseArtifactHealth) {
  if (item.status !== "ready") return item.warning ?? item.status;
  const details = [item.artifact === "sessions" && item.count !== undefined ? `${item.count} 个文件` : null, item.updated];
  return details.filter(Boolean).join(" · ") || "可用";
}

export function SettingsPage({ settings, courses }: { settings: SettingsData; courses: CourseSummary[] }) {
  const [preferences, setPreferences] = usePreferences();
  const ordered = [...courses].sort((a, b) => {
    const ai = preferences.courseOrder.indexOf(a.id);
    const bi = preferences.courseOrder.indexOf(b.id);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || (a.order ?? 999) - (b.order ?? 999);
  });
  const toggle = (id: string) => setPreferences({
    ...preferences,
    hiddenCourseIds: preferences.hiddenCourseIds.includes(id)
      ? preferences.hiddenCourseIds.filter((item) => item !== id)
      : [...preferences.hiddenCourseIds, id],
  });
  const move = (id: string, delta: number) => {
    const order = ordered.map((course) => course.id);
    const index = order.indexOf(id);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    setPreferences({ ...preferences, courseOrder: order });
  };

  return (
    <div className="workspace-page">
      <section className="workspace-panel settings-source">
        <div className="section-heading"><h2>数据配置</h2><span>只读模式</span></div>
        <dl>
          <div><dt>配置文件</dt><dd>{settings.configPath}</dd></div>
          <div><dt>课程数量</dt><dd>{settings.courses.length}</dd></div>
        </dl>
      </section>
      <section className="workspace-panel">
        <div className="section-heading"><h2>课程显示与文件状态</h2><span>偏好仅保存在当前浏览器</span></div>
        <div className="settings-courses">
          {ordered.map((course) => {
            const configured = settings.courses.find((item) => item.id === course.id);
            return (
              <article key={course.id}>
                <div className="settings-course-title">
                  <label><input aria-label={`显示${course.shortTitle ?? course.title}`} type="checkbox" checked={!preferences.hiddenCourseIds.includes(course.id)} onChange={() => toggle(course.id)} />{course.title}</label>
                  <div><button aria-label={`上移${course.title}`} onClick={() => move(course.id, -1)}><ArrowUp /></button><button aria-label={`下移${course.title}`} onClick={() => move(course.id, 1)}><ArrowDown /></button></div>
                </div>
                <code>{configured?.root}</code>
                <ul>{configured?.artifacts.map((item) => <li key={item.artifact}>{item.status === "ready" ? <CheckCircle /> : <WarningCircle />}<span>{item.artifact}</span><small>{healthDescription(item)}</small></li>)}</ul>
              </article>
            );
          })}
        </div>
      </section>
      <section className="workspace-panel setup-guide">
        <div className="section-heading"><h2>课程文件规范</h2></div>
        <p>每个课程根目录使用 course.md、notes.md、reviews.md、resources.md、schedule.md 和可选 sessions/。修改 Markdown 后页面会自动刷新。</p>
        <p>掌握度只能填写 1–10；未知日期和分数请留空，不要填写 0。</p>
      </section>
    </div>
  );
}
