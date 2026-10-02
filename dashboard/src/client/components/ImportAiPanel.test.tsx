import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiExcerpt, CourseImportPreview } from "../../shared/course-import.js";
import { ImportAiPanel } from "./ImportAiPanel.js";

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const preview: CourseImportPreview = { id: "draft", courseId: "course-test", revision: 0, draft: { title: "Book", originalFilename: "book.pdf", pageCount: 4, goal: "", weeklyHours: null, stages: [{ id: firstId, title: "Chapter 1", tasks: ["Read first"], source: { title: "Chapter 1", startPage: 1, endPage: 2 } }, { id: secondId, title: "Chapter 2", tasks: ["Read second"], source: { title: "Chapter 2", startPage: 3, endPage: 4 } }, { id: "33333333-3333-4333-8333-333333333333", title: "Manual", tasks: ["Manual task"] }], notes: [], warnings: [], aiStatus: "not-used", sourceFormat: "pdf" }, files: {}, excerptChars: 0, aiAvailable: true };
const excerpt: AiExcerpt = { revision: 0, stageIds: [firstId, secondId], excerptHash: "a".repeat(64), chars: 18, text: "实际发送的目录与正文", pages: [{ stageId: firstId, page: 1, text: "First excerpt" }, { stageId: secondId, page: 3, text: "Second excerpt" }] };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function Harness({ initial = preview, flush, busy = () => {} }: { initial?: CourseImportPreview; flush?: () => Promise<CourseImportPreview>; busy?: (busy: boolean) => void }) {
  const [current, setCurrent] = useState(initial);
  return <ImportAiPanel preview={current} flush={flush ?? (async () => current)} onPreviewChanged={setCurrent} onBusyChange={busy} />;
}

describe("controlled import AI", () => {
  it("removes hidden selected IDs after deleting a source chapter", async () => {
    const changed = vi.fn();
    const requests: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { requests.push(JSON.parse(String(init.body))); return { ok: true, json: async () => excerpt }; });
    const view = render(<ImportAiPanel preview={preview} flush={async () => preview} onPreviewChanged={changed} />);
    const reduced = { ...preview, revision: 1, draft: { ...preview.draft, stages: preview.draft.stages.filter((stage) => stage.id !== secondId) } };
    view.rerender(<ImportAiPanel preview={reduced} flush={async () => reduced} onPreviewChanged={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "查看将发送的摘录" }));
    await waitFor(() => expect(requests).toEqual([{ expectedRevision: 1, stageIds: [firstId] }]));
  });

  it("requires visible exact excerpt and fresh consent after changing chapters", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => excerpt }; });
    render(<Harness />);
    expect(screen.getByLabelText("完善 Manual")).toBeDisabled();
    expect(screen.getByRole("button", { name: "AI 完善草稿" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "查看将发送的摘录" }));
    expect(await screen.findByText("实际发送的目录与正文")).toBeInTheDocument();
    expect(screen.getByText(/第 1 页/)).toBeInTheDocument();
    expect(calls).toEqual(["/api/course-imports/draft/ai-excerpt"]);
    fireEvent.click(screen.getByLabelText(/同意发送/));
    expect(screen.getByRole("button", { name: "AI 完善草稿" })).toBeEnabled();
    fireEvent.click(screen.getByLabelText("完善 Chapter 2"));
    expect(screen.queryByText("实际发送的目录与正文")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI 完善草稿" })).toBeDisabled();
  });
  it("flushes before starting and never silently submits a changed excerpt", async () => {
    const calls: string[] = []; let flushes = 0;
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => excerpt }; });
    render(<Harness flush={async () => { flushes += 1; return flushes === 1 ? preview : { ...preview, revision: 1 }; }} />);
    fireEvent.click(screen.getByRole("button", { name: "查看将发送的摘录" }));
    await screen.findByText("实际发送的目录与正文");
    fireEvent.click(screen.getByLabelText(/同意发送/));
    fireEvent.click(screen.getByRole("button", { name: "AI 完善草稿" }));
    expect(await screen.findByText(/草稿已改变/)).toBeInTheDocument();
    expect(flushes).toBe(2);
    expect(calls).toEqual(["/api/course-imports/draft/ai-excerpt"]);
  });
  it("shows actual wait seconds and does not pretend a failed cancellation succeeded", async () => {
    const initial = { ...preview, operation: { id: "operation", status: "running" as const, startedAt: Date.now() - 4000 } };
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => init.method === "DELETE" ? { ok: false, status: 500, json: async () => ({ error: "取消失败" }) } : new Promise(() => {}));
    const busy = vi.fn(); render(<Harness initial={initial} busy={busy} />);
    expect(screen.getByRole("status", { name: "AI 正在完善草稿" })).toHaveTextContent(/已等待 [4-9] 秒/);
    fireEvent.click(screen.getByRole("button", { name: "取消 AI 请求" }));
    expect(await screen.findByText("取消失败")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "AI 正在完善草稿" })).toBeInTheDocument();
    expect(busy).toHaveBeenLastCalledWith(true);
  });
  it("resumes only GET polling, advances real wait time and ignores a late response after unmount", async () => {
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    const requests: string[] = [];
    vi.stubGlobal("fetch", (url: string) => { requests.push(url); return new Promise((resolve) => { release = resolve; }); });
    const changed = vi.fn();
    const initial = { ...preview, operation: { id: "operation", status: "running" as const, startedAt: Date.now() - 4000 } };
    const view = render(<ImportAiPanel preview={initial} flush={async () => initial} onPreviewChanged={changed} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status", { name: "AI 正在完善草稿" })).toHaveTextContent("已等待 7 秒");
    expect(requests).toEqual(["/api/course-imports/draft/ai-operations/operation"]);
    view.unmount();
    await act(async () => { release({ ok: true, json: async () => ({ ...initial.operation, status: "complete" }) }); await vi.advanceTimersByTimeAsync(3000); });
    expect(changed).not.toHaveBeenCalled(); expect(requests).toHaveLength(1);
  });
  it("compares chapter suggestions and applies only checked chapters, then allows undo", async () => {
    const candidate = { id: "candidate", baseRevision: 0, suggestions: [{ stageId: firstId, title: "AI first", tasks: ["AI task"], notes: [] }, { stageId: secondId, title: "AI second", tasks: ["Other task"], notes: [] }] };
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { requests.push({ url, body: JSON.parse(String(init.body)) }); return { ok: true, json: async () => url.endsWith("ai-undo") ? { ...preview, revision: 2 } : { ...preview, revision: 1, canUndo: true } }; });
    render(<Harness initial={{ ...preview, candidate }} />);
    expect(screen.getByText("AI first")).toBeInTheDocument(); expect(screen.getByText("Read second")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("接受 Chapter 1 的建议"));
    fireEvent.click(screen.getByRole("button", { name: "应用所选建议" }));
    await waitFor(() => expect(requests[0]).toMatchObject({ url: "/api/course-imports/draft/ai-candidates/candidate/apply", body: { expectedRevision: 0, acceptedStageIds: [firstId] } }));
    fireEvent.click(await screen.findByRole("button", { name: "撤销最近一次 AI 应用" }));
    await waitFor(() => expect(requests[1]).toMatchObject({ url: "/api/course-imports/draft/ai-undo", body: { expectedRevision: 1 } }));
  });
});
