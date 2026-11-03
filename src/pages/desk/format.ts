export type Fmt = 'int' | 'ugx' | 'ugxfull' | 'pct' | 'days' | 'budget' | 'text' | 'decision' | 'bar';

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

export function fmt(kind: Fmt | undefined, v: unknown): string {
  if (kind === 'budget') return v === null || v === undefined ? 'Not set' : `UGX ${compact.format(Number(v))}`;
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  switch (kind) {
    case 'int': return whole.format(n);
    case 'ugx': return `UGX ${compact.format(n)}`;
    case 'ugxfull':
    case 'bar': return whole.format(n);
    case 'pct': return `${Math.round(n * 100)}%`;
    case 'days': return n.toFixed(1);
    default: return String(v);
  }
}

export type Tone = 'go' | 'wait' | 'stop' | 'plain';

export function decisionTone(s: unknown): Tone {
  const t = String(s ?? '');
  if (/^(Approve to|Approve$|Good|Fund today|Verify to|Forward to COO|Moving|Explained)/.test(t)) return 'go';
  if (/^(Transfer|Pass tenant|Verify now|Blocked|Overdue|Stalled|No reason recorded)/.test(t)) return 'stop';
  if (/^(Return|Hold|Call|Assign|Approve when|Coach|Retry|Pay landlord|Recall|Upload|Attach|Send back|Find the agent|Owner to accept|Verify|Attach proxy|Collect|Match|Pay or|Reason sometimes missing|Decide group)/.test(t)) return 'wait';
  return 'plain';
}

export const toneClass: Record<Tone, string> = {
  go: 'border-emerald-600/40 text-emerald-700 dark:text-emerald-400',
  wait: 'border-amber-600/40 text-amber-800 dark:text-amber-300',
  stop: 'border-red-600/40 text-red-700 dark:text-red-400',
  plain: 'border-border text-foreground',
};
