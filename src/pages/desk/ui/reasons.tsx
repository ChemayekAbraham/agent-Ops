import { LABEL } from '../deskTheme';

/**
 * Rule codes (AO-6, SC-1, COO-HOLD, …) belong in the Rules panel and a
 * tooltip, not in the sentence someone reads on a row. `plainReason` lifts
 * them out of the text and hands them back separately.
 */

const CODE = /\b(?:[A-Z]{1,5}-(?:\d{1,3}[a-z]?|[A-Z]{2,10}))\b/g;

export function plainReason(text: string | null | undefined): { text: string; codes: string[] } {
  if (!text) return { text: '', codes: [] };
  const codes = Array.from(new Set(text.match(CODE) ?? []));
  const cleaned = text
    .replace(CODE, '')
    .replace(/\(\s*\)/g, '')
    .replace(/^[\s:·,–—-]+/, '')
    .replace(/\s+([:,.;])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const out = cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : '';
  return { text: out, codes };
}

/** A reason line: plain words, the rule codes only in the tooltip. */
export function Reason({ text, className = '' }: { text: string | null | undefined; className?: string }) {
  const r = plainReason(text);
  if (!r.text) return null;
  return (
    <p className={`${LABEL} max-w-4xl ${className}`} title={r.codes.length ? `Rule ${r.codes.join(', ')}` : undefined} data-rules={r.codes.join(' ') || undefined}>
      {r.text}
    </p>
  );
}
