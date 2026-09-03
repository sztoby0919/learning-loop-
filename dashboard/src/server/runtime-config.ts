import { existsSync } from "node:fs";
import path from "node:path";

export interface DashboardConfigPathOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  isFile?: (candidate: string) => boolean;
}

export function resolveDashboardConfigPath({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  isFile = existsSync,
}: DashboardConfigPathOptions = {}): string {
  const configFlag = argv.indexOf("--config");
  if (configFlag >= 0) {
    const value = argv[configFlag + 1]?.trim();
    if (!value || value.startsWith("--")) throw new Error("--config 后必须提供路径");
    return value;
  }

  const fromEnvironment = env.STUDY_DASHBOARD_CONFIG?.trim();
  if (fromEnvironment) return fromEnvironment;

  const current = path.resolve(cwd);
  const parent = path.dirname(current);
  const runningFromDashboard = path.basename(current).toLowerCase() === "dashboard";
  const localCandidates = [
    path.join(current, "dashboard.config.local.json"),
    path.join(current, "dashboard.config.json"),
    path.join(current, "dashboard.config.example.json"),
  ];
  const parentCandidates = [
    path.join(parent, "dashboard.config.local.json"),
    path.join(parent, "dashboard.config.json"),
    path.join(parent, "dashboard.config.example.json"),
  ];
  const candidates = runningFromDashboard ? [...parentCandidates, ...localCandidates] : [...localCandidates, ...parentCandidates];
  return candidates.find(isFile) ?? (runningFromDashboard ? parentCandidates[2] : localCandidates[2]);
}
