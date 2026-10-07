import type { TextItem } from "pdfjs-dist/types/src/display/api.js";
import { describe, expect, it } from "vitest";
import { inferPdfHeading } from "./pdf-heading.js";

const item = (str: string, height = 12, y = 750): TextItem => ({ str, height, width: str.length * height, dir: "ltr", transform: [height, 0, 0, height, 50, y], fontName: "test", hasEOL: true });

describe("PDF heading hints", () => {
  it("recognizes Chinese unnumbered titles supported by typography", () => {
    const lines = ["南京大学课件", "机器学习概述", "通过数据训练模型，让模型根据新输入生成预测结果。", "练习需要记录输入输出并检查误差。"];
    expect(inferPdfHeading(lines.map((str, i) => item(str, i === 1 ? 24 : 12, 750 - i * 40)), lines.join("\n"))).toBe("机器学习概述");
  });

  it.each(["一、绪论", "第一章 极限", "1.2 导数", "第 2 节 导数"])("recognizes Chinese/decimal heading %s below a header", (title) => {
    expect(inferPdfHeading([], `大学课件\n${title}\n正文说明。`)).toBe(title);
  });

  it("does not infer a chapter from a short paragraph or a large page number", () => {
    expect(inferPdfHeading([item("普通短段落"), item("其他正文说明。")], "普通短段落\n其他正文说明。")).toBeUndefined();
    expect(inferPdfHeading([item("12", 24), item("Some paragraph text here.")], "12\nSome paragraph text here.")).toBeUndefined();
  });
});
