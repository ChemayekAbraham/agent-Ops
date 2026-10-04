import { useState } from 'react';
import { ChevronDown, ChevronUp, History } from 'lucide-react';
import {
  useAgentEligibilityHistory,
  RATING_TONE,
  type EligibilityRating,
} from '@/hooks/useAgentEligibilityHistory';
import { formatUGX } from '@/lib/rentCalculations';

/**
 * Compact per-agent eligibility history strip:
 *   - 14-day rating pill row (most recent on the right)
 *   - Toggle reveals last 30 days as a scrollable list with transitions called out
 */
export function AgentEligibilityHistoryStrip({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useAgentEligibilityHistory(agentId, 30);

  if (isLoading) {
    return (
      <div className="mt-2 text-[10px] text-muted-foreground">
        Loading eligibility history…
      </div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <div className="mt-2 text-[10px] text-muted-foreground italic">
        No eligibility history yet — first snapshot lands tomorrow at 00:30 UTC.
      </div>
    );
  }

  // Build last 14 calendar days (oldest → newest) using the snapshot data
  const byDay = new Map(data.map(r => [r.day, r]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const last14: { day: string; rating: EligibilityRating | null; ratio: number; paid: number; expected: number }[] = [];
  for (let i = 14; i >= 1; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    const row = byDay.get(key);
    last14.push({
      day: key,
      rating: (row?.rating as EligibilityRating) || null,
      ratio: row?.ratio || 0,
      paid: row?.paid || 0,
      expected: row?.expected_daily || 0,
    });
  }

  // Detect transitions for badge
  const sortedAsc = [...data].sort((a, b) => (a.day < b.day ? -1 : 1));
  let transitionCount = 0;
  for (let i = 1; i < sortedAsc.length; i++) {
    if (sortedAsc[i].rating !== sortedAsc[i - 1].rating) transitionCount++;
  }

  return (
    <div className="mt-2 rounded-lg border border-border bg-background/70 p-2">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        className="w-full flex items-center justify-between gap-2 text-[11px] font-semibold"
      >
        <span className="flex items-center gap-1.5 text-foreground">
          <History className="h-3 w-3" />
          Eligibility history · last 14 days
          {transitionCount > 0 && (
            <span className="ml-1 px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-700 text-[9px] font-bold border border-violet-500/30">
              {transitionCount} change{transitionCount === 1 ? '' : 's'}
            </span>
          )}
        </span>
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>

      <div className="flex items-center gap-0.5 mt-2">
        {last14.map((d) => {
          const tone = d.rating ? RATING_TONE[d.rating] : 'bg-muted text-muted-foreground border border-dashed border-border';
          const label = d.day.slice(5); // MM-DD
          const title = d.rating
            ? `${label}: ${d.rating} — ${formatUGX(d.paid)} of ${formatUGX(d.expected)} (${Math.round(d.ratio * 100)}%)`
            : `${label}: no snapshot`;
          return (
            <div
              key={d.day}
              title={title}
              className={`flex-1 h-5 rounded-sm flex items-center justify-center text-[8px] font-bold ${tone}`}
            >
              {d.rating ? d.rating.charAt(0) : '·'}
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-[9px] text-muted-foreground mt-0.5 px-0.5">
        <span>14d ago</span>
        <span>yesterday</span>
      </div>

      {open && (
        <ul className="mt-2 max-h-56 overflow-auto divide-y divide-border rounded-md border border-border">
          {sortedAsc.slice().reverse().map((r, idx, arr) => {
            const prev = arr[idx + 1]; // older day (since reversed)
            const changed = prev && prev.rating !== r.rating;
            return (
              <li key={r.day} className="px-2 py-1.5 flex items-center justify-between gap-2 bg-background">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold text-foreground tabular-nums">{r.day}</div>
                  <div className="text-[10px] text-muted-foreground tabular-nums truncate">
                    {formatUGX(r.paid)} / {formatUGX(r.expected_daily)} · {Math.round(r.ratio * 100)}%
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {changed && (
                    <span className="text-[9px] text-muted-foreground">
                      from <strong className="text-foreground">{prev!.rating}</strong> →
                    </span>
                  )}
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${RATING_TONE[r.rating as EligibilityRating]}`}>
                    {r.rating}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default AgentEligibilityHistoryStrip;