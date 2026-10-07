import type { CourseStage } from "./course.js";
export interface CourseEditSnapshot {
  expectedHash: string;
  title: string;
  overviewMarkdown: string;
  stages: (Omit<CourseStage, "tasks"> & { sourceStage?: number; tasks: (CourseStage["tasks"][number] & { sourceTask?: number })[] })[];
}
