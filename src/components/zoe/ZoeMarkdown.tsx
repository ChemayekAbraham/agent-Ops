import React from 'react';
import { cn } from '@/lib/utils';

export interface ZoeMarkdownProps {
  content: string;
  className?: string;
}

function renderInlineFormatting(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={idx} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={idx}
          className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

function parseTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

function isTableSeparatorLine(line: string): boolean {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line.trim());
}

/**
 * Mobile-first Markdown renderer for Zoe answers:
 * - Headings (`###`, `##`, `#`)
 * - Markdown tables (`| Col | Val |`) with horizontal scroll at 360px
 * - Bullet lists (`- ` or `* `) and numbered lists (`1. `)
 * - Bold (`**text**`) and inline code (`` `text` ``)
 * - Minimum `text-xs`, semantic theme tokens, no emojis.
 */
export const ZoeMarkdown: React.FC<ZoeMarkdownProps> = ({ content, className }) => {
  const lines = content.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Markdown table block
    if (
      trimmed.includes('|') &&
      i + 1 < lines.length &&
      isTableSeparatorLine(lines[i + 1])
    ) {
      const headers = parseTableCells(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes('|')) {
        if (!isTableSeparatorLine(lines[i])) {
          rows.push(parseTableCells(lines[i]));
        }
        i += 1;
      }

      blocks.push(
        <div
          key={`table-${i}`}
          data-testid="zoe-markdown-table"
          className="my-2 w-full overflow-x-auto rounded-lg border border-border bg-background"
        >
          <table className="w-full min-w-[280px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/60">
                {headers.map((h, hIdx) => (
                  <th
                    key={hIdx}
                    className="px-2.5 py-2 font-semibold text-foreground whitespace-nowrap"
                  >
                    {renderInlineFormatting(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {rows.map((r, rIdx) => (
                <tr key={rIdx} className="hover:bg-muted/30">
                  {headers.map((_, cIdx) => (
                    <td
                      key={cIdx}
                      className="px-2.5 py-1.5 text-xs text-foreground align-top"
                    >
                      {renderInlineFormatting(r[cIdx] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Headings
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      blocks.push(
        <h3
          key={`h-${i}`}
          data-testid="zoe-markdown-heading"
          className="mt-2 text-xs font-bold uppercase tracking-wide text-foreground sm:text-sm"
        >
          {renderInlineFormatting(headingMatch[2])}
        </h3>,
      );
      i += 1;
      continue;
    }

    // Unordered list block
    if (/^[-*•]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*•]\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ul
          key={`ul-${i}`}
          className="my-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed text-foreground sm:text-sm"
        >
          {items.map((item, idx) => (
            <li key={idx} className="break-words">
              {renderInlineFormatting(item)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list block
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ol
          key={`ol-${i}`}
          className="my-1.5 list-decimal space-y-1 pl-4 text-xs leading-relaxed text-foreground sm:text-sm"
        >
          {items.map((item, idx) => (
            <li key={idx} className="break-words">
              {renderInlineFormatting(item)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph block
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,4})\s+/.test(lines[i].trim()) &&
      !/^[-*•]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !(
        lines[i].trim().includes('|') &&
        i + 1 < lines.length &&
        isTableSeparatorLine(lines[i + 1])
      )
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }

    blocks.push(
      <p
        key={`p-${i}`}
        className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground sm:text-sm"
      >
        {renderInlineFormatting(paraLines.join('\n'))}
      </p>,
    );
  }

  return (
    <div data-testid="zoe-markdown" className={cn('space-y-2', className)}>
      {blocks}
    </div>
  );
};

export default ZoeMarkdown;
