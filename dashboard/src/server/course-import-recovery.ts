import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DraftEntry } from "../shared/course-import.js";
import { parseCourseMarkdown } from "./course-parser.js";
import { DraftStore, DraftStoreError } from "./course-import-store.js";

const markerName = ".learning-loop-import.json";
const names = ["course.md", "notes.md", "reviews.md", "resources.md", "schedule.md"];
const recordSchema = z.object({ version: z.literal(1), id: z.string().uuid(), courseId: z.string().regex(/^course-[a-z0-9-]+$/), token: z.string().uuid(), sourceExtension: z.enum([".pdf", ".docx", ".md", ".txt", ".markdown", ".html", ".htm"]), hashes: z.record(z.string().regex(/^[0-9a-f]{64}$/)) }).strict();
type CommitRecord = z.infer<typeof recordSchema>;
export interface ImportCommit extends CommitRecord { stagedPath: string; coursePath: string; journalPath: string }
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const unsafe = () => new DraftStoreError("课程提交路径或事务记录不安全，已保留现有数据", 422);

async function safeDirectory(dir: string, create = false): Promise<void> {
  if (create) await fs.mkdir(dir).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const details = await fs.lstat(dir);
  if (!details.isDirectory() || details.isSymbolicLink() || path.dirname(await fs.realpath(dir)) !== await fs.realpath(path.dirname(dir))) throw unsafe();
}

async function transactionRoot(root: string, create = false): Promise<string> {
  const projectRoot = path.resolve(root);
  await safeDirectory(projectRoot);
  await safeDirectory(path.join(projectRoot, ".learning-loop"), create);
  const dir = path.join(projectRoot, ".learning-loop", "import-commits");
  await safeDirectory(dir, create);
  return dir;
}

function paths(root: string, record: CommitRecord): ImportCommit {
  return { ...record, stagedPath: path.join(path.resolve(root), ".learning-loop", `staged-import-${record.id}-${record.token}`), coursePath: path.join(path.resolve(root), "learning-journal", record.courseId), journalPath: path.join(path.resolve(root), ".learning-loop", "import-commits", `${record.id}.json`) };
}

async function owns(dir: string, record: CommitRecord): Promise<boolean> {
  try {
    await safeDirectory(path.dirname(dir));
    await safeDirectory(dir);
    const marker = path.join(dir, markerName);
    const details = await fs.lstat(marker);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 4096) return false;
    const value = JSON.parse(await fs.readFile(marker, "utf8"));
    return value.id === record.id && value.token === record.token && value.courseId === record.courseId;
  } catch { return false; }
}

async function removeOwned(dir: string, record: CommitRecord): Promise<void> {
  if (!await owns(dir, record)) return;
  // An exact owner marker gates recursive cleanup; no user-supplied paths.
  await fs.rm(dir, { recursive: true, force: true });
}

export async function stageImportCourse(root: string, entry: DraftEntry, files: Record<string, string>, bytes: Uint8Array): Promise<ImportCommit> {
  await transactionRoot(root, true);
  if (names.some((name) => typeof files[name] !== "string") || parseCourseMarkdown(files["course.md"], "course.md").id !== entry.courseId) throw unsafe();
  const record = recordSchema.parse({ version: 1, id: entry.id, courseId: entry.courseId, token: randomUUID(), sourceExtension: entry.sourceExtension, hashes: Object.fromEntries([...names.map((name) => [name, hash(files[name])]), [`source${entry.sourceExtension}`, hash(bytes)]]) });
  const transaction = paths(root, record);
  await fs.writeFile(transaction.journalPath, JSON.stringify(record), { flag: "wx" });
  try {
    await fs.mkdir(transaction.stagedPath);
    await fs.writeFile(path.join(transaction.stagedPath, markerName), JSON.stringify({ id: record.id, token: record.token, courseId: record.courseId }), { flag: "wx" });
    for (const name of names) await fs.writeFile(path.join(transaction.stagedPath, name), files[name], { flag: "wx" });
    await fs.writeFile(path.join(transaction.stagedPath, `source${record.sourceExtension}`), bytes, { flag: "wx" });
    await fs.mkdir(path.join(transaction.stagedPath, "sessions"));
    return transaction;
  } catch (error) {
    await removeOwned(transaction.stagedPath, record);
    await fs.unlink(transaction.journalPath);
    throw error;
  }
}

