import { ReactNode } from 'react';

/**
 * Wraps occurrences of `query` inside `text` with a <mark> tag using
 * design-token-friendly styling. Case-insensitive, safe for regex specials,
 * returns the original string when query is empty or has no match.
 */
export function HighlightText({
  text,
  query,
  className,
}: {
  text: string | null | undefined;
  query: string;
  className?: string;
}): ReactNode {
  const value = text ?? '';
  const q = query.trim();
  if (!q || !value) return value;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = value.split(new RegExp(`(${escaped})`, 'ig'));
  const lowerQ = q.toLowerCase();
  return (
    <>
      {parts.map((part, i) =>
        part && part.toLowerCase() === lowerQ ? (
          <mark
            key={i}
            className={
              className ??
              'rounded-sm bg-amber-200/70 dark:bg-amber-400/30 text-foreground px-0.5'
            }
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}