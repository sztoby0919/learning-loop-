import { describe, expect, it } from "vitest";
import { calculateLearningActivity } from "./learning-activity.js";

describe("learning activity", () => {
  it("counts only real records in the current Monday-Sunday week", () => {
    const result = calculateLearningActivity(["2026-09-20", "2026-09-21", "2026-09-21", "2026-09-23"], "2026-09-23");
    expect(result.weeklyRecords).toEqual([
      { date: "2026-09-21", count: 2 }, { date: "2026-09-22", count: 0 },
      { date: "2026-09-23", count: 1 }, { date: "2026-09-24", count: 0 },
      { date: "2026-09-25", count: 0 }, { date: "2026-09-26", count: 0 },
      { date: "2026-09-27", count: 0 },
    ]);
    expect(result.streakDays).toBe(1);
  });

  it("counts distinct consecutive study dates, including an unfinished today", () => {
    const result = calculateLearningActivity(["2026-09-20", "2026-09-21", "2026-09-21", "2026-09-22"], "2026-09-23");
    expect(result.streakDays).toBe(3);
  });

  it("shows zero without records rather than invented activity", () => {
    expect(calculateLearningActivity([], "2026-09-23").streakDays).toBe(0);
  });
});
