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
