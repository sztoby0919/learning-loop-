import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";

const courses = { courses: [{ id: "compiler", title: "编译原理", shortTitle: "编译原理", accent: "#27624B", updated: "2026-08-29", status: "ready", progress: 0, completedTasks: 0, totalTasks: 1, currentStage: "词法分析", nextTask: "完成 Lexer", mastery: null }], recentRecords: [], warningCount: 0 };
const tasks = [{ courseId: "compiler", courseTitle: "编译原理", accent: "#27624B", stage: "词法分析", text: "完成 Lexer", completed: false }];

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  close() {}
}

describe("App workspace routes", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/tasks");
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url === "/api/tasks" ? tasks : courses;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });

  it("任务路由加载课程和任务聚合数据", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "任务", level: 1 })).toBeInTheDocument();
    expect(await screen.findByText("完成 Lexer")).toBeInTheDocument();
  });
});
