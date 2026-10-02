import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import matter from "gray-matter";

import type { CourseId } from "../shared/course.js";
import { pendingImportCourseIds } from "./course-import-recovery.js";
import { pendingRestoreCourseIds } from "./course-restore-recovery.js";
import { backupFileIo } from "./native-file-io.js";
import { safeCourseMatter } from "./safe-course-matter.js";

export interface ConfiguredCourse {
  id: CourseId;
  root: string;
  enabled: true;
}

export interface ConfiguredStandaloneNote {
  id: string;
  title: string;
  sourcePath: string;
  accent: string;
}

export interface ConfiguredNoteGroup {
  id: string;
  title: string;
  noteIds: string[];
}

export interface DashboardConfig {
  configPath: string;
  courses: ConfiguredCourse[];
  standaloneNotes?: ConfiguredStandaloneNote[];
  noteGroups?: ConfiguredNoteGroup[];
}

const COURSE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export async function loadDashboardConfig(configPath: string, managedRoot?: string): Promise<DashboardConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const raw = await readFile(absoluteConfigPath, "utf8");
  const parsed = JSON.parse(raw) as {
    courses?: Array<{ root?: unknown; enabled?: unknown }>;
    standaloneNotes?: Array<{ id?: unknown; title?: unknown; source?: unknown; accent?: unknown }>;
    noteGroups?: Array<{ id?: unknown; title?: unknown; noteIds?: unknown }>;
  };
  if (!Array.isArray(parsed.courses)) throw new Error(`${absoluteConfigPath}: courses 必须是数组`);

  const courses: ConfiguredCourse[] = [];
  const ids = new Set<string>();
  for (const entry of parsed.courses) {
    if (entry.enabled === false) continue;
    if (typeof entry.root !== "string" || entry.root.trim() === "") {
      throw new Error(`${absoluteConfigPath}: 课程 root 必须是非空路径字符串`);
    }
    const root = await realpath(path.resolve(path.dirname(absoluteConfigPath), entry.root));
    if (!(await stat(root)).isDirectory()) throw new Error(`${root}: 课程 root 不是目录`);
    const coursePath = path.join(root, "course.md");
    const courseRaw = await readFile(coursePath, "utf8");
    const id = String(matter(courseRaw).data.id ?? "");
    if (!COURSE_ID_PATTERN.test(id)) throw new Error(`${coursePath}: 非法课程 ID“${id}”`);
    if (ids.has(id)) throw new Error(`重复课程 ID“${id}”`);
    ids.add(id);
    courses.push({ id, root, enabled: true });
  }

  if (managedRoot) {
    const pendingIds = await pendingImportCourseIds(path.dirname(path.resolve(managedRoot)));
    let restoreUnavailable = false;
    try { for (const id of await pendingRestoreCourseIds(path.dirname(path.resolve(managedRoot)))) pendingIds.add(id); }
    catch { restoreUnavailable = true; /* Do not discover an unverified, partially published restore. */ }
    const entries = await readdir(managedRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || pendingIds.has(entry.name) || (restoreUnavailable && entry.name.startsWith("restored-"))) continue;
      const root = path.join(managedRoot, entry.name);
      const coursePath = path.join(root, "course.md");
      const raw = await (entry.name.startsWith("restored-") ? backupFileIo.readFile(coursePath, 10485760).then((file) => Buffer.from(file.bytes).toString("utf8")) : readFile(coursePath, "utf8")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (raw === null) continue;
      const id = String(safeCourseMatter(raw).data.id ?? "");
      if (!COURSE_ID_PATTERN.test(id) || id !== entry.name) throw new Error(`${coursePath}: 托管课程 ID 无效`);
      if (ids.has(id)) throw new Error(`重复课程 ID“${id}”`);
      ids.add(id);
      courses.push({ id, root: entry.name.startsWith("restored-") ? path.resolve(root) : await realpath(root), enabled: true });
    }
  }

  const standaloneNotes: ConfiguredStandaloneNote[] = [];
  for (const entry of parsed.standaloneNotes ?? []) {
    const id = String(entry.id ?? "").trim();
    const title = String(entry.title ?? "").trim();
    const accent = String(entry.accent ?? "").trim();
    if (!COURSE_ID_PATTERN.test(id) || !title || !/^#[0-9a-fA-F]{6}$/.test(accent) || typeof entry.source !== "string" || !entry.source.trim()) {
      throw new Error(`${absoluteConfigPath}: standaloneNotes 配置无效`);
    }
    if (ids.has(id) || standaloneNotes.some((note) => note.id === id)) throw new Error(`重复笔记 ID“${id}”`);
    const sourcePath = await realpath(path.resolve(path.dirname(absoluteConfigPath), entry.source));
    if (!(await stat(sourcePath)).isFile()) throw new Error(`${sourcePath}: standaloneNotes source 不是文件`);
    standaloneNotes.push({ id, title, sourcePath, accent });
  }

  const noteGroups: ConfiguredNoteGroup[] = [];
  const knownNoteIds = new Set([...ids, ...standaloneNotes.map((note) => note.id)]);
  for (const entry of parsed.noteGroups ?? []) {
    const id = String(entry.id ?? "").trim();
    const title = String(entry.title ?? "").trim();
    const noteIds = Array.isArray(entry.noteIds) ? entry.noteIds.map(String) : [];
    if (!COURSE_ID_PATTERN.test(id) || !title || !noteIds.length || noteIds.some((noteId) => !knownNoteIds.has(noteId))) {
      throw new Error(`${absoluteConfigPath}: noteGroups 配置无效`);
    }
    if (noteGroups.some((group) => group.id === id)) throw new Error(`重复笔记分组 ID“${id}”`);
    noteGroups.push({ id, title, noteIds });
  }

  return { configPath: absoluteConfigPath, courses, standaloneNotes, noteGroups };
}
