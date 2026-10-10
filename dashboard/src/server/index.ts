import { existsSync, realpathSync } from "node:fs";
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
import { AI_TIMEOUT_MS } from "./ai-request.js";
import { resolveAiRuntimeConfig } from "./ai-runtime-config.js";
import { CourseImportManager } from "./course-import-manager.js";
import { createCourseImportAi } from "./course-import-ai.js";
import { recoverImportCommits } from "./course-import-recovery.js";
import { recoverRestoreTransactions } from "./course-restore-recovery.js";
import { CourseRestoreManager } from "./course-restore.js";
import { BackupZipCodec } from "./backup-zip.js";
import { CourseBundles } from "./course-bundles.js";

const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.PORT ?? 3000);
// Canonical project root: the native file helper binds every path component with
// O_NOFOLLOW, so a workspace reached through a symlink (iCloud's ~/Documents,
// /tmp or /var on macOS) must be resolved once before any ZIP operation.
const projectRoot = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."));
const configPath = resolveDashboardConfigPath();
const recoveryIssues = await recoverImportCommits(projectRoot);
let zipAvailable = true;
try { await recoverRestoreTransactions(projectRoot); }
catch { zipAvailable = false; console.warn("ZIP 备份恢复不可用：需要当前系统可运行项目内固定的原生文件辅助进程，并具备可核验的事务目录。原数据已保留，健康课程与普通导入继续可用。"); }
for (const issue of recoveryIssues) console.warn(`Import recovery ${issue.courseId}: ${issue.warning}`);
const config = await loadDashboardConfig(configPath, path.join(projectRoot, "learning-journal"));
const todayInShanghai = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const repository = new WorkspaceRepository(config, todayInShanghai);
const events = new CourseEventBus();

const aiRuntime = resolveAiRuntimeConfig(process.env);
const aiService = new AiService({ provider: createAiProvider(aiRuntime.config), maxRetries: 1, timeoutMs: AI_TIMEOUT_MS });

const watcher = startCourseWatcher(repository, events);
const imports = new CourseImportManager({
  root: projectRoot,
  repository,
  events,
  today: todayInShanghai,
  watchCourse: (root) => watcher.add(["course.md", "notes.md", "reviews.md", "resources.md", "schedule.md"].map((name) => path.join(root, name)).concat(path.join(root, "sessions", "*.md"))),
  aiEnricher: aiRuntime.mode === "compatible" ? createCourseImportAi(aiRuntime.config) : undefined,
});
await imports.initialize();
const bundles = new CourseBundles(imports, repository, events);
await bundles.initialize();
const restores = zipAvailable ? new CourseRestoreManager({ root: projectRoot, repository, events, codec: new BackupZipCodec(), watchCourse: (root) => watcher.add(["course.md", "notes.md", "reviews.md", "resources.md", "schedule.md"].map((name) => path.join(root, name)).concat(path.join(root, "sessions", "*.md"))) }) : undefined;
if (restores) { try { await restores.initialize(); } catch { zipAvailable = false; console.warn("ZIP 恢复初始化失败，已保留事务目录。请核对后重新启动；其他功能继续可用。"); } }
createApp(repository, events, aiService, imports, aiRuntime.mode === "compatible" ? "real" : "mock", zipAvailable ? restores : undefined, bundles).listen(port, "127.0.0.1", () => {
  console.log(`Study dashboard server: http://127.0.0.1:${port}`);
  console.log(`Dashboard config: ${config.configPath}`);
  console.log(`Courses: ${config.courses.map((course) => course.id).join(", ")}`);
  console.log(`AI service: ${aiRuntime.mode === "compatible" ? "OpenAI-compatible API" : "mock mode"}`);
});
