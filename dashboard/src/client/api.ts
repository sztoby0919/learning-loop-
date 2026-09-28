import type { CalendarEvent, CourseDetail, CourseId, CourseSummary, CoursesResponse, LearningStats, MistakeItem, NoteDocument, PracticeChoice, PracticeSessionConfirmed, PracticeSessionCreated, ResourceItem, ReviewItem, ScheduledReview, TaskReference } from "../shared/course.js";
import type { AnswerFeedback } from "../server/ai-types.js";
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
export const fetchDueReviews = (signal?: AbortSignal) => requestJson<ScheduledReview[]>("/api/reviews/due", signal);
export const fetchResources = (signal?: AbortSignal) => requestJson<ResourceItem[]>("/api/resources", signal);
export const fetchCalendar = (month: string, signal?: AbortSignal) => requestJson<CalendarEvent[]>(`/api/calendar?month=${encodeURIComponent(month)}`, signal);
export const fetchStats = (signal?: AbortSignal) => requestJson<LearningStats>("/api/stats", signal);
export const fetchSettings = (signal?: AbortSignal) => requestJson<SettingsData>("/api/settings", signal);

export function fetchMistakes(id: CourseId, signal?: AbortSignal): Promise<{ items: MistakeItem[]; warnings: string[] }> {
  return requestJson(`/api/courses/${id}/mistakes`, signal);
}

export function createPracticeSession(courseId: CourseId, mistakeId: string): Promise<PracticeSessionCreated> {
  return importRequest("/api/practice-sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId, mistakeId, kind: "targeted-practice" }) });
}

export function answerPracticeSession(sessionId: string, questionId: string, choice: PracticeChoice): Promise<{ feedback: AnswerFeedback }> {
  return importRequest(`/api/practice-sessions/${encodeURIComponent(sessionId)}/answer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questionId, choice }) });
}

export function confirmPracticeSession(sessionId: string): Promise<PracticeSessionConfirmed> {
  return importRequest(`/api/practice-sessions/${encodeURIComponent(sessionId)}/confirm`, { method: "POST" });
}

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
    sourceFormat: "pdf" | "docx" | "text";
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

export type UploadProgressCallback = (percent: number) => void;

export function uploadCourseFile(file: File, onProgress?: UploadProgressCallback): Promise<CourseImportPreview> {
  return new Promise((resolve, reject) => {
    const body = new FormData();
    body.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/course-imports");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText) as CourseImportPreview); }
        catch { reject(new Error("响应解析失败，请稍后重试")); }
      } else {
        let message = `HTTP ${xhr.status}`;
        try { const payload = JSON.parse(xhr.responseText) as { error?: string }; message = payload?.error ?? message; } catch { /* ignore */ }
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error("网络错误，请检查连接后重试"));
    xhr.send(body);
  });
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

export interface ExportedData {
  version: number;
  exportedAt: string;
  courseCount: number;
  courses: Array<{ courseId: string; title: string; files: Record<string, string> }>;
}

export function exportAllData(): Promise<ExportedData> {
  return requestJson("/api/export");
}

export async function downloadAllData(): Promise<void> {
  const data = await exportAllData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `learning-loop-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export async function cancelCourseImport(id: string): Promise<void> {
  const response = await fetch(`/api/course-imports/${id}`, { method: "DELETE" });
  if (!response.ok) throw new Error("取消导入失败，请稍后重试");
}
