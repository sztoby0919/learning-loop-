import { defineConfig, devices } from "@playwright/test";

const e2ePort = 4274;
const browserChannel = process.platform === "win32" ? ("msedge" as const) : undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${e2ePort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], ...(browserChannel ? { channel: browserChannel } : {}), viewport: { width: 1440, height: 1000 } } },
    { name: "tablet", use: { ...devices["Desktop Chrome"], ...(browserChannel ? { channel: browserChannel } : {}), viewport: { width: 900, height: 1100 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], ...(browserChannel ? { channel: browserChannel } : {}) } },
  ],
  webServer: {
    command: "node --import tsx/esm src/server/index.ts",
    url: `http://127.0.0.1:${e2ePort}/api/courses`,
    env: {
      PORT: String(e2ePort),
      AI_API_KEY: "",
      AI_MODE: "mock",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    },
    reuseExistingServer: true,
    gracefulShutdown: { signal: "SIGTERM", timeout: 1_000 },
    timeout: 30_000,
  },
});
