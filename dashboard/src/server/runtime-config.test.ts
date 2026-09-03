import { describe, expect, it } from "vitest";

import { resolveDashboardConfigPath } from "./runtime-config.js";

describe("dashboard 配置入口", () => {
  it("命令行 --config 优先于环境变量和默认文件", () => {
    const result = resolveDashboardConfigPath({
      argv: ["--config", "custom/dashboard.json"],
      env: { STUDY_DASHBOARD_CONFIG: "from-env.json" },
      cwd: "C:\\workspace\\learning-loop",
      isFile: () => true,
    });

    expect(result).toBe("custom/dashboard.json");
  });

  it("兼容 STUDY_DASHBOARD_CONFIG 环境变量", () => {
    const result = resolveDashboardConfigPath({
      env: { STUDY_DASHBOARD_CONFIG: "C:\\notes\\dashboard.json" },
      cwd: "C:\\workspace\\learning-loop",
      isFile: () => false,
    });

    expect(result).toBe("C:\\notes\\dashboard.json");
  });

  it("没有个人配置时回退到仓库 demo 配置", () => {
    const result = resolveDashboardConfigPath({
      cwd: "C:\\workspace\\learning-loop\\dashboard",
      isFile: (candidate) => candidate.endsWith("dashboard.config.example.json"),
    });

    expect(result).toBe("C:\\workspace\\learning-loop\\dashboard.config.example.json");
  });

  it("--config 缺少路径时给出明确错误", () => {
    expect(() => resolveDashboardConfigPath({ argv: ["--config"] })).toThrow("--config 后必须提供路径");
  });
});
