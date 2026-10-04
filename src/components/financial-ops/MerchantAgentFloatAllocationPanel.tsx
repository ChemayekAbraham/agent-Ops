import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  HelpCircle,
  RefreshCw,
  ArrowRightLeft,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  useMerchantAgentFloatAllocation,
  useMerchantFloatAllocationEvidence,
  type MerchantFloatAllocationRow,
  type MerchantFloatAllocationRecommendation,
} from '@/hooks/useMerchantAgentFloatAllocation';
import { MerchantDebtSettlementDialog } from './MerchantDebtSettlementDialog';

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

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background px-2.5 py-2 min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground truncate">{label}</p>
      <p className={cn('text-xs sm:text-sm font-bold tabular-nums mt-0.5 break-words', tone)}>{value}</p>
    </div>
  );
}

/** The exact payout + ledger rows behind an agent's numbers. */
function EvidenceTrail({ agentId, days }: { agentId: string; days: number }) {
  const { data, isLoading, error } = useMerchantFloatAllocationEvidence(agentId, days);

  if (isLoading) return <p className="text-xs text-muted-foreground">Loading evidence trail…</p>;
  if (error) return <p className="text-xs text-destructive">Evidence trail failed: {(error as Error).message}</p>;
  if (!data || data.length === 0)
    return <p className="text-xs text-muted-foreground">No paid payouts in this window.</p>;

  return (
    <div className="rounded-lg border border-border overflow-x-auto">
      <table className="w-full text-left text-[11px]">
        <thead className="bg-muted/50">
          <tr className="text-muted-foreground font-bold uppercase tracking-wide">
            <th className="px-2 py-1.5">Payout</th>
            <th className="px-2 py-1.5">Settlement</th>
            <th className="px-2 py-1.5 text-right">Request</th>
            <th className="px-2 py-1.5 text-right">Customer debit (ledger)</th>
            <th className="px-2 py-1.5 text-right">Float used</th>
            <th className="px-2 py-1.5 text-right">Telecom</th>
            <th className="px-2 py-1.5 text-right">Commission</th>
            <th className="px-2 py-1.5">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {data.map((e) => (
            <tr key={e.withdrawalId} className="border-t border-border">
              <td className="px-2 py-1.5">
                <span className="font-mono">{e.withdrawalId.slice(0, 8)}</span>
                <span className="block text-muted-foreground">
                  {new Date(e.createdAt).toLocaleDateString()} · {e.status}
                </span>
              </td>
              <td className="px-2 py-1.5">{e.settlementState ?? '—'}</td>
              <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{formatUGX(e.requestAmount)}</td>
              <td
                className={cn(
                  'px-2 py-1.5 text-right tabular-nums font-semibold',
                  e.hasDebitLeg ? '' : 'text-red-700 dark:text-red-400',
                )}
              >
                {e.hasDebitLeg ? formatUGX(e.customerDebit) : 'no debit leg'}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">{formatUGX(e.floatPrincipal)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{formatUGX(e.floatTelecom)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{formatUGX(e.commissionAmount)}</td>
              <td className="px-2 py-1.5 whitespace-nowrap">
                <span className={e.hasDebitLeg ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}>debit</span>
                {' · '}
                <span className={e.hasFundingRecord ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>fund</span>
                {' · '}
                <span className={e.hasCommissionAward ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>comm</span>
                <span className="block text-muted-foreground">{e.ledgerLegIds.length} ledger leg(s)</span>
                {e.shortfallAmount > 0 && (
                  <span className="block text-amber-700 dark:text-amber-400">
                    own cash {formatUGX(e.shortfallAmount)} ({e.shortfallKind}/{e.shortfallStatus})
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgentRow({ row, days }: { row: MerchantFloatAllocationRow; days: number }) {
  const [open, setOpen] = useState(false);
  const [settleOpen, setSettleOpen] = useState(false);
  return (
    <>
      <tr
        className="hover:bg-muted/30 cursor-pointer border-b border-border last:border-0"
        onClick={() => setOpen((v) => !v)}
      >
        <td className="py-2.5 pr-3 pl-3">
          <div className="flex items-center gap-1.5">
            {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground truncate max-w-[180px]">{row.merchantName}</p>
              <p className="text-[11px] text-muted-foreground truncate max-w-[180px]">
                {row.merchantPhone || row.label || '—'}
              </p>
            </div>
          </div>
        </td>
        <td className="py-2.5 pr-3">
          <Badge variant={GRADE_BADGE[row.grade] as any} size="sm">{GRADE_LABEL[row.grade] ?? row.grade}</Badge>
        </td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-sm">
          {row.payoutsVerified.toLocaleString()}
          {row.payoutsVerified !== row.paid && (
            <span className="block text-[10px] text-red-700 dark:text-red-400">of {row.paid} claimed</span>
          )}
        </td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-sm font-medium">{formatUGX(row.totalPaid)}</td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-sm">{formatUGX(row.totalFloatConsumed)}</td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-sm">
          {row.floatTurnover == null ? '—' : `${row.floatTurnover.toFixed(2)}x`}
        </td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-sm">
          {row.settlementCleanPct == null ? '—' : `${row.settlementCleanPct.toFixed(0)}%`}
        </td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-sm">
          {row.needsReviewCount > 0 ? (
            <span className="text-amber-700 dark:text-amber-400 font-semibold">{row.needsReviewCount}</span>
          ) : '0'}
        </td>
        <td className="py-2.5 pr-3 text-right tabular-nums text-sm">
          {row.openDisputes > 0 ? (
            <span className="text-red-700 dark:text-red-400 font-semibold">{row.openDisputes}</span>
          ) : '0'}
        </td>
        <td className="py-2.5 pr-3 text-right">
          <Badge variant={row.state === 'OWED' ? 'destructive' : 'muted'} size="sm">{row.state}</Badge>
        </td>
        <td className="py-2.5 pr-3 text-right">
          <span className="text-sm font-bold tabular-nums">{row.allocationScore.toFixed(0)}</span>
          <span className="text-[10px] text-muted-foreground">/100</span>
        </td>
        <td className="py-2.5 pr-3">
          <RecommendationBadge rec={row.recommendation} />
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border last:border-0 bg-muted/20">
          <td colSpan={12} className="px-3 py-3 space-y-3">
            <p className="text-xs leading-relaxed">
              <span className={cn('font-semibold', RECOMMENDATION_META[row.recommendation].text)}>
                {RECOMMENDATION_META[row.recommendation].label}:
              </span>{' '}
              <span className="text-muted-foreground">{row.reason}</span>
            </p>
            {row.blocker && (
              <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {row.blocker}
              </p>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              <Metric label="Payouts (verified / claimed)" value={`${row.payoutsVerified} / ${row.paid}`} />
              <Metric label="Paid out (ledger)" value={formatUGX(row.totalPaid)} />
              <Metric label="Float consumed" value={formatUGX(row.totalFloatConsumed)} />
              <Metric label="Telecom charges" value={formatUGX(row.totalTelecom)} />
              <Metric label={`Commission (${row.commissionAwards} awards)`} value={formatUGX(row.totalCommission)} />
              <Metric label="Float delivered in window" value={formatUGX(row.floatDelivered)} />
              <Metric label="Turnover" value={row.floatTurnover == null ? '—' : `${row.floatTurnover.toFixed(2)}x`} />
              <Metric label="Paid of actioned" value={row.pctPaid == null ? '—' : `${row.pctPaid}%`} />
              <Metric
                label="Customer debited"
                value={row.pctCustomerDebited == null ? '—' : `${row.pctCustomerDebited}%`}
                tone={(row.pctCustomerDebited ?? 100) < 100 ? 'text-red-700 dark:text-red-400' : undefined}
              />
              <Metric label="Fully recorded" value={row.pctFullyRecorded == null ? '—' : `${row.pctFullyRecorded}%`} />
              <Metric
                label="Stranded processing"
                value={String(row.strandedProcessing)}
                tone={row.strandedProcessing > 0 ? 'text-red-700 dark:text-red-400' : undefined}
              />
              <Metric
                label="Settlement clean"
                value={
                  row.settlementCleanPct == null
                    ? '—'
                    : `${row.settlementCleanPct}% (${row.settledCount}/${row.settledCount + row.unsettledCount + row.failedSettlements})`
                }
              />
              <Metric
                label="Failed settlements"
                value={String(row.failedSettlements)}
                tone={row.failedSettlements > 0 ? 'text-red-700 dark:text-red-400' : undefined}
              />
              <Metric
                label="Own-cash under review"
                value={`${row.needsReviewCount} · ${formatUGX(row.needsReviewAmount)}`}
                tone={row.needsReviewCount > 0 ? 'text-amber-700 dark:text-amber-400' : undefined}
              />
              <div className="rounded-lg border border-border bg-background px-2.5 py-2 min-w-0 flex flex-col justify-between gap-1.5">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground truncate">
                    Awaiting reimbursement
                  </p>
                  <p className="text-xs sm:text-sm font-bold tabular-nums mt-0.5">
                    {row.pendingReimbursementCount} · {formatUGX(row.pendingReimbursementAmount)}
                  </p>
                </div>
                {row.pendingReimbursementCount > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[11px] px-2 self-start"
                    onClick={(e) => { e.stopPropagation(); setSettleOpen(true); }}
                  >
                    Settle
                  </Button>
                )}
              </div>
              <Metric label="Available float now" value={formatUGX(row.availableFloat)} />
              <Metric label="Reserved float" value={formatUGX(row.reservedFloat)} />
              <Metric
                label="Net position"
                value={formatUGX(row.netPosition)}
                tone={row.netPosition < 0 ? 'text-red-700 dark:text-red-400' : undefined}
              />
              <Metric label="Owed to agent (own cash)" value={formatUGX(row.outOfPocketOutstanding)} />
              <Metric
                label="Float cache vs ledger"
                value={`${formatUGX(row.floatCache)} / ${formatUGX(row.floatLedger)}`}
                tone={row.floatCache > row.floatLedger ? 'text-amber-700 dark:text-amber-400' : undefined}
              />
              <Metric
                label="Capacity used"
                value={
                  row.capacityUtilizationPct == null
                    ? '—'
                    : `${row.capacityUtilizationPct}% (cap ${row.maxDailyPayouts}/day)`
                }
              />
              <Metric label="Queue now" value={String(row.currentQueueCount ?? 0)} />
              <Metric label="Channels" value={row.channels || '—'} />
              <Metric label="Status" value={row.isOnline ? 'Online' : 'Offline'} />
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground mb-1.5">
                Evidence trail — payouts and their ledger legs (last {days} days)
              </p>
              <EvidenceTrail agentId={row.agentId} days={days} />
            </div>
          </td>
        </tr>
      )}
      <MerchantDebtSettlementDialog
        open={settleOpen}
        onOpenChange={setSettleOpen}
        focusAgentId={row.agentId}
      />
    </>
  );
}

/**
 * Ranks merchant (cash-out) agents on measured withdrawal/payout history so
 * Financial Ops can decide who gets MORE float and who gets LESS.
 *
 * Every money figure is a `general_ledger` leg tied to the payout — never
 * `withdrawal_requests.amount` and never the cached float balance. A payout
 * only counts once a matching customer-debit leg exists, and cached float is
 * clamped to the ledger figure. This is the merchant cash-out domain only; it
 * shares nothing with the tenant rent-collection agent performance report.
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

  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem('finops_merchant_float_allocation_open_v1') === 'true';
    } catch {
      return false;
    }
  });

  const toggleOpen = () => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('finops_merchant_float_allocation_open_v1', String(next));
      } catch { /* noop */ }
      return next;
    });
  };

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
      <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-2xs">
        <button
          type="button"
          onClick={toggleOpen}
          className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-expanded={open}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
              <TrendingUp className="h-4.5 w-4.5 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-bold tracking-tight text-foreground">Merchant Float Allocation</h2>
                {!isLoading && withData.length > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                    {increase.length} to increase · {reduce.length} to cut
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                Who to give more float, who to cut back — based on the last {days} days of withdrawals.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                qc.invalidateQueries({ queryKey: ['merchant-agent-float-allocation'] });
              }}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-semibold text-primary hover:bg-primary/5 transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Refresh</span>
            </button>
            {open ? (
              <ChevronUp className="h-5 w-5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0" />
            )}
          </div>
        </button>
        {open && (
          <div className="border-t border-border">
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
        )}
      </div>
    );
  }

  const onlineCount = rows.filter((r) => r.isOnline).length;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2.5">
            <ArrowRightLeft className="h-6 w-6 text-primary" />
            Merchant Agent Performance & Float Allocation
          </h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Every active merchant (cash-out) agent, ranked by measured withdrawal reliability and float
            efficiency — all money from the general ledger, never a request status or a cached balance. Use
            this to decide who gets more float and who gets less.
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

      {!isLoading && rows.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Metric label="Active desks" value={String(rows.length)} />
          <Metric label="Increase float" value={String(increase.length)} tone="text-emerald-700 dark:text-emerald-400" />
          <Metric label="Reduce / freeze" value={String(reduce.length)} tone="text-red-700 dark:text-red-400" />
          <Metric label="Online now" value={`${onlineCount} / ${rows.length}`} />
        </div>
      )}

      <div className="rounded-xl border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground leading-relaxed">
        <strong className="text-foreground">How the score works:</strong> reliability grade (proven customer
        debit + full recording, 50 pts) + settlement cleanliness (25 pts) + debit correctness (15 pts) + float
        turnover in-window (10 pts), minus penalties for own-cash shortfalls under review, open balance disputes
        and failed settlements. A grade of "Money risk" or "Stranded claims", or an OWED desk with open
        disputes, caps the verdict at reduce/freeze regardless of volume. Click any agent for the metric
        breakdown and the exact payout + ledger rows behind the numbers.
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
                  <th className="py-2.5 px-3 font-bold text-right">Paid out</th>
                  <th className="py-2.5 px-3 font-bold text-right">Float used</th>
                  <th className="py-2.5 px-3 font-bold text-right">Turnover</th>
                  <th className="py-2.5 px-3 font-bold text-right">Clean %</th>
                  <th className="py-2.5 px-3 font-bold text-right">Own cash</th>
                  <th className="py-2.5 px-3 font-bold text-right">Disputes</th>
                  <th className="py-2.5 px-3 font-bold text-right">Position</th>
                  <th className="py-2.5 px-3 font-bold text-right">Score</th>
                  <th className="py-2.5 px-3 font-bold">Recommendation</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <AgentRow key={r.agentId} row={r} days={days} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {dataUpdatedAt > 0 && (
        <p className="text-[11px] text-muted-foreground text-right flex items-center justify-end gap-1.5">
          {onlineCount > 0 ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          Updated {new Date(dataUpdatedAt).toLocaleTimeString()} · click a row for the reasoning and evidence
        </p>
      )}
    </div>
  );
}
