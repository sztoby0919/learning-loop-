import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../App.js";

const mistake = {
  id: "mistake-1", courseId: "calculus-101", question: "导数表示什么？",
  selected: "A. 平均变化率", correct: "B. 瞬时变化率", explanation: "导数描述某一点的瞬时变化率。",
  knowledgePoint: "导数", date: "2026-09-28", sourceSession: "confirmed.md", mode: "mock",
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  private listeners = new Map<string, (event: MessageEvent) => void>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeEventSource.instances.push(this); }
  addEventListener(name: string, listener: EventListener) { this.listeners.set(name, listener as (event: MessageEvent) => void); }
  emit(courseId: string) { this.listeners.get("journal-updated")?.({ data: JSON.stringify({ courseId }) } as MessageEvent); }
  close() {}
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => { vi.unstubAllGlobals(); FakeEventSource.instances = []; });

describe("MistakesPage", () => {
  it("shows confirmed course mistakes and refreshes the list when that course changes", async () => {
    let items = [mistake];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/courses/calculus-101/mistakes") return response({ items, warnings: [] });
      return response({ courses: [], recentRecords: [], warningCount: 0 });
    }));
    window.history.pushState({}, "", "/courses/calculus-101/mistakes");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "错题本" })).toBeInTheDocument();
    expect(await screen.findByText("导数表示什么？")).toBeInTheDocument();
    expect(screen.getByText(/你的选择：A\. 平均变化率/)).toBeInTheDocument();
    expect(screen.getByText(/正确答案：B\. 瞬时变化率/)).toBeInTheDocument();
    expect(screen.getByText(/Mock.*演示记录/)).toBeInTheDocument();
    items = [];
    FakeEventSource.instances.at(-1)?.emit("other-course");
    expect(screen.getByText("导数表示什么？")).toBeInTheDocument();
    FakeEventSource.instances.at(-1)?.emit("calculus-101");
    expect(await screen.findByText(/暂无已确认的错题/)).toBeInTheDocument();
  });

  it("submits once, shows explanation, confirms, and leaves the mock result clearly marked", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body && JSON.parse(String(init.body)) });
      if (url.endsWith("/mistakes")) return response({ items: [mistake], warnings: [] });
      if (url === "/api/practice-sessions") return response({ sessionId: "session-1", mode: "mock", question: { id: "question-2", question: "切线斜率表示什么？", knowledgePoint: "导数", options: ["平均变化", "瞬时变化", "函数值", "面积"] } }, 201);
      if (url.endsWith("/answer")) return response({ feedback: { questionId: "question-2", isCorrect: false, score: 0, correctPart: "B. 瞬时变化", gap: "你选择了 A. 平均变化", evidence: "切线斜率对应瞬时变化率。" } });
      if (url.endsWith("/confirm")) return response({ courseId: "calculus-101", mode: "mock", sessionFile: "saved.md" });
      return response({ courses: [], recentRecords: [], warningCount: 0 });
    }));
    window.history.pushState({}, "", "/courses/calculus-101/mistakes");
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "针对这道错题再练" }));
    expect(await screen.findByRole("heading", { name: "切线斜率表示什么？" })).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/Mock.*演示题/);
    const choices = screen.getByRole("group", { name: "选择一个答案" });
    await user.click(within(choices).getByRole("radio", { name: "A. 平均变化" }));
    await user.click(screen.getByRole("button", { name: "提交回答" }));
    expect(await screen.findByText(/解析：切线斜率对应瞬时变化率/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "提交回答" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认保存练习" }));
    expect(await screen.findByText(/Mock.*演示.*已保存/)).toBeInTheDocument();
    expect(screen.queryByText(/已掌握/)).not.toBeInTheDocument();
    await waitFor(() => expect(calls.filter((call) => call.url.endsWith("/answer"))).toHaveLength(1));
    expect(calls.find((call) => call.url === "/api/practice-sessions")?.body).toEqual({ courseId: "calculus-101", mistakeId: "mistake-1", kind: "targeted-practice" });
    expect(calls.find((call) => call.url.endsWith("/answer"))?.body).toEqual({ questionId: "question-2", choice: "A" });
  });

  it("reports loading failures and malformed session warnings", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/mistakes")
      ? response({ items: [], warnings: ["broken.md: 缺少题目作答"] })
      : response({ courses: [], recentRecords: [], warningCount: 0 })));
    window.history.pushState({}, "", "/courses/calculus-101/mistakes");
    render(<App />);
    expect(await screen.findByText(/暂无已确认的错题/)).toBeInTheDocument();
    expect(screen.getByText(/broken.md: 缺少题目作答/)).toBeInTheDocument();
  });
});
