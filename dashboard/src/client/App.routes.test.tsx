import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CourseDetail, SourceReference } from "../shared/course.js";
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

  it("课程路由参数切换时，等待新课程响应期间不显示旧课程和旧来源", async () => {
    const detailA: CourseDetail = {
      ...courses.courses[0], id: "course-a", title: "课程 A", status: "ready", overviewMarkdown: "A 概览",
      keyPointsMarkdown: "### 正则表达式\n\nA 内容", mistakesMarkdown: "", stages: [], records: [], warnings: [],
      sourcePath: "course-a/course.md",
    };
    const detailB: CourseDetail = {
      ...detailA, id: "course-b", title: "课程 B", overviewMarkdown: "B 概览",
      keyPointsMarkdown: "### 编译流程\n\nB 内容", sourcePath: "course-b/course.md",
    };
    const sourceA: SourceReference = {
      artifact: "course", headingIndex: 0, heading: "正则表达式", kind: "pdf-page", position: 1,
      sourceUrl: "/api/courses/course-a/source#page=1", verifiedExcerpt: null, aiDerived: false,
    };
    let resolveB!: (response: Response) => void;
    const delayedB = new Promise<Response>((resolve) => { resolveB = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/courses/course-b") return delayedB;
      const body = url === "/api/courses/course-a" ? detailA
        : url === "/api/courses/course-b/source-references" ? []
          : url === "/api/courses/course-a/source-references" ? [sourceA] : courses;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
    }));

    window.history.pushState({}, "", "/courses/course-a");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "课程 A", level: 1 }, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "打开原文件：正则表达式" }, { timeout: 10_000 })).toBeInTheDocument();

    act(() => {
      window.history.pushState({}, "", "/courses/course-b");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.queryByRole("heading", { name: "课程 A", level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "打开原文件：正则表达式" })).not.toBeInTheDocument();

    resolveB(new Response(JSON.stringify(detailB), { status: 200, headers: { "Content-Type": "application/json" } }));
    expect(await screen.findByRole("heading", { name: "课程 B", level: 1 }, { timeout: 10_000 })).toBeInTheDocument();
  });
});
