import { createApp } from "./app.js";
import { CourseEventBus } from "./course-events.js";
import { startCourseWatcher } from "./course-watcher.js";
import { loadDashboardConfig } from "./dashboard-config.js";
import { resolveDashboardConfigPath } from "./runtime-config.js";
import { WorkspaceRepository } from "./workspace-repository.js";

const port = Number(process.env.PORT ?? 4174);
const configPath = resolveDashboardConfigPath();
const config = await loadDashboardConfig(configPath);
const todayInShanghai = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const repository = new WorkspaceRepository(config, todayInShanghai);
const events = new CourseEventBus();

startCourseWatcher(repository, events);
createApp(repository, events).listen(port, "127.0.0.1", () => {
  console.log(`Study dashboard server: http://127.0.0.1:${port}`);
  console.log(`Dashboard config: ${config.configPath}`);
  console.log(`Courses: ${config.courses.map((course) => course.id).join(", ")}`);
});
