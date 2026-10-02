import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CourseImportPreview } from "../../shared/course-import.js";
import { useImportAutosave } from "./useImportAutosave.js";

const initial: CourseImportPreview = { id: "draft", courseId: "course-123", revision: 0, expiresAt: Date.now() + 86400000,
  draft: { title: "Original", originalFilename: "book.pdf", pageCount: 1, goal: "", weeklyHours: null, stages: [{ id: "11111111-1111-4111-8111-111111111111", title: "Chapter 1", tasks: ["Read"] }], notes: [], warnings: [], aiStatus: "not-used", sourceFormat: "pdf" }, files: {}, aiAvailable: false, excerptChars: 0 };
function Harness() {
  const [preview, setPreview] = useState(initial);
  const autosave = useImportAutosave(preview, (saved) => setPreview(saved));
  return <><input aria-label="title" value={preview.draft.title} onChange={(event) => setPreview({ ...preview, draft: { ...preview.draft, title: event.target.value } })} /><span role="status">{autosave.status}</span><span>{autosave.error?.message}</span><button onClick={() => void autosave.flush().catch(() => {})}>flush</button></>;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("import autosave", () => {
  it("saves only the last valid edit after eight hundred milliseconds", async () => {
    vi.useFakeTimers();
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); requests.push(body);
      return { ok: true, json: async () => ({ ...initial, revision: 1, draft: { ...initial.draft, ...body } }) };
    });
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "First" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Last" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(799); });
    expect(requests).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ expectedRevision: 0, title: "Last" });
    expect(screen.getByRole("status")).toHaveTextContent("saved");
  });

  it("keeps newer input when an older save finishes and uses its revision for the next save", async () => {
    vi.useFakeTimers();
    let release: ((value: unknown) => void) | undefined;
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); requests.push(body);
      if (requests.length === 1) return new Promise((resolve) => { release = resolve; });
      return { ok: true, json: async () => ({ ...initial, revision: 2, draft: { ...initial.draft, title: body.title } }) };
    });
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "First" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Second" } });
    await act(async () => { release!({ ok: true, json: async () => ({ ...initial, revision: 1, draft: { ...initial.draft, title: "First" } }) }); });
    expect(screen.getByLabelText("title")).toHaveValue("Second");
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(requests[1]).toMatchObject({ expectedRevision: 1, title: "Second" });
    expect(screen.getByRole("status")).toHaveTextContent("saved");
  });

  it("keeps invalid temporary input without sending it or claiming it was saved", async () => {
    vi.useFakeTimers(); const requests: unknown[] = [];
    vi.stubGlobal("fetch", async (...args: unknown[]) => { requests.push(args); throw new Error("unexpected request"); });
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(requests).toEqual([]);
    expect(screen.getByRole("status")).toHaveTextContent("invalid");
    expect(screen.getByLabelText("title")).toHaveValue("");
    const leave = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);
  });

  it("shows a revision conflict without silently retrying or overwriting input", async () => {
    vi.useFakeTimers(); let attempts = 0;
    vi.stubGlobal("fetch", async () => { attempts += 1; return { ok: false, status: 409, json: async () => ({ error: "草稿已更新" }) }; });
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Local edit" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(screen.getByRole("status")).toHaveTextContent("conflict");
    expect(screen.getByText("草稿已更新")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(attempts).toBe(1);
    expect(screen.getByLabelText("title")).toHaveValue("Local edit");
  });

  it("does not claim success or automatically retry after a failed write", async () => {
    vi.useFakeTimers(); let attempts = 0;
    vi.stubGlobal("fetch", async () => { attempts += 1; return { ok: false, status: 500, json: async () => ({ error: "无法写入草稿" }) }; });
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Keep this edit" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(screen.getByRole("status")).toHaveTextContent("error");
    expect(screen.getByText("无法写入草稿")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(attempts).toBe(1);
    expect(screen.getByLabelText("title")).toHaveValue("Keep this edit");
  });
});
