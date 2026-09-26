import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CourseImportPage } from "./CourseImportPage.js";

const first = { id: "draft-1", courseId: "course-123", draft: { title: "微积分", originalFilename: "course.pdf", pageCount: 10, goal: "", weeklyHours: null, stages: [{ title: "第一章", tasks: ["阅读第 1 页"] }], notes: [], warnings: ["请核对公式"], aiStatus: "not-used" }, files: { "course.md": "# 微积分", "notes.md": "# 笔记" }, aiAvailable: true, excerptChars: 1200 };

afterEach(() => vi.unstubAllGlobals());

describe("CourseImportPage", () => {
  it("uploads a PDF, lets the user edit the draft, and confirms only after preview", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${input}`);
      const data = input.endsWith("/confirm") ? { courseId: "course-123" } : first;
      return { ok: true, json: async () => data };
    }));
    render(<MemoryRouter initialEntries={["/courses/import"]}><Routes><Route path="/courses/import" element={<CourseImportPage />} /><Route path="/courses/:id" element={<p>课程已创建</p>} /></Routes></MemoryRouter>);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("选择 PDF 文件"), new File(["%PDF-test"], "course.pdf", { type: "application/pdf" }));
    expect(await screen.findByDisplayValue("微积分")).toBeInTheDocument();
    expect(screen.getByText("请核对公式")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("课程名称"));
    await user.type(screen.getByLabelText("课程名称"), "我的课程");
    await user.click(screen.getByRole("button", { name: "确认创建课程" }));
    await waitFor(() => expect(screen.getByText("课程已创建")).toBeInTheDocument());
    expect(calls).toEqual(["POST /api/course-imports", "PATCH /api/course-imports/draft-1", "POST /api/course-imports/draft-1/confirm"]);
  });

  it("never calls AI until the user checks the data-sharing consent", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${input}`);
      return { ok: true, json: async () => first };
    }));
    render(<MemoryRouter><CourseImportPage /></MemoryRouter>);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("选择 PDF 文件"), new File(["%PDF-test"], "course.pdf", { type: "application/pdf" }));
    await screen.findByDisplayValue("微积分");
    expect(screen.getByRole("button", { name: "AI 完善草稿" })).toBeDisabled();
    expect(calls.some((call) => call.includes("enrich"))).toBe(false);
    await user.click(screen.getByLabelText(/同意发送/));
    await user.click(screen.getByRole("button", { name: "AI 完善草稿" }));
    await waitFor(() => expect(calls.some((call) => call.includes("enrich"))).toBe(true));
  });

  it("locks draft editing while AI enhancement is in flight", async () => {
    let releaseEnrich: (() => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input.endsWith("/enrich")) await new Promise<void>((resolve) => { releaseEnrich = resolve; });
      return { ok: true, json: async () => first };
    }));
    render(<MemoryRouter><CourseImportPage /></MemoryRouter>);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("选择 PDF 文件"), new File(["%PDF-test"], "course.pdf", { type: "application/pdf" }));
    await screen.findByDisplayValue("微积分");
    await user.click(screen.getByLabelText(/同意发送/));
    await user.click(screen.getByRole("button", { name: "AI 完善草稿" }));
    await waitFor(() => expect(releaseEnrich).toBeDefined());
    expect(screen.getByRole("status", { name: "AI 正在完善草稿" })).toBeInTheDocument();
    expect(screen.getByLabelText("课程名称")).toBeDisabled();
    expect(screen.getByLabelText("阶段 1")).toBeDisabled();
    expect(screen.getByRole("button", { name: "添加任务" })).toBeDisabled();
    releaseEnrich?.();
    await waitFor(() => expect(screen.getByLabelText("课程名称")).toBeEnabled());
    expect(screen.queryByRole("status", { name: "AI 正在完善草稿" })).not.toBeInTheDocument();
  });
});
