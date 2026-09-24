import { createApp } from "./app.js";
import { CourseEventBus } from "./course-events.js";
import { startCourseWatcher } from "./course-watcher.js";
import { loadDashboardConfig } from "./dashboard-config.js";
import { resolveDashboardConfigPath } from "./runtime-config.js";
import { WorkspaceRepository } from "./workspace-repository.js";
import { createAiProvider } from "./ai-provider.js";
import { AiService } from "./ai-service.js";

const port = Number(process.env.PORT ?? 3000);
const configPath = resolveDashboardConfigPath();
const config = await loadDashboardConfig(configPath);
const todayInShanghai = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const repository = new WorkspaceRepository(config, todayInShanghai);
const events = new CourseEventBus();

// 初始化 AI 服务
const aiConfig = {
  baseUrl: process.env.AI_BASE_URL || "https://api.ecloud.10086.cn",
  apiKey: <REDACTED> || "",
  model: process.env.AI_MODEL || "mock-model",
  maxTokens: 2000,
  temperature: 0.7,
};
const aiProvider = createAiProvider(aiConfig);
const aiService = new AiService({ provider: aiProvider, maxRetries: 1, timeoutMs: 30000 });

startCourseWatcher(repository, events);
createApp(repository, events, aiService).listen(port, "127.0.0.1", () => {
  console.log(`Study dashboard server: http://127.0.0.1:${port}`);
  console.log(`Dashboard config: ${config.configPath}`);
  console.log(`Courses: ${config.courses.map((course) => course.id).join(", ")}`);
  console.log(`AI service: ${aiConfig.apiKey ? "configured" : "mock mode"}`);
});
