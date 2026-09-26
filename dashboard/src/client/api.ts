import type { CalendarEvent, CourseDetail, CourseId, CourseSummary, CoursesResponse, LearningStats, NoteDocument, ResourceItem, ReviewItem, TaskReference } from "../shared/course.js";
import type { SettingsData } from "./pages/SettingsPage.js";

async function requestJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function fetchCourses(signal?: AbortSignal): Promise<CoursesResponse> {
  return requestJson("/api/courses", signal);
}

export function fetchCourse(id: CourseId, signal?: AbortSignal): Promise<CourseDetail | CourseSummary> {
  return requestJson(`/api/courses/${id}`, signal);
}

export const fetchTasks = (signal?: AbortSignal) => requestJson<TaskReference[]>("/api/tasks", signal);
export const fetchNotes = (signal?: AbortSignal) => requestJson<NoteDocument[]>("/api/notes", signal);
export const fetchReviews = (signal?: AbortSignal) => requestJson<ReviewItem[]>("/api/reviews", signal);
export const fetchResources = (signal?: AbortSignal) => requestJson<ResourceItem[]>("/api/resources", signal);
export const fetchCalendar = (month: string, signal?: AbortSignal) => requestJson<CalendarEvent[]>(`/api/calendar?month=${encodeURIComponent(month)}`, signal);
export const fetchStats = (signal?: AbortSignal) => requestJson<LearningStats>("/api/stats", signal);
export const fetchSettings = (signal?: AbortSignal) => requestJson<SettingsData>("/api/settings", signal);

export interface CourseImportPreview {
  id: string;
  courseId: string;
  draft: {
    title: string;
    originalFilename: string;
    pageCount: number;
    goal: string;
    weeklyHours: number | null;
    stages: Array<{ title: string; tasks: string[] }>;
    notes: Array<{ title: string; page: number; content: string }>;
    warnings: string[];
    aiStatus: "not-used" | "complete" | "failed";
  };
  files: Record<string, string>;
  aiAvailable: boolean;
  excerptChars: number;
}

async function importRequest<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function uploadCoursePdf(file: File): Promise<CourseImportPreview> {
  const body = new FormData();
  body.append("file", file);
  return importRequest("/api/course-imports", { method: "POST", body });
}

export function updateCourseImport(preview: CourseImportPreview): Promise<CourseImportPreview> {
  const { title, goal, weeklyHours, stages } = preview.draft;
  return importRequest(`/api/course-imports/${preview.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, goal, weeklyHours, stages }) });
}

export function enrichCourseImport(id: string): Promise<CourseImportPreview> {
  return importRequest(`/api/course-imports/${id}/enrich`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ consent: true }) });
}

export function confirmCourseImport(id: string): Promise<{ courseId: string }> {
  return importRequest(`/api/course-imports/${id}/confirm`, { method: "POST" });
}

export async function cancelCourseImport(id: string): Promise<void> {
  const response = await fetch(`/api/course-imports/${id}`, { method: "DELETE" });
  if (!response.ok) throw new Error("取消导入失败，请稍后重试");
}
