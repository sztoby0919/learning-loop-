import type { PdfQuality } from "../../shared/course-import.js";
import { useState } from "react";

export function ImportQualityReport({ quality, sourceUrl }: { quality?: PdfQuality; sourceUrl?: string }) {
  const [selected, setSelected] = useState<keyof Omit<PdfQuality, "version"> | null>(null);
  const [offset, setOffset] = useState(0);
  if (!quality) return null;
  const categories = [{ key: "noTextPages", label: "无可提取文字" }, { key: "sideNotePages", label: "疑似旁注" }, { key: "complexPages", label: "复杂排版" }] as const;
  const active = categories.find((item) => item.key === selected);
  const pages = selected ? quality[selected] : [];
  return <section className="workspace-panel import-quality"><h3>PDF 提取质量</h3>
    <p>无文字页可能是空白页、图片或扫描内容；旁注和复杂排版提示不代表识别错误。类别可能重叠，请打开原页核对公式与表格。</p>
    <div className="import-actions">{categories.map(({ key, label }) => <button type="button" key={key} aria-pressed={selected === key} onClick={() => { setSelected(key); setOffset(0); }}>{label}（{quality[key].length} 页）</button>)}</div>
    {active && <><div className="import-quality-pages">{pages.slice(offset, offset + 50).map((page) => sourceUrl ? <a key={page} href={`${sourceUrl}#page=${page}`} target="_blank" rel="noopener noreferrer">第 {page} 页</a> : <span key={page}>第 {page} 页（来源不可用）</span>)}</div>
      {!pages.length && <p>这一类别没有提示页。</p>}
      {pages.length > 50 && <div className="import-actions"><button type="button" aria-label={`上一组${active.label}页码`} disabled={offset === 0} onClick={() => setOffset(offset - 50)}>上一组</button><span>{offset + 1}–{Math.min(offset + 50, pages.length)} / {pages.length}</span><button type="button" aria-label={`下一组${active.label}页码`} disabled={offset + 50 >= pages.length} onClick={() => setOffset(offset + 50)}>下一组</button></div>}
    </>}
  </section>;
}
