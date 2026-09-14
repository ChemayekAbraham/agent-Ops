import { useMemo } from 'react';
import { ArrowDownLeft, ArrowUpRight, Clock, Loader2 } from 'lucide-react';
import { useTenantPaymentHistory } from '@/hooks/useTenantPaymentHistory';

export interface PaymentEntry {
  id: string;
  /** 'credit' = money coming in (top-up, refund), 'debit' = money going out (rent payment) */
  type: 'credit' | 'debit';
  amount: number;
  /** Short description, e.g. "Rent payment", "Agent deposit", "Top-up" */
  label: string;
  /** ISO date string */
  date: string;
  /** Optional status */
  status?: 'completed' | 'pending' | 'failed';
}

interface PaymentTimelineProps {
  /** Payment entries to display. When omitted, the tenant's own history is loaded. */
  entries?: PaymentEntry[];
  /** Max entries to show */
  limit?: number;
}

const formatUGX = (n: number) =>
  `UGX ${n.toLocaleString('en-UG', { maximumFractionDigits: 0 })}`;

const relativeTime = (dateStr: string) => {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-UG', { month: 'short', day: 'numeric' });
};

/**
 * Clean, minimal payment timeline — shows recent payment activity
 * as a vertical list with icons, amounts, and relative timestamps.
 *
 * Renders an empty state when no backend data is available yet.
 */
export function PaymentTimeline({ entries = [], limit = 5 }: PaymentTimelineProps) {
  const visible = useMemo(() => entries.slice(0, limit), [entries, limit]);

  if (visible.length === 0) {
    return (
      <div className="rounded-xl border border-border/40 bg-card p-4">
        <p className="text-xs font-bold uppercase tracking-wider text-foreground mb-2">
          Recent Activity
        </p>
        <div className="flex items-center gap-3 py-3">
          <div className="p-2 rounded-full bg-muted">
            <Clock className="h-4 w-4 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">No activity yet</p>
            <p className="text-[11px] text-muted-foreground/60">
              Your payment history will appear here.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/40 bg-card p-4">
      <p className="text-xs font-bold uppercase tracking-wider text-foreground mb-3">
        Recent Activity
      </p>
      <div className="space-y-0">
        {visible.map((entry, i) => (
          <div
            key={entry.id}
            className={`flex items-center gap-3 py-2.5 ${
              i < visible.length - 1 ? 'border-b border-border/20' : ''
            }`}
          >
            {/* Icon */}
            <div className={`p-1.5 rounded-full shrink-0 ${
              entry.type === 'credit' ? 'bg-emerald-100 dark:bg-emerald-950/30' : 'bg-muted'
            }`}>
              {entry.type === 'credit' ? (
                <ArrowDownLeft className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </div>

            {/* Label + time */}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{entry.label}</p>
              <p className="text-[10px] text-muted-foreground">
                {relativeTime(entry.date)}
                {entry.status === 'pending' && (
                  <span className="ml-1.5 text-amber-600 font-medium">· Pending</span>
                )}
                {entry.status === 'failed' && (
                  <span className="ml-1.5 text-destructive font-medium">· Failed</span>
                )}
              </p>
            </div>

            {/* Amount */}
            <p className={`text-sm font-semibold tabular-nums shrink-0 ${
              entry.type === 'credit' ? 'text-emerald-600' : 'text-foreground'
            }`}>
              {entry.type === 'credit' ? '+' : '-'}{formatUGX(entry.amount)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
