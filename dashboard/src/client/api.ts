import type { CalendarEvent, CourseDetail, CourseId, CourseSummary, CoursesResponse, LearningStats, MistakeItem, NoteDocument, PracticeChoice, PracticeSessionConfirmed, PracticeSessionCreated, ResourceItem, ReviewItem, ScheduledReview, SourceReference, TaskReference } from "../shared/course.js";
import type { AnswerFeedback } from "../server/ai-types.js";
import type { SettingsData } from "./pages/SettingsPage.js";
import type { BackupManifest, RestorePreview } from "../shared/course-backup.js";

const backupQuery = (courseId?: string) => courseId ? `?courseId=${encodeURIComponent(courseId)}` : "";
export const previewBackup = (courseId?: string) => requestJson<BackupManifest>(`/api/backups/preview${backupQuery(courseId)}`);
export async function downloadBackup(courseId?: string): Promise<void> {
  const response = await fetch(`/api/backups${backupQuery(courseId)}`);
  if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error ?? `HTTP ${response.status}`); }
  const blob = await response.blob(); const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = `learning-loop-${new Date().toISOString().slice(0, 10)}.zip`;
  try { link.click(); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
export const fetchRestore = (id: string, signal?: AbortSignal) => importRequest<RestorePreview>(`/api/restores/${encodeURIComponent(id)}`, { method: "GET", signal });
export function uploadRestore(file: File): Promise<RestorePreview> {
  const body = new FormData(); body.append("file", file);
  return importRequest("/api/restores", { method: "POST", body });
}
export const confirmRestore = (id: string) => importRequest<{ courseIds: string[] }>(`/api/restores/${encodeURIComponent(id)}/confirm`, { method: "POST" });
export async function cancelRestore(id: string): Promise<void> {
  const response = await fetch(`/api/restores/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new ImportRequestError(payload.error ?? `HTTP ${response.status}`, response.status); }
}

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

export function fetchSourceReferences(id: CourseId, signal?: AbortSignal): Promise<SourceReference[]> {
  return requestJson(`/api/courses/${encodeURIComponent(id)}/source-references`, signal);
}

export const fetchTasks = (signal?: AbortSignal) => requestJson<TaskReference[]>("/api/tasks", signal);
export const fetchNotes = (signal?: AbortSignal) => requestJson<NoteDocument[]>("/api/notes", signal);
export const fetchReviews = (signal?: AbortSignal) => requestJson<ReviewItem[]>("/api/reviews", signal);
export const fetchDueReviews = (signal?: AbortSignal) => requestJson<ScheduledReview[]>("/api/reviews/due", signal);
export const fetchResources = (signal?: AbortSignal) => requestJson<ResourceItem[]>("/api/resources", signal);
export const fetchCalendar = (month: string, signal?: AbortSignal) => requestJson<CalendarEvent[]>(`/api/calendar?month=${encodeURIComponent(month)}`, signal);
export const fetchStats = (signal?: AbortSignal) => requestJson<LearningStats>("/api/stats", signal);
export const fetchSettings = (signal?: AbortSignal) => requestJson<SettingsData>("/api/settings", signal);

export function fetchMistakes(id: CourseId, signal?: AbortSignal): Promise<{ items: MistakeItem[]; warnings: string[]; unassociatedAttempts?: import("../shared/course.js").PracticeAttempt[] }> {
  return requestJson(`/api/courses/${id}/mistakes`, signal);
}

export function createPracticeSession(courseId: CourseId, mistakeId: string): Promise<PracticeSessionCreated> {
  return importRequest("/api/practice-sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId, mistakeId, kind: "targeted-practice" }) });
}

export function createReviewSession(courseId: CourseId, topic: string): Promise<PracticeSessionCreated> {
  return importRequest("/api/practice-sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId, topic, kind: "review-attempt" }) });
}

export function answerPracticeSession(sessionId: string, questionId: string, choice: PracticeChoice): Promise<{ feedback: AnswerFeedback }> {
  return importRequest(`/api/practice-sessions/${encodeURIComponent(sessionId)}/answer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questionId, choice }) });
}

export function confirmPracticeSession(sessionId: string): Promise<PracticeSessionConfirmed> {
  return importRequest(`/api/practice-sessions/${encodeURIComponent(sessionId)}/confirm`, { method: "POST" });
}

import type { AiExcerpt, AiOperation, CourseImportPreview, DraftSummary } from "../shared/course-import.js";
export type { CourseImportPreview } from "../shared/course-import.js";

export class ImportRequestError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export const listCourseImports = () => importRequest<DraftSummary[]>("/api/course-imports", { method: "GET" });
export const fetchCourseImport = (id: string, signal?: AbortSignal) => importRequest<CourseImportPreview>(`/api/course-imports/${encodeURIComponent(id)}`, { method: "GET", signal });
const importJson = <T>(id: string, route: string, body: unknown, method = "POST") => importRequest<T>(`/api/course-imports/${encodeURIComponent(id)}/${route}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const previewImportAi = (id: string, expectedRevision: number, stageIds: string[]) => importJson<AiExcerpt>(id, "ai-excerpt", { expectedRevision, stageIds });
export const startImportAi = (id: string, excerpt: AiExcerpt) => importJson<AiOperation>(id, "ai-operations", { expectedRevision: excerpt.revision, stageIds: excerpt.stageIds, excerptHash: excerpt.excerptHash, consent: true });
export const getImportAi = (id: string, operationId: string, signal?: AbortSignal) => importRequest<AiOperation>(`/api/course-imports/${encodeURIComponent(id)}/ai-operations/${encodeURIComponent(operationId)}`, { method: "GET", signal });
export const cancelImportAi = (id: string, operationId: string) => importRequest<AiOperation>(`/api/course-imports/${encodeURIComponent(id)}/ai-operations/${encodeURIComponent(operationId)}`, { method: "DELETE" });
export const applyImportAi = (id: string, candidateId: string, expectedRevision: number, acceptedStageIds: string[]) => importJson<CourseImportPreview>(id, `ai-candidates/${encodeURIComponent(candidateId)}/apply`, { expectedRevision, acceptedStageIds });
export const rejectImportAi = (id: string, candidateId: string, expectedRevision: number) => importJson<CourseImportPreview>(id, `ai-candidates/${encodeURIComponent(candidateId)}`, { expectedRevision }, "DELETE");
export const undoImportAi = (id: string, expectedRevision: number) => importJson<CourseImportPreview>(id, "ai-undo", { expectedRevision });

async function importRequest<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
    throw new ImportRequestError(payload.error ?? `HTTP ${response.status}`, response.status);
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
  return importRequest(`/api/course-imports/${preview.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: preview.revision, title, goal, weeklyHours, stages }) });
}

export function confirmCourseImport(id: string, expectedRevision?: number): Promise<{ courseId: string }> {
  return importRequest(`/api/course-imports/${id}/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision }) });
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
