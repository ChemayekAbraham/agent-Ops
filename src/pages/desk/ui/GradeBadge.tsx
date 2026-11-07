import { pillLayout } from './layout';

/**
 * The one grade badge: A green, B teal, C amber, D red, N grey "New",
 * X black "Blocked", none grey "Not graded". Used for agent grades and for
 * request grades alike. Colours come from the `.desk-root` grade tokens
 * (`--desk-emerald` …), so light, dark and Board mode all read the same.
 */

export type GradeStyle = { cls: string; text: string; words: string };

const GRADE: Record<string, GradeStyle> = {
  A: { cls: 'bg-[hsl(var(--desk-emerald))] border-[hsl(var(--desk-emerald))] text-[hsl(var(--desk-on-fill))]', text: 'A', words: 'grade A' },
  B: { cls: 'bg-[hsl(var(--desk-teal))] border-[hsl(var(--desk-teal))] text-[hsl(var(--desk-on-fill))]', text: 'B', words: 'grade B' },
  C: { cls: 'bg-[hsl(var(--desk-amber))] border-[hsl(var(--desk-amber))] text-[hsl(var(--desk-on-amber))]', text: 'C', words: 'grade C' },
  D: { cls: 'bg-[hsl(var(--desk-red))] border-[hsl(var(--desk-red))] text-[hsl(var(--desk-on-fill))]', text: 'D', words: 'grade D' },
  N: { cls: 'bg-[hsl(var(--desk-slate)/0.25)] border-[hsl(var(--desk-slate)/0.5)] text-foreground', text: 'New', words: 'new agent, not yet graded' },
  X: { cls: 'bg-[hsl(var(--desk-blocked))] border-[var(--desk-blocked-line)] text-[hsl(var(--desk-on-fill))]', text: 'Blocked', words: 'blocked' },
};

const NONE: GradeStyle = {
  cls: 'bg-[hsl(var(--desk-slate)/0.2)] border-[hsl(var(--desk-slate)/0.4)] text-muted-foreground',
  text: 'Not graded',
  words: 'not graded',
};

/** The style for a grade letter; anything unknown or empty is "Not graded". */
export function gradeStyle(grade: string | null | undefined): GradeStyle {
  const g = (grade ?? '').trim().toUpperCase();
  return (g && GRADE[g]) || NONE;
}

export function GradeBadge({ grade, title }: { grade: string | null | undefined; title?: string }) {
  const b = gradeStyle(grade);
  return (
    <span
      data-grade={(grade ?? '').trim().toUpperCase() || 'none'}
      title={title}
      className={`desk-pill text-[11px] font-semibold leading-5 ${b.cls}`}
      style={{ ...pillLayout(6, 0), lineHeight: '20px' }}
    >
      {b.text}
    </span>
  );
}
