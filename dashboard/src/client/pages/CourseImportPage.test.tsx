import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Link, MemoryRouter, Route, RouterProvider, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CourseImportPage } from "./CourseImportPage.js";

const firstId = "11111111-1111-4111-8111-111111111111";
const first = { id: "draft-1", courseId: "course-123", revision: 0, draft: { title: "微积分", originalFilename: "course.pdf", pageCount: 10, goal: "", weeklyHours: null, stages: [{ id: firstId, title: "第一章", tasks: ["阅读第 1 页"], source: { title: "第一章", startPage: 1, endPage: 10 } }], notes: [], warnings: ["请核对公式"], aiStatus: "not-used", sourceFormat: "pdf" }, files: { "course.md": "# 微积分", "notes.md": "# 笔记" }, aiAvailable: true, excerptChars: 1200 };
const firstExcerpt = { revision: 0, stageIds: [firstId], excerptHash: "a".repeat(64), text: "实际摘录", chars: 4, pages: [{ stageId: firstId, page: 1, text: "实际摘录" }] };
const docxPreview = { id: "draft-2", courseId: "course-456", draft: { title: "线性代数", originalFilename: "大纲.docx", pageCount: 5, goal: "", weeklyHours: null, stages: [{ title: "第一章", tasks: ["阅读第 1 页"] }], notes: [], warnings: ["Word 文档转换警告"], aiStatus: "not-used", sourceFormat: "docx" }, files: { "course.md": "# 线性代数", "notes.md": "# 笔记" }, aiAvailable: false, excerptChars: 800 };
const textPreview = { id: "draft-3", courseId: "course-789", draft: { title: "算法笔记", originalFilename: "notes.md", pageCount: 3, goal: "", weeklyHours: null, stages: [{ title: "排序", tasks: ["学习快速排序"] }], notes: [], warnings: ["未检测到 Markdown 标题"], aiStatus: "not-used", sourceFormat: "text" }, files: { "course.md": "# 算法笔记", "notes.md": "# 笔记" }, aiAvailable: false, excerptChars: 500 };
const htmlPreview = { id: "draft-4", courseId: "course-abc", draft: { title: "网页教程", originalFilename: "tutorial.html", pageCount: 2, goal: "", weeklyHours: null, stages: [{ title: "第一章", tasks: ["学习基础"] }], notes: [], warnings: [], aiStatus: "not-used", sourceFormat: "text" }, files: { "course.md": "# 网页教程", "notes.md": "# 笔记" }, aiAvailable: false, excerptChars: 600 };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function mockUpload(preview: unknown, responses?: Array<{ status: number; body: unknown }>) {
  const attempts: File[] = [];
  vi.stubGlobal("XMLHttpRequest", class {
    upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    status = 201;
    responseText = "";
    open() {}
    send(body: FormData) {
      attempts.push(body.get("file") as File);
      const response = responses?.shift() ?? { status: 201, body: preview };
      this.status = response.status;
      this.responseText = JSON.stringify(response.body);
      queueMicrotask(() => this.onload?.());
    }
  });
  return attempts;
}

