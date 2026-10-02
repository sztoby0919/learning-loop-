import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ImportQualityReport } from "./ImportQualityReport.js";

describe("PDF quality report", () => {
  it("shows overlapping categories and opens physical source pages", () => {
    render(<ImportQualityReport quality={{ version: 1, noTextPages: [2], sideNotePages: [3], complexPages: [3, 4] }} sourceUrl="/api/course-imports/test/source" />);
    expect(screen.getByText(/可能是空白页、图片或扫描内容/)).toBeInTheDocument();
    expect(screen.getByText("无可提取文字（1 页）")).toBeInTheDocument();
    expect(screen.getByText("疑似旁注（1 页）")).toBeInTheDocument();
    expect(screen.getByText("复杂排版（2 页）")).toBeInTheDocument();
    fireEvent.click(screen.getByText("无可提取文字（1 页）"));
    expect(screen.getByRole("link", { name: "第 2 页" })).toHaveAttribute("href", "/api/course-imports/test/source#page=2");
    expect(screen.getByRole("link", { name: "第 2 页" })).toHaveAttribute("target", "_blank");
  });

  it("bounds long page lists to fifty links at a time", () => {
    render(<ImportQualityReport quality={{ version: 1, noTextPages: [], sideNotePages: [], complexPages: Array.from({ length: 1000 }, (_, i) => i + 1) }} sourceUrl="/source" />);
    fireEvent.click(screen.getByText("复杂排版（1000 页）"));
    expect(screen.getAllByRole("link")).toHaveLength(50);
    expect(screen.getByRole("link", { name: "第 50 页" })).toHaveAttribute("href", "/source#page=50");
    fireEvent.click(screen.getByRole("button", { name: "下一组复杂排版页码" }));
    expect(screen.getByRole("link", { name: "第 51 页" })).toHaveAttribute("href", "/source#page=51");
    expect(screen.queryByRole("link", { name: "第 1 页" })).not.toBeInTheDocument();
  });

  it("does not fabricate a quality report for other formats", () => {
    const { container } = render(<ImportQualityReport sourceUrl="/source" />);
    expect(container).toBeEmptyDOMElement();
  });
});
