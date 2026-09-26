import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

import type {
  ArtifactKind,
  CalendarEvent,
  CourseArtifactHealth,
  CourseDetail,
  CourseId,
  CoursesResponse,
  LearningStats,
  NoteDocument,
  ResourceDocument,
  ResourceItem,
  ReviewDocument,
  ReviewItem,
  ScheduleDocument,
  TaskReference,
} from "../shared/course.js";
import { parseNotesMarkdown, parseResourcesMarkdown, parseReviewsMarkdown, parseScheduleMarkdown, parseStandaloneNoteMarkdown } from "./artifact-parser.js";
import type { ConfiguredCourse, DashboardConfig } from "./dashboard-config.js";
import { parseCourseMarkdown } from "./course-parser.js";

type ArtifactDocument = NoteDocument | ReviewDocument | ResourceDocument | ScheduleDocument;
type OptionalArtifact = Exclude<ArtifactKind, "course" | "sessions">;

function artifactPath(root: string, artifact: ArtifactKind): string {
  if (artifact === "course") return path.join(root, "course.md");
  if (artifact === "sessions") return path.join(root, "sessions");
  return path.join(root, `${artifact}.md`);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class WorkspaceRepository {
  private readonly courseCache = new Map<CourseId, CourseDetail>();
  private readonly artifactCache = new Map<string, ArtifactDocument>();
  private readonly standaloneNoteCache = new Map<string, NoteDocument>();
  private readonly health = new Map<string, CourseArtifactHealth>();

  constructor(readonly config: DashboardConfig, private readonly today: () => string) {}

  async addCourse(course: ConfiguredCourse): Promise<void> {
    if (this.config.courses.some((item) => item.id === course.id || item.root === course.root)) throw new Error("课程已存在");
    const raw = await readFile(path.join(course.root, "course.md"), "utf8");
    if (parseCourseMarkdown(raw, path.join(course.root, "course.md")).id !== course.id) throw new Error("课程 ID 不匹配");
    this.config.courses.push(course);
    await Promise.all((["course", "notes", "reviews", "resources", "schedule", "sessions"] as ArtifactKind[]).map((kind) => this.refresh(course.id, kind)));
  }

  private configured(id: CourseId) {
    return this.config.courses.find((course) => course.id === id);
  }

  private noteGroup(id: string) {
    const group = this.config.noteGroups?.find((candidate) => candidate.noteIds.includes(id));
    return group ? { groupId: group.id, groupTitle: group.title } : {};
  }

  private async getStandaloneNote(id: string): Promise<NoteDocument | null> {
    return this.standaloneNoteCache.get(id) ?? this.refreshStandaloneNote(id);
  }

  async refreshStandaloneNote(id: string): Promise<NoteDocument | null> {
    const configured = this.config.standaloneNotes?.find((note) => note.id === id);
    if (!configured) return null;
    try {
      const [raw, details] = await Promise.all([readFile(configured.sourcePath, "utf8"), stat(configured.sourcePath)]);
      const parsed = parseStandaloneNoteMarkdown(raw, configured.sourcePath, { ...configured, updated: details.mtime.toISOString().slice(0, 10) });
      const note = { ...parsed, isStandalone: true, ...this.noteGroup(id) };
      this.standaloneNoteCache.set(id, note);
      return note;
    } catch {
      return this.standaloneNoteCache.get(id) ?? null;
    }
  }

  async getCourse(id: CourseId): Promise<CourseDetail | null> {
    const cached = this.courseCache.get(id);
    return cached ?? this.refreshCourse(id);
  }

  private async refreshCourse(id: CourseId): Promise<CourseDetail | null> {
    const configured = this.configured(id);
    if (!configured) return null;
    const sourcePath = artifactPath(configured.root, "course");
    try {
      const parsed = parseCourseMarkdown(await readFile(sourcePath, "utf8"), sourcePath);
      this.courseCache.set(id, parsed);
      this.health.set(`${id}:course`, { artifact: "course", status: "ready", sourcePath, updated: parsed.updated });
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cached = this.courseCache.get(id);
      this.health.set(`${id}:course`, { artifact: "course", status: isMissing(error) ? "missing" : "invalid", sourcePath, updated: cached?.updated ?? null, warning: cached ? `文件暂时无法解析，已保留上次成功数据。${message}` : message });
      return cached ?? null;
    }
  }

  private async getArtifact<T extends ArtifactDocument>(id: CourseId, artifact: OptionalArtifact): Promise<T | null> {
    const key = `${id}:${artifact}`;
    return (this.artifactCache.get(key) as T | undefined) ?? this.refreshArtifact<T>(id, artifact);
  }

  private async refreshArtifact<T extends ArtifactDocument>(id: CourseId, artifact: OptionalArtifact): Promise<T | null> {
    const configured = this.configured(id);
    if (!configured) return null;
    const key = `${id}:${artifact}`;
    const sourcePath = artifactPath(configured.root, artifact);
    try {
      const raw = await readFile(sourcePath, "utf8");
      const parsed = ({
        notes: () => parseNotesMarkdown(raw, sourcePath),
        reviews: () => parseReviewsMarkdown(raw, sourcePath, this.today()),
        resources: () => parseResourcesMarkdown(raw, sourcePath),
        schedule: () => parseScheduleMarkdown(raw, sourcePath),
      }[artifact]()) as T;
      if (parsed.courseId !== id) throw new Error(`${sourcePath}: courseId 与 course.md 不一致`);
      this.artifactCache.set(key, parsed);
      this.health.set(key, { artifact, status: "ready", sourcePath, updated: parsed.updated, warning: parsed.warnings.length ? parsed.warnings.join("；") : undefined });
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cached = this.artifactCache.get(key) as T | undefined;
      this.health.set(key, { artifact, status: isMissing(error) ? "missing" : "invalid", sourcePath, updated: cached?.updated ?? null, warning: cached ? `文件暂时无法解析，已保留上次成功数据。${message}` : message });
      return cached ?? null;
    }
  }

  async refresh(id: CourseId, artifact: ArtifactKind): Promise<void> {
    if (artifact === "course") await this.refreshCourse(id);
    else if (artifact === "sessions") await this.refreshSessions(id);
    else await this.refreshArtifact(id, artifact);
  }

  async getCourses(): Promise<CoursesResponse> {
    const details = (await Promise.all(this.config.courses.map((course) => this.getCourse(course.id)))).filter((course): course is CourseDetail => course !== null);
    const recentRecords = details.flatMap((course) => course.records.map((record) => ({ ...record, courseId: course.id, courseTitle: course.title, accent: course.accent })))
      .sort((left, right) => right.date.localeCompare(left.date)).slice(0, 6);
    return {
      courses: details.sort((a, b) => (a.order ?? 999) - (b.order ?? 999)).map(({ overviewMarkdown: _overview, keyPointsMarkdown: _key, mistakesMarkdown: _mistakes, stages: _stages, records: _records, warnings: _warnings, sourcePath: _source, ...summary }) => summary),
      recentRecords,
      warningCount: [...this.health.values()].filter((item) => item.status !== "ready" || item.warning).length,
    };
  }

  private async details(): Promise<CourseDetail[]> {
    return (await Promise.all(this.config.courses.map((course) => this.getCourse(course.id)))).filter((course): course is CourseDetail => course !== null);
  }

  async getTasks(): Promise<TaskReference[]> {
    return (await this.details()).flatMap((course) => course.stages.flatMap((stage) => stage.tasks.map((task) => ({ ...task, courseId: course.id, courseTitle: course.title, accent: course.accent, stage: stage.title }))));
  }

  async getNotes(): Promise<NoteDocument[]> {
    const courseNotes = (await Promise.all(this.config.courses.map(async (course): Promise<NoteDocument | null> => {
      const [note, details] = await Promise.all([this.getArtifact<NoteDocument>(course.id, "notes"), this.getCourse(course.id)]);
      return note && details ? { ...note, title: details.title, accent: details.accent, ...this.noteGroup(course.id) } : null;
    }))).filter((item): item is NoteDocument => item !== null);
    const standaloneNotes = (await Promise.all((this.config.standaloneNotes ?? []).map((note) => this.getStandaloneNote(note.id)))).filter((item): item is NoteDocument => item !== null);
    return [...courseNotes, ...standaloneNotes];
  }

  async getReviews(): Promise<ReviewItem[]> {
    const documents = (await Promise.all(this.config.courses.map((course) => this.getArtifact<ReviewDocument>(course.id, "reviews")))).filter((item): item is ReviewDocument => item !== null);
    return documents.flatMap((document) => document.items);
  }

  async getResources(): Promise<ResourceItem[]> {
    const documents = (await Promise.all(this.config.courses.map((course) => this.getArtifact<ResourceDocument>(course.id, "resources")))).filter((item): item is ResourceDocument => item !== null);
    return documents.flatMap((document) => document.items);
  }

  async getSchedules() {
    const documents = (await Promise.all(this.config.courses.map((course) => this.getArtifact<ScheduleDocument>(course.id, "schedule")))).filter((item): item is ScheduleDocument => item !== null);
    return documents.flatMap((document) => document.items);
  }

  async getCalendar(month: string): Promise<CalendarEvent[]> {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month 必须为 YYYY-MM");
    const details = await this.details();
    const meta = new Map(details.map((course) => [course.id, course]));
    const scheduleEvents = (await this.getSchedules()).map((item, index) => ({ id: `schedule:${item.courseId}:${item.date}:${index}`, courseId: item.courseId, courseTitle: meta.get(item.courseId)?.title ?? item.courseId, accent: meta.get(item.courseId)?.accent ?? "#1F5A43", date: item.date, kind: "schedule" as const, title: item.title, status: item.status, detail: [item.type, item.stage, item.note].filter(Boolean).join(" · ") }));
    const reviewEvents = (await this.getReviews()).flatMap((item, index) => item.nextReview ? [{ id: `review:${item.courseId}:${item.nextReview}:${index}`, courseId: item.courseId, courseTitle: meta.get(item.courseId)?.title ?? item.courseId, accent: meta.get(item.courseId)?.accent ?? "#1F5A43", date: item.nextReview, kind: "review" as const, title: `复习：${item.topic}`, status: item.status, detail: item.evidence }] : []);
    const recordEvents = details.flatMap((course) => course.records.map((record, index) => ({ id: `record:${course.id}:${record.date}:${index}`, courseId: course.id, courseTitle: course.title, accent: course.accent, date: record.date, kind: "record" as const, title: record.content, status: "completed", detail: record.difficulty })));
    return [...scheduleEvents, ...reviewEvents, ...recordEvents].filter((event) => event.date.startsWith(month)).sort((a, b) => a.date.localeCompare(b.date));
  }

  async getStats(): Promise<LearningStats> {
    const courses = await this.details();
    const reviews = await this.getReviews();
    const resources = await this.getResources();
    const completedTasks = courses.reduce((sum, course) => sum + course.completedTasks, 0);
    const totalTasks = courses.reduce((sum, course) => sum + course.totalTasks, 0);
    const mastery = courses.flatMap((course) => course.mastery === null ? [] : [course.mastery]);
    const resourceStatusCounts = resources.reduce<Record<string, number>>((counts, resource) => ({ ...counts, [resource.status || "未设置"]: (counts[resource.status || "未设置"] ?? 0) + 1 }), {});
    const assessments = (await Promise.all(this.config.courses.map(async (configured) => {
      const directory = path.join(configured.root, "sessions");
      const files = await readdir(directory).catch(() => [] as string[]);
      return (await Promise.all(files.filter((file) => file.endsWith(".md")).map(async (file) => {
        try {
          const data = matter(await readFile(path.join(directory, file), "utf8")).data;
          const initial = Number(data.initialAverageScore);
          const final = Number(data.finalAverageScore);
          const weak = Number(data.weakPointCount);
          if (data.kind !== "ai-assessment" || data.courseId !== configured.id || ![initial, final, weak].every(Number.isFinite)) return null;
          return { courseId: configured.id, file, initial, final, weak };
        } catch { return null; }
      }))).filter((item): item is { courseId: string; file: string; initial: number; final: number; weak: number } => item !== null);
    }))).flat();
    const latestByCourse = new Map<string, { file: string; weak: number }>();
    for (const item of assessments) {
      const previous = latestByCourse.get(item.courseId);
      if (!previous || item.file > previous.file) latestByCourse.set(item.courseId, { file: item.file, weak: item.weak });
    }
    return {
      completedTasks, totalTasks, completionRate: totalTasks ? Math.round(completedTasks / totalTasks * 100) : null,
      averageMastery: mastery.length ? Math.round(mastery.reduce((sum, value) => sum + value, 0) / mastery.length * 10) / 10 : null,
      recordCount: courses.reduce((sum, course) => sum + course.records.length, 0),
      diagnosisCount: assessments.length,
      evidenceBasedMastery: assessments.length ? Math.round(assessments.reduce((sum, item) => sum + item.final, 0) / assessments.length) / 10 : null,
      diagnosisBeforeMastery: assessments.length ? Math.round(assessments.reduce((sum, item) => sum + item.initial, 0) / assessments.length) / 10 : null,
      weakPointCount: [...latestByCourse.values()].reduce((sum, item) => sum + item.weak, 0),
      dueReviewCount: reviews.filter((item) => item.status === "today" || item.status === "overdue").length,
      resourceStatusCounts,
      courses: courses.map((course) => ({ courseId: course.id, title: course.title, accent: course.accent, progress: course.progress, mastery: course.mastery, recordCount: course.records.length })),
    };
  }

  private async refreshSessions(id: CourseId) {
    const configured = this.configured(id);
    if (!configured) return;
    const sourcePath = artifactPath(configured.root, "sessions");
    try {
      const files = (await readdir(sourcePath, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
      const dates = await Promise.all(files.map(async (file) => (await stat(path.join(sourcePath, file.name))).mtime));
      this.health.set(`${id}:sessions`, { artifact: "sessions", status: "ready", sourcePath, updated: dates.length ? dates.sort((a, b) => b.getTime() - a.getTime())[0].toISOString().slice(0, 10) : null, count: files.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.health.set(`${id}:sessions`, { artifact: "sessions", status: isMissing(error) ? "missing" : "invalid", sourcePath, updated: null, warning: message });
    }
  }

  async getSettings() {
    await Promise.all(this.config.courses.flatMap((course) => [this.getCourse(course.id), this.getArtifact(course.id, "notes"), this.getArtifact(course.id, "reviews"), this.getArtifact(course.id, "resources"), this.getArtifact(course.id, "schedule"), this.refreshSessions(course.id)]));
    return {
      configPath: this.config.configPath,
      courses: this.config.courses.map((configured) => ({ id: configured.id, root: configured.root, artifacts: (["course", "notes", "reviews", "resources", "schedule", "sessions"] as ArtifactKind[]).map((artifact): CourseArtifactHealth => this.health.get(`${configured.id}:${artifact}`) ?? { artifact, status: "missing", sourcePath: artifactPath(configured.root, artifact), updated: null }) })),
    };
  }
}
