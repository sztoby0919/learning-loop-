// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TextItem } from "pdfjs-dist/types/src/display/api.js";

import { readPdfPageText } from "./pdf-text-layout.js";

const item = (str: string, transform = [12, 0, 0, 12, 50, 750], dir = "ltr"): TextItem => ({ str, transform, dir, width: 100, height: 12, fontName: "test-font", hasEOL: false });

describe("conservative PDF layout", () => {
  it("does not mistake italic glyph shear for rotated text", () => {
    const result = readPdfPageText([
      item("second", [12, 0, 2, 12, 50, 700]),
      item("first", [12, 0, 2, 12, 50, 750]),
    ], 612);
    expect(result.text).toBe("first\n\nsecond");
    expect(result.complexLayout).toBe(false);
  });

  it("keeps rotated text in original stream order and warns instead of inventing its layout", () => {
    const result = readPdfPageText([item("first", [0, 12, -12, 0, 50, 50]), item("second")], 612);
    expect(result).toEqual({ text: "first second", hasSideNotes: false, complexLayout: true });
  });

  it("does not reorder right-to-left text using a left-to-right heuristic", () => {
    const result = readPdfPageText([item("first", undefined, "rtl"), item("second")], 612);
    expect(result.text).toBe("first second");
    expect(result.complexLayout).toBe(true);
  });

  it("preserves mathematical symbols literally without interpreting them", () => {
    const result = readPdfPageText([item("x_i = y^2 + ∑ ?")], 612);
    expect(result.text).toBe("x_i = y^2 + ∑ ?");
    expect(result.text).not.toContain("\\frac");
  });

  it("returns an empty page without labeling it a complex table", () => {
    expect(readPdfPageText([], 612)).toEqual({ text: "", hasSideNotes: false, complexLayout: false });
  });
});
