import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { SourceReference as SourceReferenceData } from "../../shared/course.js";

function textOf(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const value = node as { value?: unknown; children?: unknown[] };
  return typeof value.value === "string" ? value.value : (value.children ?? []).map(textOf).join("");
}

export function SourceReference({ reference }: { reference: SourceReferenceData }) {
  const position = reference.kind === "pdf-page"
    ? `原 PDF 第 ${reference.position} 页`
    : `第 ${reference.position} 段文本（估算位置）`;
  const excerpt = !reference.aiDerived && reference.verifiedExcerpt?.trim();

  return (
    <aside className="source-reference" aria-label={`来源：${reference.heading}`}>
      <span className="source-reference__label">来源</span>
      <span>{position}</span>
      {reference.aiDerived && <span className="source-reference__pending">待核对</span>}
      {excerpt && <p>原文摘录：{excerpt}</p>}
      <a href={reference.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`打开原文件：${reference.heading}`}>打开原文件</a>
    </aside>
  );
}

export function SourcedMarkdown({ markdown, artifact, references }: {
  markdown: string;
  artifact: SourceReferenceData["artifact"];
  references: SourceReferenceData[];
}) {
  const byIndex = new Map(references.filter((reference) => reference.artifact === artifact).map((reference) => [reference.headingIndex, reference]));
  const targetDepth = artifact === "notes" ? 2 : 3;
  const headingIndices = new Map<number, { index: number; text: string }>();
  let index = 0;
  for (const node of unified().use(remarkParse).parse(markdown).children) {
    if (node.type === "heading" && node.depth === targetDepth && node.position?.start.offset !== undefined) {
      headingIndices.set(node.position.start.offset, { index: index++, text: textOf(node).trim() });
    }
  }
  const heading = (level: 2 | 3, children: ReactNode, offset?: number) => {
    const headingInfo = offset === undefined ? undefined : headingIndices.get(offset);
    const candidate = level === targetDepth && headingInfo ? byIndex.get(headingInfo.index) : undefined;
    const reference = candidate?.heading === headingInfo?.text ? candidate : undefined;
    return <>{level === 2 ? <h2>{children}</h2> : <h3>{children}</h3>}{reference && <SourceReference reference={reference} />}</>;
  };

  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}
        components={{ h2: ({ children, node }) => heading(2, children, node?.position?.start.offset), h3: ({ children, node }) => heading(3, children, node?.position?.start.offset) }}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
