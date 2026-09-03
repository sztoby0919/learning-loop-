import { describe, expect, it } from "vitest";

import { CourseParseError, parseCourseMarkdown } from "./course-parser.js";

const validCourse = `---
id: compiler-principles
title: 编译原理
accent: "#27624B"
updated: 2026-08-28
---

# 编译原理

## 课程概览

学习编译器各阶段的核心原理。

## 学习路线

### 词法分析
- [x] 理解 token、lexeme 和 pattern
- [ ] 完成词法分析器实验

### 语法分析
- [ ] 计算 FIRST 与 FOLLOW 集

## 关键知识

### Token
词法分析器输出 token 流。

## 易错点

- 混淆 token 与 lexeme。

## 学习记录

| 日期 | 学习内容 | 掌握度 1-10 | 遇到困难 | 下一步 |
| --- | --- | ---: | --- | --- |
| 2026-08-27 | 学习词法分析 | 6 | 区分 token 与 lexeme | 完成练习 |
| 2026-08-28 | 复习正则表达式 | 7 | NFA 转 DFA | 完成实验 |
`;

describe("parseCourseMarkdown", () => {
  it("根据 checkbox 和最新记录生成课程摘要", () => {
    const course = parseCourseMarkdown(validCourse, "compiler-principles/course.md");

    expect(course).toMatchObject({
      id: "compiler-principles",
      title: "编译原理",
      accent: "#27624B",
      updated: "2026-08-28",
      status: "ready",
      completedTasks: 1,
      totalTasks: 3,
      progress: 33,
      currentStage: "词法分析",
      nextTask: "完成词法分析器实验",
      mastery: 7,
    });
    expect(course.stages).toHaveLength(2);
    expect(course.records).toHaveLength(2);
    expect(course.overviewMarkdown).toContain("学习编译器");
    expect(course.keyPointsMarkdown).toContain("### Token");
  });

  it("没有任务和学习记录时返回 null，而不是伪造 0%", () => {
    const empty = validCourse
      .replace(/### 词法分析[\s\S]*?## 关键知识/, "## 关键知识")
      .replace(/\| 2026-08-27[\s\S]*$/, "");

    const course = parseCourseMarkdown(empty, "compiler-principles/course.md");

    expect(course).toMatchObject({
      progress: null,
      totalTasks: 0,
      currentStage: null,
      nextTask: null,
      mastery: null,
    });
  });

  it("全部任务完成时显示完成状态", () => {
    const completed = validCourse.replaceAll("- [ ]", "- [x]");

    const course = parseCourseMarkdown(completed, "compiler-principles/course.md");

    expect(course.progress).toBe(100);
    expect(course.currentStage).toBeNull();
    expect(course.nextTask).toBe("已完成全部计划");
  });

  it("忽略非法掌握度并给出警告", () => {
    const invalidMastery = validCourse.replace("| 2026-08-28 | 复习正则表达式 | 7 |", "| 2026-08-28 | 复习正则表达式 | 12 |");

    const course = parseCourseMarkdown(invalidMastery, "compiler-principles/course.md");

    expect(course.mastery).toBe(6);
    expect(course.warnings).toContain("学习记录 2026-08-28 的掌握度无效");
  });

  it("缺少固定章节时返回带文件路径的解析错误", () => {
    const missingSection = validCourse.replace("## 易错点", "### 易错点");

    expect(() => parseCourseMarkdown(missingSection, "compiler-principles/course.md"))
      .toThrowError(CourseParseError);
    expect(() => parseCourseMarkdown(missingSection, "compiler-principles/course.md"))
      .toThrow("compiler-principles/course.md: 缺少“易错点”二级标题");
  });
});
