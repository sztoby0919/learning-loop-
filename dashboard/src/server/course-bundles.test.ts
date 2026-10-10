// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile, rm, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import * as fileUtils from "./file-utils.js";
import { CourseBundles } from "./course-bundles.js";
import { CourseBackupService } from "./course-backup.js";
import { CourseRestoreManager } from "./course-restore.js";
import { BackupZipCodec } from "./backup-zip.js";
import { textPdf } from "../test/pdf-fixtures.js";
import { createApp } from "./app.js";
import { CourseEventBus } from "./course-events.js";
import { CourseImportManager } from "./course-import-manager.js";
import { WorkspaceRepository } from "./workspace-repository.js";

const managers: CourseImportManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.stopScheduledCleanup(); vi.restoreAllMocks(); });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "course-bundles-"));
  const repository = new WorkspaceRepository({ configPath: path.join(root, "config.json"), courses: [] }, () => "2026-10-07");
  const events = new CourseEventBus();
  const imports = new CourseImportManager({ root, repository, events, watchCourse: () => {}, today: () => "2026-10-07" }); managers.push(imports);
  return { root, repository, imports, app: createApp(repository, events, undefined, imports) };
}
const confirmInput = (bundle: any) => ({ title: bundle.title, expectedRevision: bundle.revision, drafts: bundle.documents.map((doc: any) => ({ id: doc.id, revision: doc.revision })) });

it("超过十份文件拒绝整批上传，并提示分批追加", async () => {
  const { app, repository, imports } = await setup();
  let upload = request(app).post("/api/course-bundles");
  for (let index = 0; index < 11; index++) upload = upload.attach("files", Buffer.from("# 章节\n正文"), `lesson-${index}.md`);
  const result = await upload.expect(400);
  expect(result.body.error).toContain("最多上传 10 个课件");
  expect(repository.config.courses).toEqual([]);
  expect(await imports.list()).toEqual([]);
});

it("多份同名课件合成一门课，保留独立来源，刷新恢复且重复确认不重复写入", async () => {
  const { app, repository } = await setup();
  const uploaded = await request(app).post("/api/course-bundles").attach("files", Buffer.from("# 代数\n## 矩阵\n矩阵内容"), "lesson.md").attach("files", Buffer.from("# 几何\n## 向量\n向量内容"), "lesson.md").expect(201);
  const bundle = uploaded.body; expect(bundle.documents).toHaveLength(2); expect(repository.config.courses).toHaveLength(0);
  expect((await request(app).get(`/api/course-bundles/${bundle.id}`).expect(200)).body.documents).toHaveLength(2);
  const result = await request(app).post(`/api/course-bundles/${bundle.id}/confirm`).send(confirmInput(bundle)).expect(201);
  await request(app).post(`/api/course-bundles/${bundle.id}/confirm`).send(confirmInput(bundle)).expect(201);
  expect(repository.config.courses).toHaveLength(1);
  const course = await repository.getCourse(result.body.courseId); expect(course!.stages).toHaveLength(2);
  const refs = (await request(app).get(`/api/courses/${result.body.courseId}/source-references`).expect(200)).body;
  expect(new Set(refs.map((ref: any) => ref.sourceUrl)).size).toBe(2);
  for (const ref of refs) await request(app).get(ref.sourceUrl).expect(200);
  await request(app).post(`/api/course-imports/${bundle.documents[0].id}/confirm`).send({ expectedRevision: 0 }).expect(409);
});

