import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { TrendingUp, TrendingDown, Minus, HelpCircle, RefreshCw, ArrowRightLeft } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  useMerchantAgentFloatAllocation,
  type MerchantFloatAllocationRow,
  type MerchantFloatAllocationRecommendation,
} from '@/hooks/useMerchantAgentFloatAllocation';

const RECOMMENDATION_META: Record<
  MerchantFloatAllocationRecommendation,
  { label: string; icon: typeof TrendingUp; badge: string; text: string }
> = {
  increase: { label: 'Increase float', icon: TrendingUp, badge: 'success', text: 'text-emerald-700 dark:text-emerald-400' },
  maintain: { label: 'Maintain', icon: Minus, badge: 'muted', text: 'text-muted-foreground' },
  reduce_or_freeze: { label: 'Reduce / freeze', icon: TrendingDown, badge: 'destructive', text: 'text-red-700 dark:text-red-400' },
  insufficient_data: { label: 'No data yet', icon: HelpCircle, badge: 'outline', text: 'text-muted-foreground' },
};

const GRADE_LABEL: Record<string, string> = {
  healthy: 'Healthy',
  recording_gap: 'Recording gap',
  money_risk: 'Money risk',
  stranded_claims: 'Stranded claims',
  no_payouts: 'No payouts',
};

const GRADE_BADGE: Record<string, string> = {
  healthy: 'success',
  recording_gap: 'warning',
  money_risk: 'destructive',
  stranded_claims: 'destructive',
  no_payouts: 'muted',
};

const WINDOW_OPTIONS = [7, 30, 90] as const;

function RecommendationBadge({ rec }: { rec: MerchantFloatAllocationRecommendation }) {
  const meta = RECOMMENDATION_META[rec];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.badge as any} className="gap-1 whitespace-nowrap">
      <Icon className="h-3 w-3" /> {meta.label}
    </Badge>
  );
}

