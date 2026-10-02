import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SourceReference as SourceReferenceData } from "../../shared/course.js";
import { SourceReference, SourcedMarkdown } from "./SourceReference.js";

const pdf: SourceReferenceData = {
  artifact: "notes", headingIndex: 0, heading: "极限", kind: "pdf-page", position: 7,
  sourceUrl: "/api/courses/limits/source#page=7", verifiedExcerpt: "极限是函数的趋势。", aiDerived: false,
};

describe("SourceReference", () => {
  it("显示可用键盘聚焦的 PDF 原文页链接和已核验摘录", () => {
    render(<SourceReference reference={pdf} />);
    expect(screen.getByText("原 PDF 第 7 页")).toBeInTheDocument();
    expect(screen.getByText("原文摘录：极限是函数的趋势。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开原文件：极限" })).toHaveAttribute("href", "/api/courses/limits/source#page=7");
  });

  it("非 PDF 只显示段文本估算位置，未核验内容不冒充摘录", () => {
    render(<SourceReference reference={{ ...pdf, kind: "virtual-position", position: 3, sourceUrl: "/api/courses/limits/source", verifiedExcerpt: null }} />);
    expect(screen.getByText("第 3 段文本（估算位置）")).toBeInTheDocument();
    expect(screen.queryByText(/原文摘录/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开原文件：极限" })).toHaveAttribute("href", "/api/courses/limits/source");
  });

  it("AI 内容不显示待核对标识，也不冒充已核验原文", () => {
    render(<SourceReference reference={{ ...pdf, aiDerived: true }} />);
    expect(screen.queryByText("待核对")).not.toBeInTheDocument();
    expect(screen.queryByText(/原文摘录/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开原文件：极限" })).toBeInTheDocument();
  });

  it("只在对应标题下显示引用，手工课程没有来源动作", () => {
    const markdown = "# 笔记\n\n## 第一节\n\n内容\n\n## 第二节\n\n更多内容";
    const { rerender } = render(<SourcedMarkdown markdown={markdown} artifact="notes" references={[{ ...pdf, headingIndex: 1, heading: "第二节" }]} />);
    expect(screen.getAllByRole("link", { name: /打开原文件/ })).toHaveLength(1);
    rerender(<SourcedMarkdown markdown={markdown} artifact="notes" references={[]} />);
    expect(screen.queryByRole("link", { name: /打开原文件/ })).not.toBeInTheDocument();
  });

  it("课程关键知识按三级标题索引关联引用", () => {
    render(<SourcedMarkdown markdown={"### 第一章\n\n内容\n\n### 第二章\n\n内容"} artifact="course" references={[{ ...pdf, artifact: "course", headingIndex: 1, heading: "第二章" }]} />);
    expect(screen.getAllByRole("link", { name: /打开原文件/ })).toHaveLength(1);
  });

  it("引用索引忽略引用块内的标题，与服务端的顶层标题计数一致", () => {
    render(<SourcedMarkdown markdown={"> ## 引用中的标题\n\n## 实际标题\n\n正文"} artifact="notes" references={[{ ...pdf, headingIndex: 0, heading: "实际标题" }]} />);
    const heading = screen.getByRole("heading", { name: "实际标题" });
    expect(heading.nextElementSibling).toHaveAttribute("aria-label", "来源：实际标题");
    expect(screen.getByRole("blockquote").querySelector(".source-reference")).toBeNull();
  });

  it("标题已改动时不把旧索引的来源贴到新标题下", () => {
    render(<SourcedMarkdown markdown="## 新标题" artifact="notes" references={[{ ...pdf, headingIndex: 0, heading: "旧标题" }]} />);
    expect(screen.queryByRole("link", { name: /打开原文件/ })).not.toBeInTheDocument();
  });
});
