import type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api.js";

const numberedHeading = /^(?:第\s*[一二三四五六七八九十百零〇\d]+\s*[章节篇部]|(?:chapter|unit|section|lesson|part)\s+(?:\d+|[ivxlcdm]+)\b|[一二三四五六七八九十]+[、．.]\s*\S|\d+(?:\.\d+)+[.、．]?\s+\S|\d+[.、．]\s*[^\d\s])/i;
const compact = (text: string) => text.replace(/\s+/g, "");

// Look below a short running header, but never search the entire body for titles.
// Typography is supporting evidence; plain short paragraphs are not headings.
export function inferPdfHeading(items: TextContent["items"], text: string): string | undefined {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 6);
  const plausible = (line: string) => line.length >= 2 && line.length <= 90 && !/[.。！？!?；;]$/.test(line);
  const numbered = lines.filter((line) => plausible(line) && numberedHeading.test(line));

  const usable = items.filter((item): item is TextItem => "str" in item && Boolean(item.str.trim())
    && Number.isFinite(item.height) && item.height > 0 && item.transform[0] > 0
    && Math.abs(item.transform[1]) <= item.transform[0] * 0.03);
  if (!usable.length) return numbered[0];
  const sorted = [...usable].sort((a, b) => a.height - b.height);
  const total = sorted.reduce((sum, item) => sum + item.str.trim().length, 0);
  let weight = 0;
  const bodyHeight = sorted.find((item) => { weight += item.str.trim().length; return weight >= total / 2; })!.height;
  const rows: TextItem[][] = [];
  for (const item of [...usable].sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0].transform[5] - item.transform[5]) <= Math.max(2, bodyHeight * 0.45)) row.push(item);
    else rows.push([item]);
  }
  const prominent = (line: string) => rows.some((row) => {
    const text = row.slice().sort((a, b) => a.transform[4] - b.transform[4]).map((item) => item.str.trim()).join(" ");
    // Match a complete physical line, not same-word fragments elsewhere on the page.
    return compact(text) === compact(line) && row.every((item) => item.height >= bodyHeight * 1.25);
  });
  // Prefer typographic chapter evidence over numbered body instructions.
  return numbered.find(prominent)
    ?? lines.find((line) => plausible(line) && /\p{L}/u.test(line) && prominent(line))
    ?? numbered[0];
}
