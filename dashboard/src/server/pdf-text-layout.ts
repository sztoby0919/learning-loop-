import type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api.js";

interface PositionedText { item: TextItem; x: number; y: number; height: number; }

// A conservative reading-order heuristic, not an OCR or table/math recognizer.
export function readPdfPageText(items: TextContent["items"], pageWidth: number) {
  const textItems = items.filter((item): item is TextItem => "str" in item && Boolean(item.str.trim()));
  const legacyText = textItems.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim();
  const usable = textItems.every((item) => item.dir !== "rtl" && item.transform.length >= 6 && item.transform.every(Number.isFinite)
    // The first column is the text baseline. The second may contain italic
    // glyph shear, which is not a rotated line and must not force a fallback.
    && item.transform[0] > 0 && Math.abs(item.transform[1]) <= item.transform[0] * 0.03
    && item.height > 0 && Number.isFinite(item.height) && Number.isFinite(item.width));
  if (!usable || !Number.isFinite(pageWidth) || pageWidth <= 0) return { text: legacyText, hasSideNotes: false, complexLayout: true };
  if (!textItems.length) return { text: "", hasSideNotes: false, complexLayout: false };
  const positioned = textItems.map((item) => ({ item, x: item.transform[4], y: item.transform[5], height: item.height }));
  const heights = [...positioned].sort((a, b) => a.height - b.height);
  const totalWeight = heights.reduce((sum, part) => sum + part.item.str.trim().length, 0);
  let weight = 0;
  const bodyHeight = heights.find((part) => { weight += part.item.str.trim().length; return weight >= totalWeight / 2; })!.height;
  const dominant = positioned.filter((part) => part.height >= bodyHeight * 0.9);
  const left = dominant.reduce((minimum, part) => Math.min(minimum, part.x), Infinity);
  const right = dominant.reduce((maximum, part) => Math.max(maximum, part.x + part.item.width), -Infinity);
  const sideCandidates = positioned.filter((part) => part.height < bodyHeight * 0.85
    && (part.x + part.item.width < left - 2 || part.x > right + 2));
  const hasSideNotes = right - left > pageWidth * 0.45 && sideCandidates.length >= 3
    && sideCandidates.reduce((sum, part) => sum + part.item.str.length, 0) >= 20;
  const sideSet = new Set(hasSideNotes ? sideCandidates : []);
  let separatedRows = 0;

  function lines(parts: PositionedText[]): string {
    const sorted = [...parts].sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: Array<{ y: number; parts: PositionedText[] }> = [];
    for (const part of sorted) {
      const row = rows.at(-1);
      if (row && Math.abs(row.y - part.y) <= Math.max(2, bodyHeight * 0.45)) row.parts.push(part);
      else rows.push({ y: part.y, parts: [part] });
    }
    return rows.map((row, index) => {
      row.parts.sort((a, b) => a.x - b.x);
      if (row.parts.some((part, i) => i > 0 && part.x - (row.parts[i - 1].x + row.parts[i - 1].item.width) > Math.max(bodyHeight * 4, pageWidth * 0.08))) separatedRows += 1;
      const gap = index && rows[index - 1].y - row.y > bodyHeight * 1.8 ? "\n\n" : index ? "\n" : "";
      return gap + row.parts.map((part) => part.item.str.trim()).join(" ");
    }).join("");
  }

  // Preserve all text. Only clearly smaller text outside the main body bounds
  // moves to the end; ambiguous columns stay in row order with a warning.
  const body = lines(positioned.filter((part) => !sideSet.has(part)));
  const sideLeft = lines(sideCandidates.filter((part) => sideSet.has(part) && part.x < left));
  const sideRight = lines(sideCandidates.filter((part) => sideSet.has(part) && part.x > right));
  return { text: [body, sideLeft, sideRight].filter(Boolean).join("\n\n"), hasSideNotes, complexLayout: hasSideNotes || separatedRows >= 2 };
}
