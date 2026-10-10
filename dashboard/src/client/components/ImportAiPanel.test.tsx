import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { CourseImportPreview } from "../../shared/course-import.js";
import { ImportAiPanel } from "./ImportAiPanel.js";

afterEach(() => vi.unstubAllGlobals());

it("starts with a small chapter selection and lets the user add another before previewing", async () => {
  const stages = Array.from({ length: 8 }, (_, index) => ({ id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`, title: `章节 ${index + 1}`, tasks: ["阅读"], source: { title: `章节 ${index + 1}`, startPage: index + 1, endPage: index + 1 } }));
  const preview: CourseImportPreview = { id: "draft-1", courseId: "c", revision: 0, aiAvailable: true, excerptChars: 0, files: {}, draft: { title: "课程", originalFilename: "book.pdf", pageCount: 8, goal: "", weeklyHours: null, stages, notes: [], warnings: [], aiStatus: "not-used", sourceFormat: "pdf" } };
  let sentIds: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sentIds = JSON.parse(init.body as string).stageIds;
    return { ok: true, json: async () => ({ revision: 0, stageIds: sentIds, excerptHash: "a".repeat(64), text: "摘录", chars: 2, pages: [] }) };
  });
  render(<ImportAiPanel preview={preview} flush={async () => preview} onPreviewChanged={() => {}} />);
  const user = userEvent.setup();
  expect(screen.getByRole("checkbox", { name: "完善 章节 6" })).not.toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: "完善 章节 8" }));
  await user.click(screen.getByRole("button", { name: "查看将发送的摘录" }));
  await screen.findByLabelText(/同意发送/);
  expect(sentIds).toEqual([stages[0].id, stages[1].id, stages[2].id, stages[3].id, stages[4].id, stages[7].id]);
});