it("追加只新增内容，保留完成状态、记录、笔记，版本冲突拒绝写入", async () => {
  const { app, repository, imports } = await setup();
  const draft = await imports.create(Buffer.from("# 原课\n## 原章节\n原文"), "original.md");
  const original = await imports.confirm(draft.id, draft.revision!);
  const root = repository.config.courses[0].root; const courseFile = path.join(root, "course.md");
  await writeFile(courseFile, (await readFile(courseFile, "utf8")).replace("- [ ]", "- [x]") + "\n原记录保留\n");
  await writeFile(path.join(root, "notes.md"), (await readFile(path.join(root, "notes.md"), "utf8")) + "\n个人笔记保留\n");
  const uploaded = await request(app).post("/api/course-bundles").field("targetCourseId", original.courseId).attach("files", Buffer.from("# 补充\n## 新章节\n新增内容"), "new.md").expect(201);
  const input = confirmInput(uploaded.body);
  await request(app).post(`/api/course-bundles/${uploaded.body.id}/confirm`).send(input).expect(201);
  const course = await repository.getCourse(original.courseId); expect(course!.completedTasks).toBe(1); expect(course!.stages).toHaveLength(2);
  expect(await readFile(courseFile, "utf8")).toContain("原记录保留"); expect(await readFile(path.join(root, "notes.md"), "utf8")).toContain("个人笔记保留");
  const conflict = await request(app).post("/api/course-bundles").field("targetCourseId", original.courseId).attach("files", Buffer.from("# 其他\n## 其他章节\n内容"), "other.md").expect(201);
  const current = await readFile(courseFile, "utf8"); await writeFile(courseFile, current + "\n外部修改\n");
  await request(app).post(`/api/course-bundles/${conflict.body.id}/confirm`).send(confirmInput(conflict.body)).expect(409);
  expect(await readFile(courseFile, "utf8")).toBe(current + "\n外部修改\n");
});

it("不支持的文件让整批失败；取消追加不改变课程；过期子草稿修订拒绝提交", async () => {
  const { app, repository, imports } = await setup();
  await request(app).post("/api/course-bundles").attach("files", Buffer.from("valid"), "a.txt").attach("files", Buffer.from("bad"), "b.exe").expect(400);
  expect(await imports.list()).toEqual([]);
  const uploaded = await request(app).post("/api/course-bundles").attach("files", Buffer.from("# 课\n## 章节\n正文"), "a.md").expect(201);
  const doc = uploaded.body.documents[0];
  await imports.update(doc.id, { ...doc.draft, expectedRevision: doc.revision, title: "另一页修改" });
  await request(app).post(`/api/course-bundles/${uploaded.body.id}/confirm`).send(confirmInput(uploaded.body)).expect(409);
  await request(app).delete(`/api/course-bundles/${uploaded.body.id}`).expect(204);
  expect(repository.config.courses).toEqual([]);
});

it("混合 PDF 与文本的来源页码独立，ZIP 恢复包含所有原文件并重映射资源 URL", async () => {
  const { app, repository, root, imports } = await setup();
  const uploaded = await request(app).post("/api/course-bundles").attach("files", Buffer.from(textPdf(["Chapter 1 Algebra", "Matrix text"])), "book.pdf").attach("files", Buffer.from("# 教材\n## 第二章\n文本内容"), "notes.md").expect(201);
  const created = (await request(app).post(`/api/course-bundles/${uploaded.body.id}/confirm`).send(confirmInput(uploaded.body)).expect(201)).body;
  const references = (await request(app).get(`/api/courses/${created.courseId}/source-references`).expect(200)).body;
  expect(references.some((ref: any) => ref.filename === "book.pdf" && ref.sourceUrl.endsWith("#page=1"))).toBe(true);
  expect(references.some((ref: any) => ref.filename === "notes.md" && ref.kind === "virtual-position")).toBe(true);
  const backup = await new CourseBackupService(repository, imports, new BackupZipCodec()).create([created.courseId]);
  expect(backup.manifest.courses[0].files.filter((file) => /source-/.test(file.path))).toHaveLength(2);
  const restore = new CourseRestoreManager({ root, repository, events: new CourseEventBus(), codec: new BackupZipCodec(), watchCourse: () => {} });
  const preview = await restore.create(backup.bytes); const restored = await restore.confirm(preview.id); restore.stopScheduledCleanup();
  const newId = restored.courseIds[0];
  const resources = await readFile(path.join(root, "learning-journal", newId, "resources.md"), "utf8");
  expect(resources).toContain(`/api/courses/${newId}/sources/`); expect(resources).not.toContain(`/api/courses/${created.courseId}/sources/`);
  const recoveredReferences = (await request(app).get(`/api/courses/${newId}/source-references`).expect(200)).body;
  expect(recoveredReferences).toHaveLength(references.length);
});

