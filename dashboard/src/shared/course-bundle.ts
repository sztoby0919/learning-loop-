import type { CourseImportPreview } from "./course-import.js";
export const BUNDLE_LIMITS = { files: 10, totalBytes: 200 * 1024 * 1024 };
export interface CourseSourceDocument {
  id: string;
  filename: string;
  storedName: string;
  sourceFormat: "pdf" | "docx" | "text";
  pageCount?: number;
}
export interface CourseBundlePreview {
  id: string;
  revision: number;
  title: string;
  courseId: string;
  targetCourseId?: string;
  expiresAt: number;
  documents: CourseImportPreview[];
  files: Record<string, string>;
}
export interface CourseBundleSummary {
  id: string; title: string; targetCourseId?: string; expiresAt: number; warning?: string;
}
