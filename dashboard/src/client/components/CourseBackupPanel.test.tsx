import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CourseBackupPanel } from "./CourseBackupPanel.js";
const preview = { id: "restore-id", expiresAt: Date.now() + 86400000, courses: [{ originalId: "old", newId: "restored-new", title: "课程", fileCount: 6, sourceIncluded: true, warnings: [] }] };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });
it("previews source inclusion and privacy before ZIP download, with actionable retry", async () => {
  const calls: string[] = []; let fail = true;
  vi.stubGlobal("fetch", async (url: string) => { calls.push(url); if (fail) return { ok: false, status: 409, json: async () => ({ error: "文件正在编辑" }) }; return { ok: true, json: async () => ({ courses: [{ id: "old", title: "课程", sourceIncluded: true, warnings: [] }] }) }; });
  render(<CourseBackupPanel courses={[{ id: "old", title: "课程" }]} />);
  fireEvent.change(screen.getByLabelText("备份范围"), { target: { value: "old" } });
  fireEvent.click(screen.getByRole("button", { name: "预览 ZIP 备份" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("文件正在编辑");
  fail = false; fireEvent.click(screen.getByRole("button", { name: "预览 ZIP 备份" }));
  expect(await screen.findByText("包含受管原课件")).toBeInTheDocument();
  expect(screen.getByText(/包含笔记和学习记录/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认下载 ZIP" })).toBeEnabled();
  expect(calls).toEqual(["/api/backups/preview?courseId=old", "/api/backups/preview?courseId=old"]);
});
it("uploads, previews, locks duplicate confirmation and keeps receipt retry after a lost response", async () => {
  let confirms = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/confirm")) { confirms++; if (confirms === 1) throw new Error("连接中断"); return { ok: true, json: async () => ({ courseIds: ["restored-new"] }) }; }
    return { ok: true, json: async () => preview };
  });
  render(<CourseBackupPanel courses={[]} />);
  fireEvent.change(screen.getByLabelText("选择 ZIP 备份"), { target: { files: [new File(["zip"], "backup.zip")] } });
  fireEvent.click(screen.getByRole("button", { name: "上传并校验 ZIP" }));
  expect(await screen.findByText(/将恢复为新课程，不覆盖已有课程/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "确认恢复为新课程" }));
  expect(screen.getByRole("button", { name: "恢复中…" })).toBeDisabled();
  expect(await screen.findByRole("alert")).toHaveTextContent("连接中断");
  fireEvent.click(screen.getByRole("button", { name: "确认恢复为新课程" }));
  expect(await screen.findByText(/成功恢复 1 门课程/)).toBeInTheDocument();
  expect(confirms).toBe(2);
});
it("recovers a saved preview URL and cancels without confirmation", async () => {
  window.history.replaceState(null, "", "/settings?restore=restore-id"); const calls: Array<[string, string]> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => { calls.push([url, init?.method ?? "GET"]); return { ok: true, json: async () => preview }; });
  render(<CourseBackupPanel courses={[]} />);
  expect(await screen.findByRole("button", { name: "取消恢复" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "取消恢复" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "确认恢复为新课程" })).not.toBeInTheDocument());
  expect(calls).toEqual([["/api/restores/restore-id", "GET"], ["/api/restores/restore-id", "DELETE"]]);
});
it.each([404, 410])("releases an unavailable preview after confirm returns %s", async (status) => {
  vi.stubGlobal("fetch", async (url: string) => url.endsWith("/confirm") ? { ok: false, status, json: async () => ({ error: "恢复预览已过期" }) } : { ok: true, json: async () => preview });
  render(<CourseBackupPanel courses={[]} />);
  fireEvent.change(screen.getByLabelText("选择 ZIP 备份"), { target: { files: [new File(["zip"], "backup.zip")] } });
  fireEvent.click(screen.getByRole("button", { name: "上传并校验 ZIP" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认恢复为新课程" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("恢复预览已过期");
  expect(screen.getByLabelText("选择 ZIP 备份")).toBeEnabled();
  expect(screen.queryByRole("button", { name: "确认恢复为新课程" })).not.toBeInTheDocument();
  expect(new URL(window.location.href).searchParams.has("restore")).toBe(false);
});
