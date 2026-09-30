import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { LearningStats } from "../../shared/course.js";
import { StatsPage } from "./StatsPage.js";

describe("StatsPage", () => {
  it("shows a single diagnosis score when answers cannot be retried", () => {
    const stats = { weeklyRecords: [], streakDays: 0, completionRate: null, averageMastery: null, evidenceBasedMastery: 6, diagnosisBeforeMastery: 6, diagnosisCount: 1, recordCount: 0, dueReviewCount: 0, weakPointCount: 1, completedTasks: 0, totalTasks: 0, courses: [], resourceStatusCounts: {} } as LearningStats;
    render(<StatsPage stats={stats} />);
    expect(screen.getByText("诊断得分")).toBeInTheDocument();
    expect(screen.getByText(/仅统计明确标记为真实来源的诊断.*Mock.*来源未知/)).toBeInTheDocument();
    expect(screen.queryByText("诊断前表现")).not.toBeInTheDocument();
  });
});
