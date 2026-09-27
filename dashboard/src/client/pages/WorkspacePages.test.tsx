import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import type { CalendarEvent, CourseSummary, LearningStats, NoteDocument, ResourceItem, ReviewItem, TaskReference } from "../../shared/course.js";
import { CalendarPage } from "./CalendarPage.js";
import { CoursesPage } from "./CoursesPage.js";
import { NotesPage } from "./NotesPage.js";
import { ResourcesPage } from "./ResourcesPage.js";
import { ReviewPage } from "./ReviewPage.js";
import { SettingsPage } from "./SettingsPage.js";
import { StatsPage } from "./StatsPage.js";
import { TasksPage } from "./TasksPage.js";

const courses: CourseSummary[] = [{ id: "compiler", title: "编译原理", shortTitle: "编译原理", accent: "#27624B", updated: "2026-08-29", status: "ready", progress: 50, completedTasks: 1, totalTasks: 2, currentStage: "词法分析", nextTask: "完成 Lexer", mastery: 9 }];
const tasks: TaskReference[] = [
  { courseId: "compiler", courseTitle: "编译原理", accent: "#27624B", stage: "词法分析", text: "理解 Token", completed: true },
  { courseId: "compiler", courseTitle: "编译原理", accent: "#27624B", stage: "词法分析", text: "完成 Lexer", completed: false },
];

describe("工作区页面", () => {
  it("任务页可以按完成状态筛选", () => {
    render(<MemoryRouter><TasksPage courses={courses} tasks={tasks} /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("完成状态"), { target: { value: "pending" } });
    expect(screen.getByText("完成 Lexer")).toBeInTheDocument();
    expect(screen.queryByText("理解 Token")).not.toBeInTheDocument();
  });

  it("复习页把空下次复习日期显示为未安排", () => {
    const reviews: ReviewItem[] = [{ courseId: "compiler", topic: "FIRST 集", lastReviewed: null, nextReview: null, mastery: null, evidence: "尚未复测", status: "unscheduled" }];
    render(<ReviewPage courses={courses} reviews={reviews} />);
    expect(screen.getAllByText("未安排").length).toBeGreaterThan(0);
    expect(screen.getByText("尚未复测")).toBeInTheDocument();
  });

  it("课程页显示文件完整度，笔记页渲染 Markdown", () => {
    const withHealth = [{ ...courses[0], artifacts: [{ artifact: "notes" as const, status: "ready" as const, sourcePath: "notes.md", updated: "2026-08-29" }] }];
    const notes: NoteDocument[] = [{ courseId: "compiler", updated: "2026-08-29", markdown: "# 笔记\n## FIRST 集\n关键内容", headings: ["FIRST 集"], warnings: [] }];
    const { unmount } = render(<MemoryRouter><CoursesPage courses={withHealth} /></MemoryRouter>);
    expect(screen.getByText("1 / 1 个文件可用")).toBeInTheDocument();
    unmount();
    render(<MemoryRouter><NotesPage courses={courses} notes={notes} /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "FIRST 集" })).toBeInTheDocument();
  });

  it("笔记页将 CS336 和 FlashInfer 放在 ai infra 分组下", () => {
    const groupedCourses: CourseSummary[] = [
      { ...courses[0], id: "cs336", title: "CS336", shortTitle: "CS336" },
    ];
    const groupedNotes = [
      { courseId: "cs336", updated: "2026-09-02", markdown: "# CS336", headings: ["注意力"], warnings: [], title: "CS336", groupId: "ai-infra", groupTitle: "ai infra" },
      { courseId: "flashinfer-kvcache-parallelism", updated: "2026-09-02", markdown: "# FlashInfer", headings: ["KV cache"], warnings: [], title: "flashinfer-kvcache-parallelism", groupId: "ai-infra", groupTitle: "ai infra" },
    ] as NoteDocument[];

    render(<MemoryRouter><NotesPage courses={groupedCourses} notes={groupedNotes} /></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "ai infra" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /CS336/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /flashinfer-kvcache-parallelism/ })).toBeInTheDocument();
  });

  it("资源页按使用状态筛选，日历只显示选中月份事件", () => {
    const resources: ResourceItem[] = [{ courseId: "compiler", name: "教材", type: "教材", location: "C:\\book.pdf", stage: "词法分析", status: "使用中", note: "主教材" }];
    const { unmount } = render(<ResourcesPage courses={courses} resources={resources} />);
    expect(screen.getByText("教材")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("资源状态"), { target: { value: "未开始" } });
    expect(screen.queryByText("主教材")).not.toBeInTheDocument();
    unmount();
    const events: CalendarEvent[] = [{ id: "1", courseId: "compiler", courseTitle: "编译原理", accent: "#27624B", date: "2026-08-29", kind: "record", title: "完成练习", status: "completed", detail: "" }];
    render(<CalendarPage month="2026-08" events={events} onMonthChange={() => undefined} />);
    expect(screen.getByText("完成练习")).toBeInTheDocument();
  });

  it("统计页只显示可计算指标，设置页保存本地隐藏偏好", () => {
    const stats: LearningStats = { weeklyRecords: [], streakDays: 0, completedTasks: 1, totalTasks: 2, completionRate: 50, averageMastery: 9, recordCount: 1, dueReviewCount: 0, resourceStatusCounts: { 使用中: 1 }, courses: [{ courseId: "compiler", title: "编译原理", accent: "#27624B", progress: 50, mastery: 9, recordCount: 1 }] };
    const { unmount } = render(<StatsPage stats={stats} />);
    expect(screen.getAllByText("50%").length).toBeGreaterThan(0);
    unmount();
    localStorage.clear();
    render(<SettingsPage settings={{ configPath: "dashboard.config.json", courses: [{ id: "compiler", root: "D:\\course", artifacts: [] }] }} courses={courses} />);
    expect(screen.queryByText("从备份恢复")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "显示编译原理" }));
    expect(localStorage.getItem("study-dashboard.preferences.v1")).toContain("compiler");
  });
});
