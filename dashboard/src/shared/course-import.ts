export interface PdfQuality {
  version: 1;
  noTextPages: number[];
  sideNotePages: number[];
  complexPages: number[];
}

export interface ExtractedDocument {
  title: string;
  pageCount: number;
  pages: Array<{ page: number; text: string }>;
  outline: Array<{ title: string; page: number }>;
  warnings: string[];
  sourceFormat: "pdf" | "docx" | "text";
  quality?: PdfQuality;
}

export interface ImportStage {
  // Legacy editable inputs omit the ID; the server assigns it before saving.
  id?: string;
  title: string;
  tasks: string[];
  source?: { title: string; startPage: number; endPage: number };
}

export interface ImportNote {
  title: string;
  page: number;
  content: string;
  stageId?: string;
  provenance?: "source" | "ai";
}

export interface ImportDraft {
  title: string;
  originalFilename: string;
  pageCount: number;
  goal: string;
  weeklyHours: number | null;
  stages: ImportStage[];
  notes: ImportNote[];
  references?: Array<{ title: string; page: number }>;
  warnings: string[];
  aiStatus: "not-used" | "complete" | "failed";
  sourceFormat: "pdf" | "docx" | "text";
  deadlines?: Array<{ date: string; page: number; type: string; title: string }>;
  quality?: PdfQuality;
}

export interface DraftEntry {
  version: 1;
  id: string;
  courseId: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  state: "open" | "committing" | "committed";
  draft: ImportDraft;
  source: ExtractedDocument;
  sourceExtension: string;
  candidate?: AiCandidate;
  operation?: AiOperation;
  undo?: { appliedRevision: number; before: ImportDraft };
}

export interface AiExcerpt {
  revision: number;
  stageIds: string[];
  excerptHash: string;
  text: string;
  pages: Array<{ stageId: string; page: number; text: string }>;
  chars: number;
}
export interface AiSuggestion { stageId: string; title: string; tasks: string[]; notes: ImportNote[] }
export interface AiCandidate { id: string; baseRevision: number; suggestions: AiSuggestion[] }
export interface AiOperation {
  id: string;
  status: "running" | "complete" | "cancelled" | "failed" | "interrupted";
  startedAt: number;
  candidate?: AiCandidate;
  error?: string;
}

export interface DraftSummary {
  id: string;
  title: string;
  updatedAt: number;
  expiresAt: number;
  status: "ready" | "invalid";
  warning?: string;
}

export interface CourseImportPreview {
  id: string;
  courseId: string;
  draft: ImportDraft;
  files: Record<string, string>;
  aiAvailable: boolean;
  excerptChars: number;
  revision?: number;
  expiresAt?: number;
  sourceUrl?: string;
  candidate?: AiCandidate;
  operation?: AiOperation;
  canUndo?: boolean;
}
