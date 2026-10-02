// @vitest-environment node
import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { remapCourseFiles } from "./course-id-remap.js";
import { renderAttemptSession } from "./session-records.js";
import { readMistakes } from "./session-records.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
describe("structural course ID remapping", () => {
  it("changes only association fields and the exact resources URL cell, preserving prose, dates and evidence", () => {
    const note = `---\ncourseId: old-id\nupdated: 2026-09-30\n---\n# old-id\n普通笔记 /api/courses/old-id/source#page=4 不要改\n`;
    const session = renderAttemptSession({ kind: "targeted-practice", courseId: "old-id", confirmedAt: "2026-09-30", mistakeId: "evidence-old-id", mode: "real", question: { question: "old-id?", options: ["1", "2", "3", "4"], selected: "A", correct: "B", explanation: "old-id explanation", knowledgePoint: "Topic" } });
    const files = { "course.md": "---\nid: old-id\n---\n# old-id\n", "notes.md": note, "sessions/attempt.md": session, "resources.md": "---\ncourseId: old-id\nupdated: 2026-09-30\n---\n| 名称 | 类型 | URL 或本地路径 | 对应阶段 | 使用状态 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n| old-id | PDF | /api/courses/old-id/source#page=4 | old-id | 未开始 | /api/courses/old-id/source |\n\n普通链接 /api/courses/old-id/source\n" };
    const mapped = remapCourseFiles(files, "old-id", "new-id");
    expect(matter(mapped["course.md"]).data.id).toBe("new-id");
    expect(mapped["notes.md"]).toBe(note.replace("courseId: old-id", "courseId: new-id"));
    expect(mapped["resources.md"]).toContain("| old-id | PDF | /api/courses/new-id/source#page=4 | old-id | 未开始 | /api/courses/old-id/source |");
    expect(mapped["resources.md"]).toContain("普通链接 /api/courses/old-id/source");
    const parsed = matter(mapped["sessions/attempt.md"]);
    expect(parsed.data).toMatchObject({ courseId: "new-id", mistakeId: "evidence-old-id", evidenceCourseId: "old-id" });
    expect(parsed.content).toBe(matter(session).content);
    expect(mapped["sessions/attempt.md"]).toContain("confirmedAt: 2026-09-30");
  });
  it("rejects a cross-course association rather than silently rewriting it", () => {
    expect(() => remapCourseFiles({ "notes.md": "---\ncourseId: another\n---\n# note" }, "old-id", "new-id")).toThrow(/不一致/);
  });
  it("maps only the first resource table even without a URL header, preserving later example tables", () => {
    const raw = "---\ncourseId: old-id\nupdated: 2026-09-30\n---\n| 名称 | 类型 | 地址 | 阶段 | 状态 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n| 书 | PDF | /api/courses/old-id/source#page=4 | 章 | 未开始 | |\n\n示例表格：\n\n| 名称 | 类型 | URL | 阶段 | 状态 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n| 示例 | PDF | /api/courses/old-id/source | 章 | 未开始 | |\n";
    const mapped = remapCourseFiles({ "resources.md": raw }, "old-id", "new-id")["resources.md"];
    expect(mapped).toContain("| 书 | PDF | /api/courses/new-id/source#page=4 |");
    expect(mapped).toContain("| 示例 | PDF | /api/courses/old-id/source |");
  });
  it("keeps computed mistake IDs stable so later practice still attaches after restore", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "learning-loop-evidence-"));
    try {
      await mkdir(path.join(root, "sessions"));
      const question = { question: "证据", options: ["1", "2", "3", "4"], selected: "A" as const, correct: "B" as const, explanation: "解析", knowledgePoint: "主题" };
      const original = renderAttemptSession({ kind: "review-attempt", courseId: "old-id", confirmedAt: "2026-09-30", mode: "real", question });
      await writeFile(path.join(root, "sessions", "first.md"), original);
      const old = (await readMistakes(root, "old-id")).items[0];
      const practice = renderAttemptSession({ kind: "targeted-practice", courseId: "old-id", confirmedAt: "2026-10-01", mode: "real", mistakeId: old.id, question: { ...question, selected: "B" } });
      const mapped = remapCourseFiles({ "sessions/first.md": original, "sessions/next.md": practice }, "old-id", "new-id");
      for (const [file, content] of Object.entries(mapped)) await writeFile(path.join(root, file), content);
      const restored = await readMistakes(root, "new-id");
      expect(restored.items[0].id).toBe(old.id);
      expect(restored.items[0].attempts).toHaveLength(1);
      expect(restored.items[0].courseId).toBe("new-id");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
