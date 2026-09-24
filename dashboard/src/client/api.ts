import type { CalendarEvent, CourseDetail, CourseId, CourseSummary, CoursesResponse, LearningStats, NoteDocument, ResourceItem, ReviewItem, TaskReference } from "../shared/course.js";
import type { SettingsData } from "./pages/SettingsPage.js";
import type { AssessmentQuestion, AnswerFeedback, DiagnosisResult } from "../../server/ai-types.js";

async function requestJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
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

// AI 诊断 API
export const createAssessment = (params: {
  courseId: string;
  topic: string;
  count: number;
  difficulty: string;
  context: string;
}) => postJson<{ questions: AssessmentQuestion[] }>("/api/ai/assessments", params);

export const submitAnswer = (params: {
  questionId: string;
  answer: string;
  context: string;
}) => postJson<AnswerFeedback>(`/api/ai/assessments/${params.questionId}/answers`, params);

export const generateDiagnosis = (params: {
  courseId: string;
  answers: Array<{ question: AssessmentQuestion; answer: string; feedback: AnswerFeedback }>;
  learningRecords: unknown[];
}) => postJson<DiagnosisResult>(`/api/ai/assessments/${params.courseId}/diagnosis`, params);

export const applyDiagnosis = (params: {
  courseId: string;
  diagnosis: DiagnosisResult;
}) => postJson<{ success: boolean }>(`/api/ai/assessments/${params.courseId}/apply`, params);
