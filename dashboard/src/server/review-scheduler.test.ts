import { describe, expect, it } from "vitest";

import { scheduleReviewsForCourse, getDueReviews, getStatus } from "./review-scheduler.js";
import type { CourseDetail } from "../shared/course.js";

const mockCourse: CourseDetail = {
  id: "test-course",
  title: "测试课程",
  accent: "#27624B",
  updated: "2026-09-26",
  status: "ready",
  progress: 50,
  completedTasks: 2,
  totalTasks: 4,
  currentStage: "第一章",
  nextTask: "完成练习",
  mastery: 7,
  sourcePath: "/test/course.md",
  overviewMarkdown: "",
  keyPointsMarkdown: "",
  mistakesMarkdown: "",
  stages: [{ title: "第一章", tasks: [{ text: "阅读", completed: true }, { text: "练习", completed: false }] }],
  records: [
    { date: "2026-09-20", content: "学习了极限定义", mastery: 8, difficulty: "", nextStep: "" },
    { date: "2026-09-25", content: "学习了导数", mastery: 6, difficulty: "", nextStep: "" },
  ],
  warnings: [],
};

describe("Review scheduler", () => {
  it("schedules reviews for each record", () => {
    const reviews = scheduleReviewsForCourse(mockCourse);
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews[0]).toHaveProperty("nextReviewDate");
    expect(reviews[0]).toHaveProperty("daysUntilReview");
    expect(reviews[0]).toHaveProperty("reviewNumber");
  });

  it("does not duplicate a record across unrelated stages", () => {
    const course = { ...mockCourse, stages: [...mockCourse.stages, { title: "第二章", tasks: [] }] };
    const reviews = scheduleReviewsForCourse(course, "2026-09-26");
    expect(reviews).toHaveLength(2);
    expect(reviews.every((review) => review.stage === "全课程")).toBe(true);
  });

  it("uses date intervals rather than mastery to select the next review", () => {
    const reviews = scheduleReviewsForCourse(mockCourse, "2026-09-26");
    expect(reviews.find((review) => review.recordDate === "2026-09-25")).toMatchObject({ reviewNumber: 0, nextReviewDate: "2026-09-26" });
    expect(reviews.find((review) => review.recordDate === "2026-09-20")).toMatchObject({ reviewNumber: 0, nextReviewDate: "2026-09-21", daysUntilReview: -5 });
  });

  it("lets an explicit review plan replace generated reminders for the same topic", () => {
    const explicit = [{ courseId: "test-course", topic: "学习了导数", lastReviewed: "2026-09-25", nextReview: "2026-10-05", mastery: 6, evidence: "复述", status: "unscheduled" as const }];
    const due = getDueReviews([mockCourse], 20, "2026-09-26", explicit);
    expect(due.some((review) => review.topic === "学习了导数" && review.nextReviewDate === "2026-09-26")).toBe(false);
    expect(due.filter((review) => review.topic === "学习了导数")).toHaveLength(0);
  });

  it("calculates correct status based on days until review", () => {
    expect(getStatus(-1)).toBe("overdue");
    expect(getStatus(0)).toBe("today");
    expect(getStatus(1)).toBe("upcoming");
    expect(getStatus(10)).toBe("unscheduled");
  });

  it("filters due reviews within 7 days", () => {
    const dueReviews = getDueReviews([mockCourse], 20);
    expect(dueReviews.length).toBeGreaterThan(0);
    expect(dueReviews.every((r) => r.daysUntilReview <= 7)).toBe(true);
  });

  it("sorts reviews by urgency (overdue first)", () => {
    const dueReviews = getDueReviews([mockCourse], 20);
    for (let i = 1; i < dueReviews.length; i++) {
      expect(dueReviews[i].daysUntilReview).toBeGreaterThanOrEqual(dueReviews[i - 1].daysUntilReview);
    }
  });
});
