import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CourseImportError } from "./course-import-manager.js";
import { sourceFilePattern } from "./course-bundle-files.js";

export const bundleArtifacts = ["course.md", "notes.md", "reviews.md", "resources.md", "schedule.md"] as const;
const allowedFile = (name: string) => bundleArtifacts.includes(name as typeof bundleArtifacts[number]) || sourceFilePattern.test(name);
const hashes = z.record(z.string().regex(/^[a-f0-9]{64}$/).nullable()).refine((items) => Object.keys(items).every(allowedFile));
const schema = z.object({ version: z.literal(1), id: z.string().uuid(), courseId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/), targetCourseId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/).optional(), title: z.string().trim().min(1).max(100), revision: z.number().int().nonnegative(), createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(), draftIds: z.array(z.string().uuid()).min(1).max(10), phase: z.enum(["open", "committing", "committed"]), baseHashes: hashes, plannedHashes: hashes.optional() }).strict().superRefine((state, context) => {
  if (new Set(state.draftIds).size !== state.draftIds.length || state.expiresAt !== state.createdAt + 7 * 86400000 || (state.targetCourseId && state.targetCourseId !== state.courseId) || (!state.targetCourseId && state.courseId !== `course-${state.id.slice(0, 8)}`) || (state.phase !== "open" && !state.plannedHashes)) context.addIssue({ code: "custom", message: "多文件事务关联无效" });
});
export type BundleState = z.infer<typeof schema>;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
export async function safeBundleDirectory(dir: string, create = false): Promise<void> {
  if (create) await mkdir(dir).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || path.dirname(await realpath(dir)) !== await realpath(path.dirname(dir))) throw new CourseImportError("课件事务路径不安全，已保留原数据", 422);
}
export class CourseBundleStore {
  readonly recoveryWarnings = new Map<string, string>();
  constructor(readonly root: string) {}
  private async base(create = false) {
    await safeBundleDirectory(this.root); await safeBundleDirectory(path.join(this.root, ".learning-loop"), create);
    const base = path.join(this.root, ".learning-loop", "bundles"); await safeBundleDirectory(base, create); return base;
  }
  async directory(id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new CourseImportError("多文件草稿 ID 无效", 400);
    const dir = path.join(await this.base(), id); await safeBundleDirectory(dir); return dir;
  }
  async create(state: BundleState) {
    const valid = schema.parse(state); const dir = path.join(await this.base(true), state.id); await mkdir(dir);
    await writeFile(path.join(dir, "owner.json"), JSON.stringify({ id: valid.id }), { flag: "wx" });
    await this.write(valid);
  }
  async read(id: string, includeExpired = false): Promise<BundleState> {
    try {
      const file = path.join(await this.directory(id), "state.json"); const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new CourseImportError("多文件快照不安全", 422);
      const parsed = schema.safeParse(JSON.parse(await readFile(file, "utf8")));
      if (!parsed.success || parsed.data.id !== id) throw new CourseImportError("多文件草稿损坏，已保留资料", 422);
      if (!includeExpired && Date.now() >= parsed.data.expiresAt && parsed.data.phase === "open") throw new CourseImportError("多文件草稿已过期，请重新上传", 410);
      return parsed.data;
    } catch (error) { if (missing(error)) throw new CourseImportError("多文件草稿不存在", 404); throw error; }
  }
  async write(state: BundleState) {
    const valid = schema.parse(state); const dir = await this.directory(valid.id);
    const temporary = path.join(dir, `.state-${randomUUID()}.tmp`);
    try { await writeFile(temporary, JSON.stringify(valid), { flag: "wx" }); await rename(temporary, path.join(dir, "state.json")); }
    finally { await rm(temporary, { force: true }); }
  }
  async list(): Promise<BundleState[]> {
    let base: string; try { base = await this.base(); } catch (error) { if (missing(error)) return []; throw error; }
    const states: BundleState[] = [];
    this.recoveryWarnings.clear();
    for (const name of await readdir(base)) {
      if (!z.string().uuid().safeParse(name).success) continue;
      try { const state = await this.read(name, true); if (state.phase !== "committed") states.push(state); }
      catch { this.recoveryWarnings.set(name, "草稿快照缺失、损坏或路径不安全；资料已保留，其他课程不受影响。请备份后检查。"); }
    }
    return states;
  }
  async remove(id: string) {
    const dir = await this.directory(id);
    const ownerFile = path.join(dir, "owner.json"); const info = await lstat(ownerFile);
    if (!info.isFile() || info.isSymbolicLink() || JSON.parse(await readFile(ownerFile, "utf8")).id !== id) throw new CourseImportError("无法确认草稿所有权，未删除资料", 422);
    // Resolve and validate the exact UUID directory before recursive removal.
    const actual = await realpath(dir); if (path.dirname(actual) !== await realpath(await this.base())) throw new CourseImportError("删除路径不安全", 422);
    await rm(actual, { recursive: true, force: false });
  }
}