describe("CourseImportPage", () => {
  it("protects dirty and invalid input from SPA links and history navigation", async () => {
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => first }));
    const router = createMemoryRouter([
      { path: "/courses/import", element: <><Link to="/courses">课程列表</Link><CourseImportPage /></> },
      { path: "/courses", element: <p>课程列表页面</p> },
    ], { initialEntries: ["/courses", "/courses/import?draft=draft-1"], initialIndex: 1 });
    render(<RouterProvider router={router} />);
    await screen.findByDisplayValue("微积分");
    fireEvent.change(screen.getByLabelText("课程名称"), { target: { value: "尚未保存" } });
    fireEvent.click(screen.getByRole("link", { name: "课程列表" }));
    await waitFor(() => expect(confirmation).toHaveBeenCalled());
    expect(screen.getByLabelText("课程名称")).toHaveValue("尚未保存");
    fireEvent.change(screen.getByLabelText("课程名称"), { target: { value: "" } });
    await act(async () => { await router.navigate(-1); });
    expect(screen.getByLabelText("课程名称")).toHaveValue("");
    confirmation.mockReturnValue(true);
    fireEvent.click(screen.getByRole("link", { name: "课程列表" }));
    expect(await screen.findByText("课程列表页面")).toBeInTheDocument();
    router.dispose();
  });

  it("continues a saved draft from its URL and displays its saved revision", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => { requests.push(input); return { ok: true, json: async () => ({ ...first, revision: 3 }) }; });
    render(<MemoryRouter initialEntries={["/courses/import?draft=draft-1"]}><CourseImportPage /></MemoryRouter>);
    expect(await screen.findByDisplayValue("微积分")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "草稿保存状态" })).toHaveTextContent("已保存");
    expect(requests).toContain("/api/course-imports/draft-1");
  });

  it("keeps a recovery entry visible when confirmed deletion fails", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", async (_input: string, init: RequestInit) => init.method === "DELETE" ? { ok: false, status: 500 } : { ok: true, json: async () => [{ id: "draft-1", title: "恢复课程", status: "ready", expiresAt: Date.now() + 86400000, updatedAt: Date.now() }] });
    render(<MemoryRouter><CourseImportPage /></MemoryRouter>);
    expect(await screen.findByText("恢复课程")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除恢复课程草稿" }));
    expect(await screen.findByText("取消导入失败，请稍后重试")).toBeInTheDocument();
    expect(screen.getByText("恢复课程")).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("requires confirmation before discarding local edits after a revision conflict", async () => {
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(false);
    mockUpload({ ...first, revision: 0 });
    let reloads = 0;
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      if (input === "/api/course-imports") return { ok: true, json: async () => [] };
      if (init.method === "PATCH") return { ok: false, status: 409, json: async () => ({ error: "另一个标签页已保存修改" }) };
      reloads += 1;
      return { ok: true, json: async () => ({ ...first, revision: 1, draft: { ...first.draft, title: "服务器版本" } }) };
    });
    render(<MemoryRouter><CourseImportPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("选择文件"), { target: { files: [new File(["%PDF"], "course.pdf")] } });
    await screen.findByDisplayValue("微积分");
    fireEvent.change(screen.getByLabelText("课程名称"), { target: { value: "本地编辑" } });
    fireEvent.click(screen.getByRole("button", { name: "更新预览" }));
    await screen.findByRole("button", { name: "重新加载已保存草稿" });
    fireEvent.click(screen.getByRole("button", { name: "重新加载已保存草稿" }));
    expect(screen.getByLabelText("课程名称")).toHaveValue("本地编辑");
    expect(reloads).toBe(0);
    confirmation.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "重新加载已保存草稿" }));
    await screen.findByDisplayValue("服务器版本");
    expect(reloads).toBe(1);
  });

  it("uploads a PDF, lets the user edit the draft, and confirms only after preview", async () => {
    const calls: string[] = [];
    mockUpload(first);
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${input}`);
      const data = input === "/api/course-imports" ? [] : input.endsWith("/confirm") ? { courseId: "course-123" } : { ...first, revision: 1, draft: { ...first.draft, ...JSON.parse(String(init?.body ?? "{}")) } };
      return { ok: true, json: async () => data };
    }));
    render(<MemoryRouter initialEntries={["/courses/import"]}><Routes><Route path="/courses/import" element={<CourseImportPage />} /><Route path="/courses/:id" element={<p>课程已创建</p>} /></Routes></MemoryRouter>);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("选择文件"), new File(["%PDF-test"], "course.pdf", { type: "application/pdf" }));
    expect(await screen.findByDisplayValue("微积分")).toBeInTheDocument();
    expect(screen.getByText("请核对公式")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("课程名称"));
    await user.type(screen.getByLabelText("课程名称"), "我的课程");
    await user.click(screen.getByRole("button", { name: "确认创建课程" }));
    await waitFor(() => expect(screen.getByText("课程已创建")).toBeInTheDocument());
    expect(calls).toEqual(["GET /api/course-imports", "PATCH /api/course-imports/draft-1", "POST /api/course-imports/draft-1/confirm"]);
  });

  it("never calls AI until the user checks the data-sharing consent", async () => {
    const calls: string[] = [];
    mockUpload(first);
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${input}`);
      return { ok: true, json: async () => input.endsWith("/ai-excerpt") ? firstExcerpt : input.endsWith("/ai-operations") ? { id: "operation", startedAt: Date.now(), status: "complete" } : first };
    }));
    render(<MemoryRouter><CourseImportPage /></MemoryRouter>);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("选择文件"), new File(["%PDF-test"], "course.pdf", { type: "application/pdf" }));
    await screen.findByDisplayValue("微积分");
    expect(screen.getByRole("button", { name: "AI 完善草稿" })).toBeDisabled();
    expect(calls.some((call) => call.includes("ai-operations"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "查看将发送的摘录" }));
    await screen.findByLabelText(/同意发送/);
    await user.click(screen.getByLabelText(/同意发送/));
    await user.click(screen.getByRole("button", { name: "AI 完善草稿" }));
    await waitFor(() => expect(calls.some((call) => call.includes("ai-operations"))).toBe(true));
  });

  it("keeps the exact excerpt visible after flushing previously unsaved edits", async () => {
    mockUpload(first);
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      const data = input.endsWith("/ai-excerpt") ? { ...firstExcerpt, revision: 1, text: "新课程的实际摘录" } : init.method === "PATCH" ? { ...first, revision: 1, draft: { ...first.draft, ...JSON.parse(String(init.body)) } } : [];
      return { ok: true, json: async () => data };
    });
    render(<MemoryRouter><CourseImportPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("选择文件"), { target: { files: [new File(["%PDF"], "course.pdf")] } });
    await screen.findByDisplayValue("微积分");
    fireEvent.change(screen.getByLabelText("课程名称"), { target: { value: "新课程" } });
    fireEvent.click(screen.getByRole("button", { name: "查看将发送的摘录" }));
    expect(await screen.findByText("新课程的实际摘录")).toBeInTheDocument();
    expect(screen.getByLabelText(/同意发送/)).toBeEnabled();
    expect(screen.getByLabelText("课程名称")).toHaveValue("新课程");
  });

  it("locks draft editing while AI enhancement is in flight", async () => {
    let releaseEnrich: (() => void) | undefined;
    mockUpload(first);
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input.endsWith("/ai-operations")) await new Promise<void>((resolve) => { releaseEnrich = resolve; });
      return { ok: true, json: async () => input.endsWith("/ai-excerpt") ? firstExcerpt : input.endsWith("/ai-operations") ? { id: "operation", startedAt: Date.now(), status: "complete" } : first };
    }));
    render(<MemoryRouter><CourseImportPage /></MemoryRouter>);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("选择文件"), new File(["%PDF-test"], "course.pdf", { type: "application/pdf" }));
    await screen.findByDisplayValue("微积分");
    await user.click(screen.getByRole("button", { name: "查看将发送的摘录" }));
    await screen.findByLabelText(/同意发送/);
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

  it("shows a file type badge after uploading a .docx file", async () => {
    mockUpload(docxPreview);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => docxPreview })));
    render(<MemoryRouter><CourseImportPage /></MemoryRouter>);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("选择文件"), new File(["PK-test"], "大纲.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    expect(await screen.findByDisplayValue("线性代数")).toBeInTheDocument();
    expect(screen.getByText("Word")).toBeInTheDocument();
    expect(screen.getByText(/大纲\.docx/)).toBeInTheDocument();
  });

  it("shows a TEXT badge after uploading a .md file", async () => {
    mockUpload(textPreview);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => textPreview })));
    render(<MemoryRouter><CourseImportPage /></MemoryRouter>);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("选择文件"), new File(["# 标题\n内容"], "notes.md", { type: "text/markdown" }));
    expect(await screen.findByDisplayValue("算法笔记")).toBeInTheDocument();
    expect(screen.getByText("TEXT")).toBeInTheDocument();
  });

  it("rejects unsupported file types", async () => {
    mockUpload(first);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => first })));
    render(<MemoryRouter><CourseImportPage /></MemoryRouter>);
    const user = userEvent.setup();
    const file = new File(["text"], "image.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("选择文件"), { target: { files: [file] } });
    expect(screen.getByText("请选择 PDF、Word (.docx)、Markdown (.md/.txt) 或 HTML 文件")).toBeInTheDocument();
  });

  it("shows a retry button after upload failure", async () => {
    const attempts = mockUpload(first, [{ status: 413, body: { error: "文件过大" } }, { status: 201, body: first }]);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 413, json: async () => ({ error: "文件过大" }) })));
    render(<MemoryRouter><CourseImportPage /></MemoryRouter>);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("选择文件"), new File(["%PDF-test"], "course.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("文件过大")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByDisplayValue("微积分")).toBeInTheDocument();
    expect(attempts).toHaveLength(2);
  });

  it("uploads a dropped file through the same import flow", async () => {
    mockUpload(first);
    render(<MemoryRouter><CourseImportPage /></MemoryRouter>);
    const file = new File(["%PDF-test"], "course.pdf", { type: "application/pdf" });
    fireEvent.drop(screen.getByText("上传课件或教材"), { dataTransfer: { files: [file] } });
    expect(await screen.findByDisplayValue("微积分")).toBeInTheDocument();
  });

  it("ignores a second dropped file while an upload is in progress", async () => {
    const pending: Array<() => void> = [];
    vi.stubGlobal("XMLHttpRequest", class {
      upload = { onprogress: null };
      onload: (() => void) | null = null;
      status = 201;
      responseText = JSON.stringify(first);
      open() {}
      send() { pending.push(() => this.onload?.()); }
    });
    render(<MemoryRouter><CourseImportPage /></MemoryRouter>);
    const firstFile = new File(["%PDF-a"], "a.pdf", { type: "application/pdf" });
    const secondFile = new File(["%PDF-b"], "b.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("选择文件"), { target: { files: [firstFile] } });
    fireEvent.drop(screen.getByText("上传课件或教材"), { dataTransfer: { files: [secondFile] } });
    expect(pending).toHaveLength(1);
    await act(async () => pending[0]());
  });

  it("allows reordering stages with move up/down buttons", async () => {
    const twoStage = { ...first, draft: { ...first.draft, stages: [{ title: "第一阶段", tasks: ["任务1"] }, { title: "第二阶段", tasks: ["任务2"] }] } };
    mockUpload(twoStage);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => twoStage })));
    render(<MemoryRouter><CourseImportPage /></MemoryRouter>);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("选择文件"), new File(["%PDF-test"], "course.pdf", { type: "application/pdf" }));
    await screen.findByDisplayValue("第一阶段");

    // Move second stage up
    const moveUpButtons = screen.getAllByTitle("上移");
    await user.click(moveUpButtons[1]); // Second stage's up button
    expect(await screen.findByDisplayValue("第二阶段")).toBeInTheDocument();

    // First input should now be "第二阶段"
    const stageInputs = screen.getAllByLabelText("阶段 1");
    expect(stageInputs[0]).toHaveValue("第二阶段");
  });

  it("disables move up button for first stage and move down button for last stage", async () => {
    const twoStage = { ...first, draft: { ...first.draft, stages: [{ title: "第一阶段", tasks: ["任务1"] }, { title: "第二阶段", tasks: ["任务2"] }] } };
    mockUpload(twoStage);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => twoStage })));
    render(<MemoryRouter><CourseImportPage /></MemoryRouter>);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("选择文件"), new File(["%PDF-test"], "course.pdf", { type: "application/pdf" }));
    await screen.findByDisplayValue("第一阶段");

    // First stage's up button should be disabled
    const upButtons = screen.getAllByTitle("上移");
    expect(upButtons[0]).toBeDisabled();
    // Last stage's down button should be disabled
    const downButtons = screen.getAllByTitle("下移");
    expect(downButtons[1]).toBeDisabled();
  });

  it("shows a TEXT badge after uploading an .html file", async () => {
    mockUpload(htmlPreview);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => htmlPreview })));
    render(<MemoryRouter><CourseImportPage /></MemoryRouter>);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("选择文件"), new File(["<html><h1>网页教程</h1></html>"], "tutorial.html", { type: "text/html" }));
    expect(await screen.findByDisplayValue("网页教程")).toBeInTheDocument();
    expect(screen.getByText("TEXT")).toBeInTheDocument();
  });

  it("rejects .png files with correct error message", async () => {
    mockUpload(first);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => first })));
    render(<MemoryRouter><CourseImportPage /></MemoryRouter>);
    const user = userEvent.setup();
    const file = new File(["png-data"], "image.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("选择文件"), { target: { files: [file] } });
    expect(screen.getByText("请选择 PDF、Word (.docx)、Markdown (.md/.txt) 或 HTML 文件")).toBeInTheDocument();
  });
});
