import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "./app.js";
import { CourseEventBus } from "./course-events.js";
import { startCourseWatcher } from "./course-watcher.js";
import { loadDashboardConfig } from "./dashboard-config.js";
import { resolveDashboardConfigPath } from "./runtime-config.js";
import { WorkspaceRepository } from "./workspace-repository.js";
import { createAiProvider } from "./ai-provider.js";
import { AiService } from "./ai-service.js";
import { resolveAiRuntimeConfig } from "./ai-runtime-config.js";
import { CourseImportManager } from "./course-import-manager.js";
import { createCourseImportAi } from "./course-import-ai.js";

const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.PORT ?? 3000);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const configPath = resolveDashboardConfigPath();
const config = await loadDashboardConfig(configPath, path.join(projectRoot, "learning-journal"));
const todayInShanghai = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const repository = new WorkspaceRepository(config, todayInShanghai);
const events = new CourseEventBus();

const aiRuntime = resolveAiRuntimeConfig(process.env);
const aiService = new AiService({ provider: createAiProvider(aiRuntime.config), maxRetries: 1, timeoutMs: 30000 });

const watcher = startCourseWatcher(repository, events);
const imports = new CourseImportManager({
  root: projectRoot,
  repository,
  events,
  today: todayInShanghai,
  watchCourse: (root) => watcher.add(["course.md", "notes.md", "reviews.md", "resources.md", "schedule.md"].map((name) => path.join(root, name)).concat(path.join(root, "sessions", "*.md"))),
  aiEnricher: aiRuntime.mode === "compatible" ? createCourseImportAi(aiRuntime.config) : undefined,
});
await imports.cleanupExpired();
createApp(repository, events, aiService, imports).listen(port, "127.0.0.1", () => {
  console.log(`Study dashboard server: http://127.0.0.1:${port}`);
  console.log(`Dashboard config: ${config.configPath}`);
  console.log(`Courses: ${config.courses.map((course) => course.id).join(", ")}`);
  console.log(`AI service: ${aiRuntime.mode === "compatible" ? "OpenAI-compatible API" : "mock mode"}`);
});
