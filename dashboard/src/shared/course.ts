export type CourseId = string;

export interface SourceReference {
  artifact: "course" | "notes";
  /** Zero-based h3 index within course key points, or h2 index within notes. */
  headingIndex: number;
  heading: string;
  kind: "pdf-page" | "virtual-position";
  position: number;
  sourceUrl: string;
  verifiedExcerpt: string | null;
  /** Also true for legacy/unknown provenance: these references need checking. */
  aiDerived: boolean;
}

export interface MistakeItem {
  id: string;
  courseId: CourseId;
  question: string;
  selected: string;
  correct: string;
  explanation: string;
  knowledgePoint: string | null;
  date: string;
  sourceSession: string;
  mode: "real" | "mock" | "unknown";
  attempts?: PracticeAttempt[];
  unassociated?: boolean;
}

export interface PracticeAttempt extends Omit<MistakeItem, "attempts" | "unassociated"> {
  isCorrect: boolean;
}

export type PracticeChoice = "A" | "B" | "C" | "D";

export interface PracticeSessionCreated {
  sessionId: string;
  question: {
    id: string;
    question: string;
    options: string[];
    knowledgePoint: string;
  };
  mode: "real" | "mock";
}

export interface PracticeSessionConfirmed {
  courseId: CourseId;
  mode: "real" | "mock";
  sessionFile: string;
  advanced?: boolean;
}

export type ArtifactKind = "course" | "notes" | "reviews" | "resources" | "schedule" | "sessions";
export type ArtifactStatus = "ready" | "missing" | "invalid";

export interface CourseArtifactHealth {
  artifact: ArtifactKind;
  status: ArtifactStatus;
  sourcePath: string;
  updated: string | null;
  warning?: string;
  count?: number;
}

export interface CourseTask {
  text: string;
  completed: boolean;
}

export interface CourseStage {
  title: string;
  tasks: CourseTask[];
}

export interface StudyRecord {
  date: string;
  content: string;
  mastery: number | null;
  difficulty: string;
  nextStep: string;
}

export interface CourseSummary {
  id: CourseId;
  title: string;
  shortTitle?: string;
  accent: string;
  updated: string;
  order?: number;
  archived?: boolean;
  status: "ready" | "missing" | "invalid";
  progress: number | null;
  completedTasks: number;
  totalTasks: number;
  currentStage: string | null;
  nextTask: string | null;
  mastery: number | null;
  warning?: string;
  artifacts?: CourseArtifactHealth[];
}

export interface CourseDetail extends CourseSummary {
  overviewMarkdown: string;
  keyPointsMarkdown: string;
  mistakesMarkdown: string;
  stages: CourseStage[];
  records: StudyRecord[];
  warnings: string[];
  sourcePath: string;
}

export interface CoursesResponse {
  courses: CourseSummary[];
  recentRecords: Array<StudyRecord & { courseId: CourseId; courseTitle: string; accent: string }>;
  warningCount: number;
}

export interface TaskReference extends CourseTask {
  courseId: CourseId;
  courseTitle: string;
  accent: string;
  stage: string;
}

export interface NoteDocument {
  courseId: CourseId;
  title?: string;
  accent?: string;
  groupId?: string;
  groupTitle?: string;
  isStandalone?: boolean;
  updated: string;
  markdown: string;
  headings: string[];
  warnings: string[];
}

export type ReviewStatus = "unscheduled" | "upcoming" | "today" | "overdue";

export interface ReviewItem {
  courseId: CourseId;
  topic: string;
  lastReviewed: string | null;
  nextReview: string | null;
  mastery: number | null;
  evidence: string;
  status: ReviewStatus;
}

export interface ScheduledReview {
  courseId: string;
  courseTitle: string;
  accent: string;
  topic: string;
  stage: string;
  recordDate: string;
  reviewNumber: number;
  nextReviewDate: string;
  daysUntilReview: number;
  mastery: number | null;
}

export interface ReviewDocument {
  courseId: CourseId;
  updated: string;
  items: ReviewItem[];
  warnings: string[];
}

export interface ResourceItem {
  courseId: CourseId;
  name: string;
  type: string;
  location: string;
  stage: string;
  status: string;
  note: string;
}

export interface ResourceDocument {
  courseId: CourseId;
  updated: string;
  items: ResourceItem[];
  warnings: string[];
}

export interface ScheduleItem {
  courseId: CourseId;
  date: string;
  type: string;
  title: string;
  stage: string;
  status: string;
  note: string;
}

export interface ScheduleDocument {
  courseId: CourseId;
  updated: string;
  items: ScheduleItem[];
  warnings: string[];
}

export interface CalendarEvent {
  id: string;
  courseId: CourseId;
  courseTitle: string;
  accent: string;
  date: string;
  kind: "schedule" | "review" | "record";
  title: string;
  status: string;
  detail: string;
}

export interface LearningStats {
  weeklyRecords: Array<{ date: string; count: number }>;
  streakDays: number;
  completedTasks: number;
  totalTasks: number;
  completionRate: number | null;
  averageMastery: number | null;
  recordCount: number;
  dueReviewCount: number;
  resourceStatusCounts: Record<string, number>;
  courses: Array<{ courseId: CourseId; title: string; accent: string; progress: number | null; mastery: number | null; recordCount: number }>;
  evidenceBasedMastery?: number | null; // 有证据的掌握度（来自诊断）
  diagnosisBeforeMastery?: number | null;
  weakPointCount?: number; // 待修复知识点数
  diagnosisCount?: number; // 诊断次数
}
