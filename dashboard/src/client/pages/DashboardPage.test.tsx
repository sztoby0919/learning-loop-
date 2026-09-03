import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import type { CoursesResponse } from "../../shared/course.js";
import { DashboardPage } from "./DashboardPage.js";

const data: CoursesResponse = {
  courses: [
    {
      id: "compiler-principles",
      title: "编译原理",
      accent: "#27624B",
      updated: "2026-08-28",
      status: "ready",
      progress: 40,
      completedTasks: 2,
      totalTasks: 5,
      currentStage: "编译器全景",
      nextTask: "画出编译流程图",
      mastery: null,
    },
    {
      id: "machine-learning",
      title: "机器学习",
      accent: "#8A3634",
      updated: "",
      status: "missing",
      progress: null,
      completedTasks: 0,
      totalTasks: 0,
      currentStage: null,
      nextTask: null,
      mastery: null,
      warning: "未找到 course.md",
    },
    {
      id: "cs336",
      title: "CS336",
      accent: "#247083",
      updated: "2026-08-28",
      status: "ready",
      progress: 20,
      completedTasks: 3,
      totalTasks: 15,
      currentStage: "Tokenization",
      nextTask: "实现 BPE",
      mastery: 7,
    },
  ],
  recentRecords: [
    {
      courseId: "cs336",
      courseTitle: "CS336",
      accent: "#247083",
      date: "2026-08-28",
      content: "复测 target shape 和 vocabulary 边界",
      mastery: 7,
      difficulty: "reshape 的含义",
      nextStep: "学习 byte-level tokenization",
    },
  ],
  warningCount: 1,
};

describe("DashboardPage", () => {
  it("渲染三张可访问课程卡、缺失提示和最近记录", () => {
    render(
      <MemoryRouter>
        <DashboardPage data={data} />
      </MemoryRouter>,
    );

    const courseLinks = screen.getAllByRole("link", { name: /查看.*课程/ });
    expect(courseLinks).toHaveLength(3);
    expect(within(courseLinks[0]).getByText("40%")).toBeInTheDocument();
    expect(screen.getByText("尚未设置学习路线")).toBeInTheDocument();
    expect(screen.getByText("复测 target shape 和 vocabulary 边界")).toBeInTheDocument();
    expect(screen.getByText("学习记录需要检查")).toBeInTheDocument();
  });
});
