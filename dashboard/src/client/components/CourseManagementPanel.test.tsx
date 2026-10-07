import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { CourseManagementPanel } from "./CourseManagementPanel.js";
import * as api from "../api.js";
vi.mock("../api.js", () => ({ fetchCourseEdit: vi.fn(), saveCourseEdit: vi.fn(), deleteCourse: vi.fn() }));
const snapshot = { expectedHash: "a".repeat(64), title: "原课程", overviewMarkdown: "简介", stages: [{ title: "入门", tasks: [{ text: "任务", completed: false }] }] };
afterEach(() => vi.restoreAllMocks());
it("编辑加载后提交修改，保存失败保留输入", async () => {
  vi.mocked(api.fetchCourseEdit).mockResolvedValue(snapshot);
  vi.mocked(api.saveCourseEdit).mockRejectedValue(new Error("课程已被修改"));
  render(<MemoryRouter><CourseManagementPanel courseId="example" title="原课程" /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "编辑课程" }));
  const name = await screen.findByLabelText("课程名称"); fireEvent.change(name, { target: { value: "新课程" } });
  fireEvent.click(screen.getByRole("button", { name: "保存课程" }));
  await screen.findByText("课程已被修改"); expect(name).toHaveValue("新课程");
  expect(api.saveCourseEdit).toHaveBeenCalledWith("example", expect.objectContaining({ title: "新课程" }));
});
it("取消删除不调用接口，确认删除使用刚读取的文件版本", async () => {
  vi.mocked(api.fetchCourseEdit).mockResolvedValue(snapshot);
  vi.mocked(api.deleteCourse).mockResolvedValue({ deleted: true, filesRetained: true });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<MemoryRouter><CourseManagementPanel courseId="example" title="原课程" /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "删除课程" }));
  await waitFor(() => expect(confirm).toHaveBeenCalled()); expect(api.deleteCourse).not.toHaveBeenCalled();
  confirm.mockReturnValue(true); fireEvent.click(screen.getByRole("button", { name: "删除课程" }));
  await waitFor(() => expect(api.deleteCourse).toHaveBeenCalledWith("example", snapshot.expectedHash));
});
