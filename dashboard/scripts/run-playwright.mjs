import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { withoutProxyEnvironment } from "./playwright-env.mjs";

// Playwright owns the server lifecycle and refuses an occupied port.
// Do not start a second server or probe an unrelated service for readiness.
const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve("@playwright/test/cli")), "test", ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  env: withoutProxyEnvironment(process.env),
  stdio: "inherit",
});
child.once("error", (error) => {
  console.error(`无法启动 Playwright：${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { if (!child.killed) child.kill(signal); });
}