function AgentRow({ row }: { row: MerchantFloatAllocationRow }) {
  const [showReason, setShowReason] = useState(false);
  return (
    <>
      <tr
        className="hover:bg-muted/30 cursor-pointer border-b border-border last:border-0"
        onClick={() => setShowReason((v) => !v)}
      >
        <td className="py-2.5 pr-3">
          <p className="text-sm font-semibold text-foreground truncate max-w-[180px]">{row.merchantName}</p>
          <p className="text-[11px] text-muted-foreground">{row.merchantPhone || row.label || '—'}</p>
        </td>
        <td className="py-2.5 pr-3">
          <Badge variant={GRADE_BADGE[row.grade] as any} size="sm">{GRADE_LABEL[row.grade] ?? row.grade}</Badge>
        </td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-sm">{row.paid.toLocaleString()}</td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-sm font-medium">{formatUGX(row.totalPaid)}</td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-sm">{formatUGX(row.totalFloatConsumed)}</td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-sm">
          {row.floatTurnover == null ? '—' : `${row.floatTurnover.toFixed(2)}x`}
        </td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-sm">
          {row.pctFullyRecorded == null ? '—' : `${row.pctFullyRecorded.toFixed(0)}%`}
        </td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-sm">
          {row.shortfallCount > 0 ? (
            <span className="text-amber-700 dark:text-amber-400 font-semibold">{row.shortfallCount}</span>
          ) : '0'}
        </td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-sm">
          {row.openDisputes > 0 ? (
            <span className="text-red-700 dark:text-red-400 font-semibold">{row.openDisputes}</span>
          ) : '0'}
        </td>
        <td className="py-2.5 pr-3 text-right">
          <span className="text-sm font-bold tabular-nums">{row.allocationScore.toFixed(0)}</span>
          <span className="text-[10px] text-muted-foreground">/100</span>
        </td>
        <td className="py-2.5 pr-1">
          <RecommendationBadge rec={row.recommendation} />
        </td>
      </tr>
      {showReason && (
        <tr className="border-b border-border last:border-0 bg-muted/20">
          <td colSpan={11} className="px-3 py-2.5 text-xs text-muted-foreground leading-relaxed">
            <span className={cn('font-semibold', RECOMMENDATION_META[row.recommendation].text)}>
              {RECOMMENDATION_META[row.recommendation].label}:
            </span>{' '}
            {row.reason}
            {(row.owedToAgent ?? 0) > 0 && (
              <span className="block mt-1 text-amber-700 dark:text-amber-400">
                Lifetime figure: the company may owe this agent ~{formatUGX(row.owedToAgent ?? 0)} (unconfirmed
                lifetime differential — never used to pay anyone; see Money With Agents for the confirmed debt).
              </span>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Ranks merchant (cash-out) agents on measured withdrawal/payout history so
 * Financial Ops can decide who gets MORE float and who gets LESS.
 *
 * Data sources (all read-only, ledger-backed):
 * - `merchant_payout_success_matrix` — reliability grade, proven from a real
 *   customer wallet debit, not just a request status flag.
 * - `general_ledger` — money actually moved (float consumed, commission,
 *   float delivered), never the cached wallet balance.
 * - `merchant_out_of_pocket_advances` / `merchant_balance_disputes` — risk
 *   signals that cap the score regardless of volume.
 *
 * `compact` shows the top movers only, for the FinOps home page; the full
 * table (same component) is reachable as its own tool.
 */
export function MerchantAgentFloatAllocationPanel({
  compact = false,
  onOpenFull,
}: {
  compact?: boolean;
  onOpenFull?: () => void;
}) {
  const [days, setDays] = useState<number>(30);
  const { data, isLoading, error, dataUpdatedAt } = useMerchantAgentFloatAllocation(days);
  const qc = useQueryClient();

  const rows = data ?? [];
  const withData = rows.filter((r) => r.attempts > 0);
  const increase = withData.filter((r) => r.recommendation === 'increase').sort((a, b) => b.allocationScore - a.allocationScore);
  const reduce = withData.filter((r) => r.recommendation === 'reduce_or_freeze').sort((a, b) => a.allocationScore - b.allocationScore);

  if (error) {
    return (
      <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
        <p className="text-sm font-semibold text-destructive">Float allocation report failed to load</p>
        <p className="text-xs text-muted-foreground mt-1">{(error as Error).message}</p>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-base sm:text-lg font-bold tracking-tight">Merchant Float Allocation</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Who to give more float, who to cut back — based on the last {days} days of withdrawals.
            </p>
          </div>
          <button
            onClick={() => qc.invalidateQueries({ queryKey: ['merchant-agent-float-allocation'] })}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs font-semibold text-primary hover:bg-primary/5 transition-colors shrink-0"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
        {isLoading ? (
          <div className="p-5 text-sm text-muted-foreground">Scoring merchant agents…</div>
        ) : withData.length === 0 ? (
          <div className="p-5 text-sm text-muted-foreground">No merchant agent payouts in the last {days} days.</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-5">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 mb-2 flex items-center gap-1.5">
                <TrendingUp className="h-3.5 w-3.5" /> Give more float ({increase.length})
              </p>
              <ul className="space-y-1.5">
                {increase.slice(0, 3).map((r) => (
                  <li key={r.agentId} className="flex items-center justify-between text-sm">
                    <span className="truncate">{r.merchantName}</span>
                    <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 shrink-0 ml-2">{r.allocationScore.toFixed(0)}</span>
                  </li>
                ))}
                {increase.length === 0 && <li className="text-xs text-muted-foreground">None qualify yet.</li>}
              </ul>
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-red-700 dark:text-red-400 mb-2 flex items-center gap-1.5">
                <TrendingDown className="h-3.5 w-3.5" /> Give less float ({reduce.length})
              </p>
              <ul className="space-y-1.5">
                {reduce.slice(0, 3).map((r) => (
                  <li key={r.agentId} className="flex items-center justify-between text-sm">
                    <span className="truncate">{r.merchantName}</span>
                    <span className="text-xs font-bold text-red-700 dark:text-red-400 shrink-0 ml-2">{r.allocationScore.toFixed(0)}</span>
                  </li>
                ))}
                {reduce.length === 0 && <li className="text-xs text-muted-foreground">None flagged.</li>}
              </ul>
            </div>
          </div>
        )}
        {onOpenFull && (
          <button
            type="button"
            onClick={onOpenFull}
            className="w-full flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-primary border-t border-border hover:bg-primary/5 transition-colors"
          >
            View full report <ArrowRightLeft className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2.5">
            <ArrowRightLeft className="h-6 w-6 text-primary" />
            Merchant Agent Float Allocation
          </h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Every active merchant (cash-out) agent, ranked by measured withdrawal reliability and float
            efficiency — not by request status alone. Use this to decide who gets more float and who gets
            less.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {WINDOW_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={cn(
                'h-8 px-3 rounded-full text-xs font-semibold border transition-colors',
                days === d
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:bg-muted/60',
              )}
            >
              {d}d
            </button>
          ))}
          <button
            onClick={() => qc.invalidateQueries({ queryKey: ['merchant-agent-float-allocation'] })}
            className="h-8 w-8 rounded-full border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground leading-relaxed">
        <strong className="text-foreground">How the score works:</strong> reliability grade (proven customer
        debit + full recording, 50 pts) + settlement cleanliness (25 pts) + debit correctness (15 pts) + float
        turnover in-window (10 pts), minus penalties for unresolved shortfalls and open balance disputes.
        Money figures come from the general ledger, never the cached float balance. A grade of "Money risk" or
        "Stranded claims" caps the recommendation at reduce/freeze regardless of volume.
      </div>

      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Scoring merchant agents…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">No active merchant agents found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-muted/40 border-b border-border">
                <tr className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                  <th className="py-2.5 px-3 font-bold">Agent</th>
                  <th className="py-2.5 px-3 font-bold">Grade</th>
                  <th className="py-2.5 px-3 font-bold text-right">Payouts</th>
                  <th className="py-2.5 px-3 font-bold text-right">Total Paid</th>
                  <th className="py-2.5 px-3 font-bold text-right">Float Consumed</th>
                  <th className="py-2.5 px-3 font-bold text-right">Turnover</th>
                  <th className="py-2.5 px-3 font-bold text-right">Clean %</th>
                  <th className="py-2.5 px-3 font-bold text-right">Shortfalls</th>
                  <th className="py-2.5 px-3 font-bold text-right">Disputes</th>
                  <th className="py-2.5 px-3 font-bold text-right">Score</th>
                  <th className="py-2.5 px-3 font-bold">Recommendation</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <AgentRow key={r.agentId} row={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {dataUpdatedAt > 0 && (
        <p className="text-[11px] text-muted-foreground text-right">
          Updated {new Date(dataUpdatedAt).toLocaleTimeString()} · click a row for the reasoning
        </p>
      )}
    </div>
  );
}
