/**
 * Tenant payment history for the Calling Center details view.
 *
 * Display only. Every figure comes from `useCcTenantPaymentHistory`, which reads
 * the authoritative receipt tables and the plan's own stored balances — nothing
 * is recalculated here and no tenant, payment or accounting data is written.
 */
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Receipt, Wallet, AlertTriangle } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useCcTenantPaymentHistory, type CcTenantReceipt } from '@/hooks/useCcTenantPaymentHistory';

const stamp = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const label = (v?: string | null) => (v ? String(v).replace(/_/g, ' ') : null);

function ReceiptLine({ r, planLabel }: { r: CcTenantReceipt; planLabel: string | null }) {
  return (
    <li className="rounded-lg border border-border/60 bg-background/80 px-2 py-1.5 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <span className="font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{formatUGX(r.amount)}</span>
        <span className="text-muted-foreground tabular-nums">{stamp(r.at)}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-muted-foreground">
        <Badge variant="outline" className="text-[10px] capitalize">
          {r.source === 'agent' ? 'Agent collected' : 'Tenant paid'}
        </Badge>
        {r.method && <span className="capitalize">{label(r.method)}</span>}
        {r.provider && <span className="capitalize">· {label(r.provider)}</span>}
        {r.isPartial && <span className="font-medium text-amber-600 dark:text-amber-400">· Partial</span>}
        {r.expectedAmount !== null && r.expectedAmount > 0 && (
          <span className="tabular-nums">· expected {formatUGX(r.expectedAmount)}</span>
        )}
        {planLabel && <span>· {planLabel}</span>}
      </div>
      {r.reference && <p className="mt-0.5 break-all text-[10px] text-muted-foreground">Ref {r.reference}</p>}
    </li>
  );
}

export function TenantPaymentHistoryPanel({ tenantId, enabled }: { tenantId: string | null; enabled: boolean }) {
  const { data, isLoading, error } = useCcTenantPaymentHistory(tenantId, enabled);
  const [showAll, setShowAll] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-1.5 rounded-xl border border-border/70 bg-card p-2.5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-10 w-full rounded-lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-2.5 text-[11px] text-destructive">
        Payment history could not be loaded. Nothing was changed — try reopening this tenant.
      </div>
    );
  }

  const plans = data?.plans ?? [];
  const receipts = data?.receipts ?? [];
  const attempts = data?.attempts ?? [];
  const s = data?.summary;

  const planLabelOf = (planId: string) => {
    if (plans.length < 2) return null;
    const index = plans.findIndex((p) => p.id === planId);
    return index >= 0 ? `Plan ${plans.length - index}` : null;
  };

  const shown = showAll ? receipts : receipts.slice(0, 6);

  return (
    <div className="space-y-2.5 rounded-xl border border-border/70 bg-card p-2.5">
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
        <Wallet className="h-3.5 w-3.5" />
        Payment position
      </p>

      {/* 1. Summary / current financial position — plan's own stored figures. */}
      {s && plans.length > 0 ? (
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          <div className="rounded-lg bg-muted/50 px-2 py-1.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Paid so far</p>
            <p className="text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
              {formatUGX(s.totalRepaidRecorded)}
            </p>
          </div>
          <div className="rounded-lg bg-muted/50 px-2 py-1.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Still owing</p>
            <p className="text-sm font-bold tabular-nums text-destructive">{formatUGX(s.outstanding)}</p>
          </div>
          <div className="rounded-lg bg-muted/50 px-2 py-1.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Total to repay</p>
            <p className="text-sm font-bold tabular-nums">{formatUGX(s.totalCommitted)}</p>
          </div>
          <div className="rounded-lg bg-muted/50 px-2 py-1.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Last payment</p>
            <p className="text-sm font-bold tabular-nums">
              {s.lastPaymentAmount === null ? '—' : formatUGX(s.lastPaymentAmount)}
            </p>
            <p className="text-[10px] text-muted-foreground">{s.lastPaymentAt ? stamp(s.lastPaymentAt) : 'none yet'}</p>
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">No rent plan is recorded for this tenant.</p>
      )}

      {/* Rent plans, so the officer knows which plan the receipts belong to. */}
      {plans.length > 0 && (
        <ul className="space-y-1.5">
          {plans.map((p, index) => (
            <li key={p.id} className="rounded-lg border border-border/60 px-2 py-1.5 text-[11px]">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="text-[10px]">
                  Plan {plans.length - index}
                </Badge>
                {p.status && <span className="font-semibold capitalize">{label(p.status)}</span>}
                <span className="text-muted-foreground capitalize">{label(p.frequency) || 'daily'}</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatUGX(p.dailyRepayment)} per {p.frequency === 'weekly' ? 'week' : 'day'}
                </span>
              </div>
              <p className="mt-0.5 tabular-nums text-muted-foreground">
                Rent {formatUGX(p.rentAmount)} · repay {formatUGX(p.totalRepayment)} · paid{' '}
                {formatUGX(p.amountRepaid)} · owing {formatUGX(p.outstanding)}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {p.receiptCount} receipt{p.receiptCount === 1 ? '' : 's'} totalling {formatUGX(p.receiptTotal)}
                {p.startedAt ? ` · started ${stamp(p.startedAt)}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}

      {/* 2 + 3. Recent payments, expanding to the complete history. */}
      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
          <Receipt className="h-3.5 w-3.5" />
          {showAll ? 'Complete payment history' : 'Recent payments'}
          {receipts.length > 0 && <span className="tabular-nums">({receipts.length})</span>}
        </p>
        {!receipts.length ? (
          <p className="text-[11px] text-muted-foreground">No payment records found for this tenant.</p>
        ) : (
          <>
            <ul className={`space-y-1.5 ${showAll ? 'max-h-72 overflow-y-auto' : ''}`}>
              {shown.map((r) => (
                <ReceiptLine key={`${r.source}-${r.id}`} r={r} planLabel={planLabelOf(r.planId)} />
              ))}
            </ul>
            {receipts.length > 6 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1 h-7 w-full text-[11px]"
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll ? 'Show recent only' : `Show all ${receipts.length} payments`}
              </Button>
            )}
            {receipts.length > 0 && (
              <p className="mt-1 text-[10px] tabular-nums text-muted-foreground">
                Receipts on record total {formatUGX(data?.summary.receiptTotal ?? 0)}
              </p>
            )}
          </>
        )}
      </div>

      {/* 5. Outstanding / pending items the system already recorded. */}
      {attempts.length > 0 && (
        <div>
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            Recorded payment attempts ({attempts.length})
          </p>
          <ul className="max-h-40 space-y-1.5 overflow-y-auto">
            {attempts.map((a) => (
              <li key={a.id} className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px]">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <span className="font-semibold capitalize">{label(a.outcome) || 'Attempt'}</span>
                  <span className="text-muted-foreground tabular-nums">{stamp(a.at)}</span>
                </div>
                <p className="mt-0.5 tabular-nums text-muted-foreground">
                  Sent {formatUGX(a.depositAmount)} · applied {formatUGX(a.appliedAmount)}
                  {a.surplusAmount > 0 ? ` · surplus ${formatUGX(a.surplusAmount)}` : ''}
                </p>
                {a.reason && <p className="text-[10px] text-muted-foreground">{a.reason}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
