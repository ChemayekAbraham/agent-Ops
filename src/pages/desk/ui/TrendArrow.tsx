import { ArrowDown, ArrowUp } from 'lucide-react';
import { statusText } from '../deskTheme';

/**
 * The river's 24-hour trend, for any figure.
 *
 * On a queue, up is bad (more waiting) so up is red and down green. Pass
 * `upIsGood` for a figure where more is better. No comparison point is its
 * own state — a dash with a tooltip — never a misleading "no change". The
 * direction is always spelled out for a screen reader.
 */
export function TrendArrow({
  change,
  board,
  upIsGood = false,
  unit = '',
}: {
  change: number | null | undefined;
  board: boolean;
  upIsGood?: boolean;
  unit?: string;
}) {
  const size = board ? 'text-sm' : 'text-xs';
  if (change === null || change === undefined || Number.isNaN(Number(change))) {
    return (
      <span className={`${size} text-muted-foreground`} style={{ position: 'relative', flexShrink: 0 }} title="no 24h data yet">
        —<span className="sr-only">no 24 hour data yet</span>
      </span>
    );
  }
  if (change === 0) {
    return (
      <span className={`${size} text-muted-foreground`} style={{ flexShrink: 0 }}>
        no change
      </span>
    );
  }
  const up = change > 0;
  const good = up === upIsGood;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={`${size} font-medium tabular-nums ${good ? statusText.ok : statusText.bad}`}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0, whiteSpace: 'nowrap' }}
      data-trend={up ? 'up' : 'down'}
    >
      <Icon className={board ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden />
      {up ? '+' : '−'}
      {Math.abs(change).toLocaleString('en')}
      {unit}
      <span className="sr-only">{up ? ' more than 24 hours ago' : ' fewer than 24 hours ago'}</span>
    </span>
  );
}
