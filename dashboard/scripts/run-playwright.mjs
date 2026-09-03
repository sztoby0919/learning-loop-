import { spawn } from "node:child_process";
import path from "node:path";

import { withoutProxyEnvironment } from "./playwright-env.mjs";

const port = 4274;
const baseUrl = `http://127.0.0.1:${port}`;
const environment = {
  ...withoutProxyEnvironment(process.env),
  PORT: String(port),
};
const server = spawn(process.execPath, ["--import", "tsx/esm", "src/server/index.ts"], {
  cwd: process.cwd(),
  env: environment,
  stdio: "inherit",
});
const cli = path.resolve(
  process.cwd(),
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);

function serverIsReady() {
  return fetch(`${baseUrl}/api/courses`)
    .then((response) => response.ok)
    .catch(() => false);
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await serverIsReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("dashboard server 在 30 秒内没有启动");
}

function stopServer() {
  if (!server.killed) server.kill();
}

try {
  await waitForServer();
  const child = spawn(process.execPath, [cli, "test", ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: withoutProxyEnvironment(process.env),
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    stopServer();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
} catch (error) {
  stopServer();
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

process.once("SIGINT", () => {
  stopServer();
  process.exitCode = 130;
});
process.once("SIGTERM", () => {
  stopServer();
  process.exitCode = 143;
});
