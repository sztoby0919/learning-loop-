import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { BACKUP_LIMITS, type RestorePreview } from "../shared/course-backup.js";
import { BackupError, archiveFileLimit, safeBackupDirectory, validateArchivePath } from "./backup-zip.js";
import { readBackupFile } from "./course-backup.js";
import { backupFileIo, type DirectoryOwner } from "./native-file-io.js";
import { sourceFilePattern } from "./course-bundle-files.js";

const id = z.string().uuid();
const courseId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);
const file = z.object({ path: z.string().max(400), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const previewCourse = z.object({ originalId: courseId, newId: courseId, title: z.string().max(10000), fileCount: z.number().int().positive(), sourceIncluded: z.boolean(), warnings: z.array(z.string().max(10000)).max(100) }).strict();
const stateSchema = z.object({ version: z.literal(1), id, token: id, createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(), phase: z.enum(["preparing", "open", "publishing", "committed"]), courses: z.array(previewCourse.extend({ files: z.array(file).min(1).max(2000) }).strict()).max(50) }).strict();
export type RestoreState = z.infer<typeof stateSchema>;
export const restoreHome = (root: string) => path.join(root, ".learning-loop", "restores");
export function restoreDirectory(root: string, value: string): string {
  if (!id.safeParse(value).success) throw new BackupError("恢复预览不存在", 404);
  return path.join(restoreHome(root), value);
}
export const stagedDirectory = (root: string, state: RestoreState, newId: string) => path.join(restoreDirectory(root, state.id), "courses", newId);
export const publishedDirectory = (root: string, newId: string) => path.join(root, "learning-journal", newId);
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const notFound = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export async function ensureRestoreDirectory(directory: string): Promise<void> {
  await backupFileIo.ensureDirectory(directory);
}
export const restoreOwner = (state: Pick<RestoreState, "id" | "token">, newId = state.id): DirectoryOwner => ({ id: state.id, token: state.token, newId });
export async function writeBackupFile(filename: string, bytes: Uint8Array, limit: number): Promise<void> {
  const writer = await backupFileIo.createWriter(filename, limit);
  try { await writer.write(bytes); await writer.finish(); } finally { await writer.abort(); }
}
export async function directoryExists(directory: string): Promise<boolean> {
  try { await backupFileIo.listDirectory(directory); return true; } catch (error) { if (notFound(error)) return false; throw error; }
}
function validateState(value: unknown): RestoreState {
  const state = stateSchema.parse(value);
  if ((state.phase === "preparing") !== (state.courses.length === 0)) throw new BackupError("恢复准备状态校验失败");
  if (state.expiresAt !== state.createdAt + 86400000 || new Set(state.courses.map((course) => course.newId)).size !== state.courses.length || new Set(state.courses.map((course) => course.originalId)).size !== state.courses.length) throw new BackupError("恢复记录校验失败");
  const paths = new Set<string>(); let total = 0;
  for (const course of state.courses) {
    if (course.fileCount !== course.files.length || course.newId === course.originalId || !course.files.some((entry) => entry.path === "course.md")) throw new BackupError("恢复课程记录校验失败");
    let sources = 0;
    for (const entry of course.files) {
      const full = validateArchivePath(`courses/${course.newId}/${entry.path}`);
      if (paths.has(full.toLowerCase()) || entry.bytes > archiveFileLimit(full, BACKUP_LIMITS)) throw new BackupError("恢复文件记录校验失败");
      paths.add(full.toLowerCase()); total += entry.bytes;
      if (sourceFilePattern.test(entry.path)) sources++;
    }
    if (sources > 100 || course.sourceIncluded !== (sources > 0)) throw new BackupError("恢复来源记录校验失败");
  }
  if (paths.size > 1999 || total > BACKUP_LIMITS.totalBytes) throw new BackupError("恢复记录超限");
  return state;
}
export async function readRestoreState(root: string, value: string): Promise<RestoreState> {
  try {
    const bytes = (await readBackupFile(path.join(restoreDirectory(root, value), "state.json"), BACKUP_LIMITS.manifestBytes)).bytes;
    const state = validateState(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (state.id !== value) throw new BackupError("恢复记录 ID 校验失败");
    return state;
  } catch (error) {
    if (notFound(error)) throw new BackupError("恢复预览不存在", 404);
    if (error instanceof BackupError) throw error;
    throw new BackupError("恢复记录损坏，已保留原目录，请检查本地文件");
  }
}
export async function writeRestoreState(root: string, value: RestoreState): Promise<void> {
  const state = validateState(value); const directory = restoreDirectory(root, state.id);
  const raw = JSON.stringify(state);
  if (Buffer.byteLength(raw) > BACKUP_LIMITS.manifestBytes) throw new BackupError("恢复记录大小超限", 413);
  await backupFileIo.replaceStateFile(path.join(directory, "state.json"), Buffer.from(raw));
}
export function publicRestorePreview(state: RestoreState): RestorePreview {
  return { id: state.id, expiresAt: state.expiresAt, courses: state.courses.map(({ files: _files, ...course }) => course) };
}
const markerName = ".learning-loop-restore.json";
export async function markRestoreCourse(directory: string, state: RestoreState, newId: string): Promise<void> {
  await writeBackupFile(path.join(directory, markerName), Buffer.from(JSON.stringify(restoreOwner(state, newId))), 1000);
}
export async function verifyRestoreCourse(directory: string, state: RestoreState, course: RestoreState["courses"][number]): Promise<Record<string, string>> {
  await safeBackupDirectory(directory);
  const marker = JSON.parse(Buffer.from((await readBackupFile(path.join(directory, markerName), 1000)).bytes).toString("utf8"));
  if (marker.id !== state.id || marker.token !== state.token || marker.newId !== course.newId) throw new BackupError("恢复目录所有权校验失败");
  const markdown: Record<string, string> = {};
  for (const entry of course.files) {
    const full = validateArchivePath(`courses/${course.newId}/${entry.path}`);
    const bytes = (await readBackupFile(path.join(directory, ...entry.path.split("/")), archiveFileLimit(full, BACKUP_LIMITS))).bytes;
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new BackupError("恢复暂存文件已变更，校验失败");
    if (!sourceFilePattern.test(entry.path)) markdown[entry.path] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  return markdown;
}

// Serialize publication across manager instances. A durable state journal is
// written before any rename; a committed state is the sole commit point.
const locks = new Map<string, Promise<void>>();
export async function withRestoreLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(root).toLowerCase(); const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate); locks.set(key, tail);
  await previous;
  try { return await action(); }
  finally { release(); if (locks.get(key) === tail) locks.delete(key); }
}
export async function rollbackRestore(root: string, state: RestoreState): Promise<void> {
  for (const course of [...state.courses].reverse()) {
    const published = publishedDirectory(root, course.newId);
    const staged = stagedDirectory(root, state, course.newId);
    // A preexisting collision is never our property, hence never moved/deleted.
    const stagedExists = await directoryExists(staged);
    if (stagedExists) continue;
    const exists = await directoryExists(published);
    if (!exists) throw new BackupError("恢复事务缺少暂存和发布目录，需人工核对");
    await verifyRestoreCourse(published, state, course);
    await backupFileIo.moveDirectory(published, staged, restoreOwner(state, course.newId));
  }
  await writeRestoreState(root, { ...state, phase: "open" });
}
async function restoreIds(root: string): Promise<string[]> {
  try {
    return (await backupFileIo.listDirectory(restoreHome(root))).entries.filter((entry) => entry.kind === "directory" && id.safeParse(entry.name).success).map((entry) => entry.name);
  } catch (error) { if (notFound(error)) return []; throw error; }
}
export async function recoverRestoreTransactions(root: string): Promise<void> {
  await backupFileIo.available();
  await withRestoreLock(root, async () => {
    for (const value of await restoreIds(root)) {
      let state: RestoreState;
      try { state = await readRestoreState(root, value); }
      catch (error) {
        // Before the first journal rename only an empty directory or our
        // UUID-named write temp can exist. Anything else is retained fail-closed.
        if (!(error instanceof BackupError) || error.status !== 404) throw error;
        const directory = restoreDirectory(root, value); const entries = (await backupFileIo.listDirectory(directory)).entries;
        if (entries.some((entry) => entry.kind !== "file" || (entry.name !== markerName && !/^[a-f0-9-]{36}\.tmp$/.test(entry.name)))) throw new BackupError("恢复目录缺少事务记录，请备份后人工核对");
        const marker = JSON.parse(Buffer.from((await readBackupFile(path.join(directory, markerName), 1000)).bytes).toString("utf8"));
        if (marker.id !== value || marker.newId !== value || !id.safeParse(marker.token).success) throw new BackupError("缺失恢复记录的目录所有权无法核验，已保留");
        await backupFileIo.removeDirectory(directory, marker); continue;
      }
      if (state.phase === "preparing") { await backupFileIo.removeDirectory(restoreDirectory(root, value), restoreOwner(state)); continue; }
      if (state.phase === "publishing") await rollbackRestore(root, state);
      // Committed courses are ordinary editable courses now. Never compare
      // their later edits with the old snapshot or move them back to staging.
    }
  });
}
export async function pendingRestoreCourseIds(root: string): Promise<Set<string>> {
  await backupFileIo.available();
  const pending = new Set<string>();
  for (const value of await restoreIds(root)) {
    const state = await readRestoreState(root, value);
    if (state.phase === "publishing") for (const course of state.courses) pending.add(course.newId);
  }
  return pending;
}
export async function cleanupRestorePreviews(root: string, now: number): Promise<void> {
  await withRestoreLock(root, async () => {
    for (const value of await restoreIds(root)) {
      const state = await readRestoreState(root, value);
      if (state.phase === "publishing" || state.expiresAt > now) continue;
      await backupFileIo.removeDirectory(restoreDirectory(root, value), restoreOwner(state));
    }
  });
}
