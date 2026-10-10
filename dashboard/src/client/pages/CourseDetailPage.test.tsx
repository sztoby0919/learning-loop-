import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import type { CourseDetail, SourceReference } from "../../shared/course.js";
import { CourseDetailPage } from "./CourseDetailPage.js";

const course: CourseDetail = {
  id: "compiler-principles",
  title: "编译原理",
  accent: "#27624B",
  updated: "2026-08-28",
  status: "ready",
  progress: 25,
  completedTasks: 1,
  totalTasks: 4,
  currentStage: "词法分析",
  nextTask: "完成 Lexer",
  mastery: 7,
  overviewMarkdown: "学习从源程序到目标代码的转换。",
  keyPointsMarkdown: "### 正则表达式\n\n$R = a|b$\n\n```text\nRegex -> NFA -> DFA\n```",
  mistakesMarkdown: "- 不要混淆 Token 和 Lexeme。",
  stages: [
    { title: "编译器全景", tasks: [{ text: "区分工具链", completed: true }] },
    { title: "词法分析", tasks: [{ text: "完成 Lexer", completed: false }] },
  ],
  records: [
    { date: "2026-08-28", content: "学习工具链", mastery: 7, difficulty: "错误归属", nextStep: "学习前端" },
  ],
  warnings: [],
  sourcePath: "compiler-principles/course.md",
};

describe("CourseDetailPage", () => {
  it("渲染课程摘要、当前路线、Markdown 公式和学习记录", () => {
    const { container } = render(
      <MemoryRouter>
        <CourseDetailPage course={course} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "编译原理", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getAllByText("完成 Lexer")).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: "区分工具链" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "完成 Lexer" })).not.toBeChecked();
    expect(container.querySelector(".katex")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "学习记录" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "开始诊断" })).toHaveAttribute("href", "/courses/compiler-principles/coach");
    expect(screen.getByRole("link", { name: "查看错题本" })).toHaveAttribute("href", "/courses/compiler-principles/mistakes");
  });

  it("切换课程后不显示前一门课程的缓存来源", () => {
    const staleReference: SourceReference = {
      artifact: "course", headingIndex: 0, heading: "正则表达式", kind: "pdf-page", position: 1,
      sourceUrl: "/api/courses/previous-course/source#page=1", verifiedExcerpt: null, aiDerived: false,
    };
    render(<MemoryRouter><CourseDetailPage course={course} sourceReferences={[staleReference]} /></MemoryRouter>);
    expect(screen.queryByRole("link", { name: /打开原文件/ })).not.toBeInTheDocument();
  });
  it("显示同课程多文件来源卡及文件名，拒绝跨课程来源", () => {
    const source: SourceReference = { artifact: "course", headingIndex: 0, heading: "正则表达式", kind: "pdf-page", position: 2, filename: "lecture.pdf", sourceUrl: "/api/courses/compiler-principles/sources/11111111-1111-4111-8111-111111111111#page=2", verifiedExcerpt: null, aiDerived: false };
    render(<MemoryRouter><CourseDetailPage course={course} sourceReferences={[source]} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: /打开原文件/ })).toHaveAttribute("href", source.sourceUrl);
    expect(screen.getByText("lecture.pdf")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "追加课件" })).toHaveAttribute("href", "/courses/import?append=compiler-principles");
  });
});
