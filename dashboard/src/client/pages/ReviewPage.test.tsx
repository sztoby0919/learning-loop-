import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ReviewPage } from "./ReviewPage.js";

it("shows an automatic due review when reviews.md has no handwritten topic", () => {
  render(<ReviewPage courses={[{ id: "course-1", title: "数学", accent: "#27624B", updated: "2026-09-26", status: "ready", progress: 0, completedTasks: 0, totalTasks: 1, currentStage: null, nextTask: null, mastery: null }]} reviews={[]} scheduledReviews={[{ courseId: "course-1", courseTitle: "数学", accent: "#27624B", topic: "极限定义", stage: "全课程", recordDate: "2026-09-25", reviewNumber: 0, nextReviewDate: "2026-09-26", daysUntilReview: 0, mastery: null }]} />);
  expect(screen.getByText("极限定义")).toBeInTheDocument();
  expect(screen.getAllByText("今日复习")).toHaveLength(2);
  expect(screen.getByText(/尚无复习证据/)).toBeInTheDocument();
});