async function verifyPublished(transaction: ImportCommit): Promise<void> {
  for (const [name, expected] of Object.entries(transaction.hashes)) {
    const file = path.join(transaction.coursePath, name);
    const details = await fs.lstat(file);
    const limit = name.startsWith("source") ? 100 * 1024 * 1024 : 10 * 1024 * 1024;
    if (!details.isFile() || details.isSymbolicLink() || details.size > limit || hash(await fs.readFile(file)) !== expected) throw unsafe();
  }
  const course = parseCourseMarkdown(await fs.readFile(path.join(transaction.coursePath, "course.md"), "utf8"), "course.md");
  if (course.id !== transaction.courseId) throw unsafe();
}

export async function finishImportCommit(root: string, transaction: ImportCommit): Promise<void> {
  if (!await owns(transaction.coursePath, transaction)) throw unsafe();
  await verifyPublished(transaction);
  const store = new DraftStore(root);
  const entry = await store.read(transaction.id, { includeExpired: true });
  if (entry.courseId !== transaction.courseId) throw unsafe();
  if (entry.state !== "committed") await store.replace({ ...entry, revision: entry.revision + 1, state: "committed", updatedAt: Math.min(Date.now(), entry.expiresAt - 1) }, entry.revision, { includeExpired: true });
  const source = await store.sourcePath(entry.id).catch((error) => { if (error instanceof DraftStoreError && [404, 410].includes(error.status)) return null; throw error; });
  if (source) await fs.unlink(source);
  await fs.unlink(transaction.journalPath).catch((error) => { if (!missing(error)) throw error; });
}

export async function rollbackImportCommit(root: string, transaction: ImportCommit): Promise<void> {
  await removeOwned(transaction.stagedPath, transaction);
  await removeOwned(transaction.coursePath, transaction);
  await fs.unlink(transaction.journalPath).catch((error) => { if (!missing(error)) throw error; });
  const store = new DraftStore(root);
  const entry = await store.read(transaction.id, { includeExpired: true });
  if (entry.state === "committing") await store.replace({ ...entry, state: "open", revision: entry.revision + 1, updatedAt: Math.min(Date.now(), entry.expiresAt - 1) }, entry.revision, { includeExpired: true });
}

async function pendingTransactions(root: string): Promise<ImportCommit[]> {
  let dir: string;
  try { dir = await transactionRoot(root); }
  catch (error) { if (!missing(error)) throw error; dir = ""; }
  const transactions: ImportCommit[] = [];
  if (dir) for (const name of await fs.readdir(dir)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
    const filename = path.join(dir, name);
    const details = await fs.lstat(filename);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 16 * 1024) continue;
    let record: CommitRecord;
    try { record = recordSchema.parse(JSON.parse(await fs.readFile(filename, "utf8"))); }
    catch { continue; }
    if (name !== `${record.id}.json` || Object.keys(record.hashes).length !== 6 || [...names, `source${record.sourceExtension}`].some((key) => !record.hashes[key])) continue;
    transactions.push(paths(root, record));
  }
  return transactions;
}

export async function pendingImportCourseIds(root: string): Promise<Set<string>> {
  return new Set((await pendingTransactions(root)).map((transaction) => transaction.courseId));
}

export interface ImportRecoveryIssue { id: string; courseId: string; warning: string }

/** Must run before automatic course discovery, without model/network calls. */
export async function recoverImportCommits(root: string): Promise<ImportRecoveryIssue[]> {
  const unresolved = new Set<string>();
  const issues: ImportRecoveryIssue[] = [];
  for (const transaction of await pendingTransactions(root)) {
    const record = transaction;
    unresolved.add(record.id);
    try {
      if (await owns(transaction.coursePath, record)) await finishImportCommit(root, transaction);
      else {
        // Validate and persist the snapshot BEFORE deleting any recovery data.
        const store = new DraftStore(root);
        const entry = await store.read(record.id, { includeExpired: true });
        if (entry.courseId !== record.courseId) throw unsafe();
        if (entry.state === "committing") await store.replace({ ...entry, state: "open", revision: entry.revision + 1, updatedAt: Math.min(Date.now(), entry.expiresAt - 1) }, entry.revision, { includeExpired: true });
        // A colliding user directory is not ours; never remove or claim it.
        await removeOwned(transaction.stagedPath, record);
        await fs.unlink(transaction.journalPath);
      }
    } catch {
      issues.push({ id: record.id, courseId: record.courseId, warning: "建课中断后恢复失败：快照或课程文件损坏。事务和原文件已保留，未决课程不会自动登记；请备份后处理或重新上传。" });
    }
  }
  const store = new DraftStore(root);
  for (const summary of await store.list()) {
    if (summary.status !== "ready" || unresolved.has(summary.id)) continue;
    const entry = await store.read(summary.id);
    if (entry.state === "committing") await store.replace({ ...entry, state: "open", revision: entry.revision + 1, updatedAt: Date.now() }, entry.revision);
  }
  return issues;
}