it.each([false, true])("追加写入中断后可恢复；外部修改时保持未决且不覆盖，external=%s", async (external) => {
  const { app, repository, root, imports } = await setup();
  const original = await imports.create(Buffer.from("# 原课程\n## 旧章节\n正文"), "old.md");
  const { courseId } = await imports.confirm(original.id, original.revision!);
  const response = await request(app).post("/api/course-bundles").field("targetCourseId", courseId).attach("files", Buffer.from("# 新课件\n## 新章节\n新正文"), "new.md").expect(201);
  const fail = vi.spyOn(fileUtils, "batchAtomicWrite").mockResolvedValueOnce({ success: false, error: "simulated interruption" });
  await request(app).post(`/api/course-bundles/${response.body.id}/confirm`).send(confirmInput(response.body)).expect(500); fail.mockRestore();
  const file = path.join(root, "learning-journal", courseId, "course.md");
  if (external) await writeFile(file, (await readFile(file, "utf8")) + "\n外部编辑不可覆盖\n");
  const restarted = new CourseBundles(imports, repository, new CourseEventBus()); await restarted.initialize();
  if (external) { expect((await restarted.list())[0].warning).toContain("恢复"); expect(await readFile(file, "utf8")).toContain("外部编辑不可覆盖"); await expect(restarted.cancel(response.body.id)).rejects.toMatchObject({ status: 409 }); }
  else { expect(await restarted.list()).toEqual([]); expect((await repository.getCourse(courseId))!.stages).toHaveLength(2); }
});

it("未完成或损坏的单份事务不会阻止健康课程和其他草稿启动", async () => {
  const { root, repository, imports } = await setup();
  const draft = await imports.create(Buffer.from("# 健康课程\n## 章节\n正文"), "healthy.md");
  const created = await imports.confirm(draft.id, draft.revision!);
  const orphan = path.join(root, ".learning-loop", "bundles", "11111111-1111-4111-8111-111111111111");
  await mkdir(orphan, { recursive: true }); await writeFile(path.join(orphan, "owner.json"), "{}");
  const damaged = path.join(root, ".learning-loop", "bundles", "22222222-2222-4222-8222-222222222222");
  await mkdir(damaged); await writeFile(path.join(damaged, "state.json"), "invalid json");
  const restarted = new CourseBundles(imports, repository, new CourseEventBus());
  await expect(restarted.initialize()).resolves.toBeUndefined();
  expect((await restarted.list()).filter((entry) => entry.warning)).toHaveLength(2);
  expect(await repository.getCourse(created.courseId)).not.toBeNull();
  const valid = await restarted.create([{ filename: "valid.md", bytes: Buffer.from("# 有效\n## 章节\n正文") }]); expect(valid.documents).toHaveLength(1);
});

it("追加到缺少资源和日程文件的课程时，每份新课件与日期只生成一次", async () => {
  const { root, repository, imports } = await setup();
  const draft = await imports.create(Buffer.from("# 原课\n## 原章\n正文"), "old.md"); const original = await imports.confirm(draft.id, draft.revision!);
  const courseRoot = path.join(root, "learning-journal", original.courseId);
  await rm(path.join(courseRoot, "resources.md")); await rm(path.join(courseRoot, "schedule.md"));
  const service = new CourseBundles(imports, repository, new CourseEventBus());
  const bundle = await service.create([{ filename: "new.md", bytes: Buffer.from("# 新课\n## 新章\n作业截止日期：2026-10-20") }], original.courseId);
  await service.confirm(bundle.id, confirmInput(bundle));
  const resources = await readFile(path.join(courseRoot, "resources.md"), "utf8");
  expect(resources.match(/\| new.md \|/g)).toHaveLength(1); expect(resources).not.toContain(`/api/courses/${original.courseId}/source |`);
  expect((await readFile(path.join(courseRoot, "schedule.md"), "utf8")).match(/\| 2026-10-20 \|/g)).toHaveLength(1);
});

it("重试规划拒绝暂存文件链接，不覆盖链接指向的其他资料", async () => {
  const { root, imports, repository } = await setup(); const service = new CourseBundles(imports, repository, new CourseEventBus());
  const preview = await service.create([{ filename: "book.md", bytes: Buffer.from("# 课程\n## 章节\n正文") }]);
  const planned = path.join(root, ".learning-loop", "bundles", preview.id, "planned"); await mkdir(planned);
  const other = path.join(root, "untouched.md"); await writeFile(other, "原资料不能覆盖");
  await link(other, path.join(planned, "course.md"));
  await expect(service.confirm(preview.id, confirmInput(preview))).rejects.toMatchObject({ status: 422 });
  expect(await readFile(other, "utf8")).toBe("原资料不能覆盖");
});
