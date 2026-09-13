import { useState } from 'react';
import { Wallet, HandCoins, ArrowRightLeft, AlertTriangle, SlidersHorizontal, ShieldAlert, RefreshCw, Gauge, History } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useMerchantFloatPositions,
  useMerchantFloatLedgerVariance,
  useRecentMerchantFloatMovements,
  MerchantFloatPosition,
} from '@/hooks/useMerchantFloat';
import { MerchantReconcileDialog } from './MerchantReconcileDialog';
import { useFinancialOpsEditAccess } from '@/hooks/useFinancialOpsEditAccess';
import { MerchantFloatStatementDialog } from './MerchantFloatStatementDialog';
import { MerchantOwnMoneyReviewPanel } from './MerchantOwnMoneyReviewPanel';
import { MerchantDebtSettlementDialog } from './MerchantDebtSettlementDialog';
import { useMerchantAgentFloatAllocation } from '@/hooks/useMerchantAgentFloatAllocation';
import { computeMerchantCapacities, capacityLabel } from '@/lib/merchantFloatCapacity';
import { MerchantCapacityHistoryDialog } from './MerchantCapacityHistoryDialog';
import { MerchantCapacityOverrideDialog } from './MerchantCapacityOverrideDialog';
import { MerchantCapacityBulkOverrideDialog } from './MerchantCapacityBulkOverrideDialog';
import {
  useMerchantCapacityOverrides,
  activeOverrideMap,
} from '@/hooks/useMerchantCapacityOverrides';


/**
 * Money With Agents — shows how much company money is still sitting with each
 * agent, and how much the company still owes each agent.
 *
 * Left side: what the agent actually paid out from their own phone (mobile money
 * cash-outs we can see). Right side: the real money Finance sent them, confirmed
 * from MTN/Airtel payment emails. If the agent paid out more than we sent them,
 * we owe them. If we sent them more than they paid out, they are holding our
 * cash.
 *
 * Read-only. Paying back still runs through the existing float path.
 */
export function MoneyWithAgentsCard({ onOpenTimeline }: { onOpenTimeline?: () => void }) {
  const { data, isLoading, error } = useMerchantFloatPositions();
  const { data: variance } = useMerchantFloatLedgerVariance();
  const [reconciling, setReconciling] = useState<MerchantFloatPosition | null>(null);
  const [statementFor, setStatementFor] = useState<MerchantFloatPosition | null>(null);
  const qc = useQueryClient();
  const [sweeping, setSweeping] = useState(false);
  const [debtsOpen, setDebtsOpen] = useState(false);
  const { canEdit: canEditFloat, readOnlyReason } = useFinancialOpsEditAccess();

  // Performance-based capacity: ledger-verified payout record per merchant desk.
  const [capacityWindow, setCapacityWindow] = useState(30);
  const [potInput, setPotInput] = useState('');
  const { data: performance, isLoading: perfLoading } = useMerchantAgentFloatAllocation(capacityWindow);
  const [historyFor, setHistoryFor] = useState<{ agentId: string; name: string } | null>(null);
  const [overrideFor, setOverrideFor] = useState<{ agentId: string; name: string } | null>(null);
  const [bulkOverrideOpen, setBulkOverrideOpen] = useState(false);
  // Temporary admin overrides on qualified capacity (recommendation only).
  const { data: overrideRows } = useMerchantCapacityOverrides(200);


  // Payout float guard repair: any payout that completed WITHOUT a float debit
  // (older paths, failed reservation) gets its company-float deduction posted
  // now, so this card keeps falling as merchants complete payouts.
  const runFloatSweep = async () => {
    setSweeping(true);
    try {
      const { data: res, error: err } = await supabase.rpc('sweep_merchant_payout_float_debits' as any, {
        p_days: 7,
        p_dry_run: false,
      });
      if (err) throw err;
      const debited = Number((res as any)?.float_debited_total ?? 0);
      const n = Number((res as any)?.candidates ?? 0);
      toast.success(
        n === 0
          ? 'All completed payouts already deducted from float'
          : `Deducted ${formatUGX(debited)} across ${n} payout${n === 1 ? '' : 's'}`,
      );
      qc.invalidateQueries({ queryKey: ['merchant-float-positions'] });
      qc.invalidateQueries({ queryKey: ['merchant-float-ledger-variance'] });
      qc.invalidateQueries({ queryKey: ['merchant-payout-float'] });
    } catch (e: any) {
      toast.error(e?.message || 'Float repair failed');
    } finally {
      setSweeping(false);
    }
  };

  // The cached float on `wallets` can drift above what the ledger actually
  // proves. Finance must see the SPENDABLE figure, so the cache is only ever
  // allowed to reduce it — never inflate it (same strict rule as withdrawable).
  const varianceByDesk = new Map((variance ?? []).map((v) => [v.deskId, v]));
  const spendableFloat = (r: MerchantFloatPosition) => {
    const v = varianceByDesk.get(r.deskId);
    const cached = Math.max(0, r.ledgerFloatHeld);
    if (!v) return cached;
    return Math.max(0, Math.min(cached, Math.max(0, v.ledgerFloat)));
  };

  // Headline truth: only float with independent provider corroboration counts.
  // Cache-clamp artifacts and internally asserted amounts are reported
  // separately below instead of being presented as money anyone can spend.
  const excludedFloat = (r: MerchantFloatPosition) =>
    Math.max(0, r.clampArtifactAmount) + Math.max(0, r.assertedOnlyAmount);
  const isUnverified = (r: MerchantFloatPosition) => r.evidenceStatus !== 'evidenced';
  const evidenceLabel = (r: MerchantFloatPosition) =>
    r.evidenceStatus === 'mixed'
      ? 'partly unverified'
      : r.evidenceStatus === 'clamp_artifact'
        ? 'cache exceeds the books'
        : r.evidenceStatus === 'asserted_only'
          ? 'no independent evidence'
          : 'evidenced';

  // ONLY active merchant / cash-out desks belong on this board. A deactivated
  // desk is not part of the payout roster, so its historical movements must not
  // appear here (or in any total) even when it still has residual figures.
  const visible = (data ?? []).filter((r) => r.isActive);

  // Up to two most recent movements on each agent's attached mobile money line —
  // display + sort key only, never used to compute any balance on this board.
  const { data: recentMovements } = useRecentMerchantFloatMovements(
    visible.map((r) => r.agentId).filter((id): id is string => !!id),
  );

  const movementsFor = (r: MerchantFloatPosition) =>
    (r.agentId ? recentMovements?.get(r.agentId) : undefined) ?? [];
  const latestMovementAt = (r: MerchantFloatPosition) => movementsFor(r)[0]?.date ?? null;

  const rows = visible
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ta = latestMovementAt(a.r) ? new Date(latestMovementAt(a.r)!).getTime() : null;
      const tb = latestMovementAt(b.r) ? new Date(latestMovementAt(b.r)!).getTime() : null;
      if (ta === null && tb === null) return a.i - b.i;
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    })
    .map((x) => x.r);
  // Company cash still parked on agents' phones = money we sent them that they
  // have NOT paid out yet. This is a different measure from spendable float
  // (`evidencedAmount`), so it must never be computed from the same figure —
  // doing so made both headline cards show the identical number.
  const heldTotal = rows.reduce((s, r) => s + Math.max(0, r.companyCashWithAgent), 0);
  const owedTotal = rows.reduce((s, r) => s + r.owedToAgent, 0);
  // Filed but unattested own-money claims. Deliberately NOT folded into
  // `owedTotal` — that figure feeds settlement and stays confirmed-only. Shown
  // separately because a desk can read 0 owed while carrying millions: a
  // merchant who funds a payout entirely from their own pocket sits here until
  // they attest, which is how a full day of payouts could show as no debt.
  const underReviewTotal = rows.reduce((s, r) => s + r.ownCashUnderReview, 0);
  const underReviewDesks = rows.filter((r) => r.ownCashUnderReview > 0).length;
  const floatTotal = rows.reduce((s, r) => s + Math.max(0, r.evidencedAmount), 0);
  const excludedRows = rows.filter((r) => excludedFloat(r) > 0);
  const excludedTotal = excludedRows.reduce((s, r) => s + excludedFloat(r), 0);
  const deficitRows = rows.filter((r) => r.clampedShortfall > 0);
  const deficitTotal = deficitRows.reduce((s, r) => s + r.clampedShortfall, 0);

  // Recommended daily capacity per desk, plus how an entered distribution pot
  // should be split across them. Recommendation only — moves no money.
  const activeAgentIds = new Set(rows.map((r) => r.agentId).filter(Boolean) as string[]);
  const perfRows = (performance ?? []).filter((p) => activeAgentIds.has(p.agentId));
  const pot = Number((potInput || '').replace(/[^\d.]/g, ''));
  const overridesByAgent = activeOverrideMap(overrideRows);
  const capacities = computeMerchantCapacities(perfRows, pot, overridesByAgent);
  const capacityFor = (agentId: string | null | undefined) =>
    agentId ? capacities.get(agentId) : undefined;
  const perfRowFor = (agentId: string | null | undefined) =>
    agentId ? perfRows.find((p) => p.agentId === agentId) : undefined;
  const capacityTotal = Array.from(capacities.values()).reduce((s, c) => s + c.earnedCapacity, 0);
  const allocatedTotal = Array.from(capacities.values()).reduce(
    (s, c) => s + c.suggestedAllocation,
    0,
  );
  const eligibleDesks = Array.from(capacities.values()).filter((c) => c.earnedCapacity > 0).length;



  return (
    <div className="rounded-2xl border border-border bg-card p-5 sm:p-6 min-w-0 shadow-2xs">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-10 w-10 rounded-xl bg-amber-500/15 border border-amber-500/25 flex items-center justify-center shrink-0">
            <HandCoins className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground truncate">
                Money With Merchant Agents
              </p>
              <span className="hidden sm:inline-flex items-center rounded-md bg-amber-500/10 border border-amber-500/25 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                Float Reconciliation
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Our cash sitting on their phones vs money they already spent for us
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={runFloatSweep}
            disabled={sweeping}
            className="text-[11px] font-medium text-muted-foreground hover:text-foreground hover:underline flex items-center gap-1 disabled:opacity-50"
            title="Post the company-float deduction for any payout that completed without one (last 7 days)"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${sweeping ? 'animate-spin' : ''}`} />
            {sweeping ? 'Repairing…' : 'Repair payout deductions'}
          </button>
          {onOpenTimeline && (
            <button
              type="button"
              onClick={onOpenTimeline}
              className="text-[11px] font-medium text-primary hover:underline flex items-center gap-1"
            >
              <ArrowRightLeft className="h-3.5 w-3.5" /> Settlement timeline
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Float they can spend now
          </p>
          <p className="mt-1 font-mono text-xl font-bold tabular-nums text-primary break-all">
            {isLoading ? '—' : formatUGX(floatTotal)}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            Only float backed by a matching MTN/Airtel record. Unverified amounts are listed
            separately below and are not counted here.
          </p>
        </div>
        <div className="rounded-xl border border-warning/30 bg-warning/5 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Our cash still on their phones
          </p>
          <p className="mt-1 font-mono text-xl font-bold tabular-nums text-warning break-all">
            {isLoading ? '—' : formatUGX(heldTotal)}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            Money we sent them that they have not used yet — evidenced portion only
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDebtsOpen(true)}
          className="rounded-xl border border-border bg-muted/30 p-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/60"
          title="See what each agent is owed, the transactions behind it, and download a settlement PDF"
        >
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Money we must send back to them
          </p>
          <p className="mt-1 font-mono text-xl font-bold tabular-nums text-foreground break-all">
            {isLoading ? '—' : formatUGX(owedTotal)}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            They used their own phone money to pay our customers. We have not refunded them yet.
          </p>
          {!isLoading && underReviewTotal > 0 && (
            <p className="mt-1 text-[10px] font-semibold text-warning">
              + {formatUGX(underReviewTotal)} filed but not supported by the books across{' '}
              {underReviewDesks} {underReviewDesks === 1 ? 'desk' : 'desks'} — not payable
            </p>
          )}
          <p className="mt-1 text-[10px] font-medium text-primary">
            Tap for the per-agent settlement schedule →
          </p>
        </button>
      </div>

      {deficitTotal > 0 && (
        <div className="mt-4 rounded-2xl border-2 border-dashed border-destructive/60 bg-destructive/10 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-destructive">
                Hidden deficit across desks
              </p>
              <p className="mt-1 font-mono text-lg font-bold tabular-nums text-destructive">
                {formatUGX(deficitTotal)}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {deficitRows.length} desk{deficitRows.length === 1 ? '' : 's'} true position is negative by this amount — it can't show as a negative number, but this is real, not spendable float.
              </p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-border bg-muted/30 p-3">
          <AlertTriangle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-[11px] text-muted-foreground">
            {/(not authorized|forbidden|permission)/i.test(
              (error as { message?: string })?.message ?? '',
            )
              ? 'This board is only visible to finance roles.'
              : `This board could not load: ${
                  (error as { message?: string })?.message ?? 'unknown error'
                }`}
          </p>
        </div>
      )}

      {!error && (
        <div className="mt-4 border-t border-border pt-3 space-y-2">
          {isLoading && <p className="text-xs text-muted-foreground">Loading merchant positions…</p>}
          {!isLoading && rows.length === 0 && (
            <p className="text-xs text-muted-foreground">No merchant activity in the current window.</p>
          )}

          {rows.length > 0 && (
            <div className="rounded-xl border border-primary/25 bg-primary/[0.04] p-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Plan today's distribution
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Enter the total you want to send out today. Each agent's share is worked out
                    from their own verified payout record — not shared out equally.
                  </p>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Amount to distribute (UGX)
                    </span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={potInput}
                      onChange={(e) => setPotInput(e.target.value)}
                      placeholder="e.g. 5000000"
                      className="h-9 w-40 rounded-lg border border-border bg-background px-2 font-mono text-sm tabular-nums outline-none focus:border-primary"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Record window
                    </span>
                    <select
                      value={capacityWindow}
                      onChange={(e) => setCapacityWindow(Number(e.target.value))}
                      className="h-9 rounded-lg border border-border bg-background px-2 text-xs outline-none focus:border-primary"
                    >
                      <option value={7}>Last 7 days</option>
                      <option value={14}>Last 14 days</option>
                      <option value={30}>Last 30 days</option>
                      <option value={90}>Last 90 days</option>
                    </select>
                  </label>
                  {potInput && (
                    <button
                      type="button"
                      onClick={() => setPotInput('')}
                      className="h-9 rounded-lg border border-border px-3 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                    >
                      Clear
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setBulkOverrideOpen(true)}
                    className="h-9 rounded-lg border border-border px-3 text-[11px] font-semibold text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                    title="Adjust several desks' qualified capacity in one action (one reason, per-desk durations)"
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" /> Bulk adjust capacity
                  </button>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Earned capacity today
                  </p>
                  <p className="font-mono text-sm font-bold tabular-nums text-primary">
                    {perfLoading ? '—' : formatUGX(capacityTotal)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    across {eligibleDesks} qualifying desk{eligibleDesks === 1 ? '' : 's'}
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Recommended split
                  </p>
                  <p className="font-mono text-sm font-bold tabular-nums text-foreground">
                    {pot > 0 ? formatUGX(allocatedTotal) : '—'}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {pot > 0
                      ? `of ${formatUGX(pot)} entered`
                      : 'enter an amount to see each agent\u2019s share'}
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Already with them
                  </p>
                  <p className="font-mono text-sm font-bold tabular-nums text-warning">
                    {isLoading ? '—' : formatUGX(floatTotal)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    spendable float still on their phones
                  </p>
                </div>
              </div>
              {pot > 0 && capacityTotal === 0 && (
                <p className="mt-2 text-[10px] font-medium text-destructive">
                  No desk currently qualifies on record, so nothing can be recommended.
                </p>
              )}
            </div>
          )}

          {(rows.length > 0 || isLoading) && (

            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <p className="text-[10px] text-muted-foreground">
                Total float with merchant agents (evidenced only)
              </p>
              <p
                className={`font-mono text-base font-extrabold tabular-nums text-right ${
                  floatTotal > 0 ? 'text-warning' : floatTotal < 0 ? 'text-destructive' : 'text-foreground'
                }`}
              >
                {isLoading ? '—' : formatUGX(floatTotal)}
              </p>
            </div>
          )}
          {rows.map((r) => {
            const holding = r.companyCashWithAgent > 0;
            // An unattested own-money claim is still outstanding, so a desk
            // carrying one is never "settled" no matter what the payable says.
            const settled = !holding && r.owedToAgent <= 0 && r.ownCashUnderReview <= 0;
            const movements = movementsFor(r);
            const latestAt = latestMovementAt(r);
            const booksProveLess = spendableFloat(r) < Math.max(0, r.ledgerFloatHeld);
            const cap = capacityFor(r.agentId);
            return (
              <div
                key={r.deskId}
                className={`flex flex-col sm:flex-row sm:items-start justify-between gap-3 rounded-xl border bg-background p-3 sm:px-3.5 sm:py-2.5 min-w-0 shadow-2xs ${
                  isUnverified(r) ? 'border-dashed border-destructive/40' : 'border-border'
                }`}
              >
                <div className="min-w-0 flex-1 text-left">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setStatementFor(r)}
                      className="text-sm font-bold text-foreground truncate hover:text-primary hover:underline text-left"
                    >
                      {r.agentName || r.label || 'Merchant agent'}
                    </button>
                    {/* Mobile balance indicator displayed inline with name */}
                    <p
                      className={`sm:hidden font-mono text-sm font-bold tabular-nums shrink-0 whitespace-nowrap ${
                        isUnverified(r)
                          ? 'text-muted-foreground'
                          : spendableFloat(r) > 0
                            ? 'text-warning'
                            : 'text-foreground'
                      }`}
                    >
                      {formatUGX(spendableFloat(r))}
                    </p>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      disabled={!r.agentId}
                      onClick={() =>
                        r.agentId &&
                        setHistoryFor({
                          agentId: r.agentId,
                          name: r.agentName || r.label || 'Merchant agent',
                        })
                      }
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition hover:brightness-110 disabled:cursor-default ${
                        !cap || cap.earnedCapacity === 0
                          ? 'border-destructive/40 bg-destructive/10 text-destructive'
                          : 'border-primary/40 bg-primary/10 text-primary'
                      }`}
                      title={
                        cap?.blocker
                          ? cap.blocker
                          : `${cap?.reason || 'No verified payout record yet'} — tap for capacity history`
                      }
                    >
                      <Gauge className="h-2.5 w-2.5" />
                      qualifies {perfLoading ? '…' : formatUGX(cap?.earnedCapacity ?? 0)}/day
                      <History className="h-2.5 w-2.5 opacity-70" />
                    </button>
                    {cap?.override && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-warning"
                        title={`Override by ${cap.override.setBy || 'Financial Ops'} — ${cap.override.reason}`}
                      >
                        override · earned {formatUGX(cap.performanceCapacity)}
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={!r.agentId}
                      onClick={() =>
                        r.agentId &&
                        setOverrideFor({
                          agentId: r.agentId,
                          name: r.agentName || r.label || 'Merchant agent',
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground disabled:cursor-default"
                      title="Temporarily adjust this desk's qualified capacity (reason required)"
                    >
                      <SlidersHorizontal className="h-2.5 w-2.5" /> adjust
                    </button>
                    {pot > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-success">
                        send {formatUGX(cap?.suggestedAllocation ?? 0)}
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {capacityLabel(cap)}
                    {cap && cap.earnedCapacity > 0
                      ? ` · avg ${formatUGX(Math.round(cap.dailyThroughput))}/day paid out`
                      : ''}
                  </p>
                  {isUnverified(r) && (
                    <span className="mt-0.5 inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-destructive">
                      <ShieldAlert className="h-2.5 w-2.5" /> {evidenceLabel(r)}
                    </span>
                  )}

                  <div className="mt-1.5 space-y-0.5">
                    {movements.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground">No float movements</p>
                    ) : (
                      movements.map((m, idx) => (
                        <p
                          key={`${m.agentId}-${m.date}-${idx}`}
                          className={`text-[11px] font-semibold tabular-nums text-left whitespace-nowrap ${
                            m.direction === 'cash_in' ? 'text-success' : 'text-destructive'
                          }`}
                        >
                          {m.direction === 'cash_in' ? '+' : '−'}
                          {formatUGX(m.amount)}
                          <span className="ml-1 font-normal text-muted-foreground">
                            {format(new Date(m.date), 'd MMM')}
                          </span>
                        </p>
                      ))
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate text-left mt-1">
                    {r.agentPhone || '—'} · they paid out {formatUGX(r.paidOut)} · we paid them back {formatUGX(r.reimbursed)}
                  </p>
                </div>
                <div className="text-left sm:text-right shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-border/40">
                  <p
                    className={`hidden sm:block font-mono text-sm font-bold tabular-nums whitespace-nowrap ${
                      isUnverified(r)
                        ? 'text-muted-foreground'
                        : spendableFloat(r) > 0
                          ? 'text-warning'
                          : 'text-foreground'
                    }`}
                  >
                    {formatUGX(spendableFloat(r))}
                  </p>
                  {isUnverified(r) && (
                    <p className="text-[10px] text-destructive whitespace-nowrap">
                      {formatUGX(excludedFloat(r))} not counted as float
                    </p>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    {spendableFloat(r) > 0
                      ? 'float balance on their phone'
                      : holding
                        ? 'our money still on their phone'
                        : settled
                          ? 'nothing outstanding either way'
                          : 'we must send this back to them'}
                  </p>
                  {latestAt && (
                    <p className="text-[10px] text-muted-foreground">
                      last movement {format(new Date(latestAt), 'd MMM yyyy · HH:mm')}
                    </p>
                  )}
                  {booksProveLess && (
                    <p className="text-[10px] text-muted-foreground">
                      (shown on their phone {formatUGX(Math.max(0, r.ledgerFloatHeld))} — books prove less)
                    </p>
                  )}
                  {r.clampedShortfall > 0 && (
                    <p className="text-[10px] font-semibold text-destructive">
                      hides a UGX {formatUGX(r.clampedShortfall)} deficit
                    </p>
                  )}
                  {r.ownCashUnderReview > 0 && (
                    <p className="text-[10px] font-semibold text-warning">
                      {formatUGX(r.ownCashUnderReview)} of their own money filed but not supported by
                      the books — not payable
                    </p>
                  )}
                  {canEditFloat ? (
                    <button
                      type="button"
                      onClick={() => setReconciling(r)}
                      className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
                    >
                      <SlidersHorizontal className="h-3 w-3" /> Fix balance
                    </button>
                  ) : (
                    <p className="mt-1 text-[10px] text-muted-foreground">{readOnlyReason}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!error && excludedRows.length > 0 && (
        <div className="mt-4 rounded-xl border-2 border-dashed border-destructive/40 bg-destructive/5 p-3">
          <div className="flex items-start gap-2">
            <ShieldAlert className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-destructive">
                Unverified — excluded from float
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {formatUGX(excludedTotal)} shown on merchant desks that the books do not support.
                Not spendable, not owed, and not included in any figure above. Under investigation.
              </p>
            </div>
          </div>
          <div className="mt-2 space-y-1.5">
            {excludedRows.map((r) => (
              <div
                key={`excluded-${r.deskId}`}
                className="rounded-lg border border-destructive/20 bg-background px-3 py-2 min-w-0"
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <p className="text-xs font-medium text-foreground truncate min-w-0">
                    {r.agentName || r.label || 'Merchant agent'}
                  </p>
                  <p className="font-mono text-xs font-bold tabular-nums text-destructive shrink-0">
                    {formatUGX(excludedFloat(r))}
                  </p>
                </div>
                {r.clampArtifactAmount > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {formatUGX(r.clampArtifactAmount)} — cache exceeds what the ledger supports
                  </p>
                )}
                {r.assertedOnlyAmount > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {formatUGX(r.assertedOnlyAmount)} — no independent evidence found
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!error && deficitRows.length > 0 && (
        <div className="mt-4 rounded-xl border-2 border-dashed border-destructive/40 bg-destructive/5 p-3">
          <div className="flex items-start gap-2">
            <ShieldAlert className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-destructive">
                Hidden deficit — the zero floor is hiding a shortfall
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {formatUGX(deficitTotal)} across {deficitRows.length} desk
                {deficitRows.length === 1 ? '' : 's'}. These agents have paid out more than they were
                ever credited — the true position is negative, but the board can never display less
                than UGX 0. This is money owed TO the company, not float.
              </p>
            </div>
          </div>
          <div className="mt-2 space-y-1.5">
            {deficitRows.map((r) => (
              <div
                key={`deficit-${r.deskId}`}
                className="rounded-lg border border-destructive/20 bg-background px-3 py-2 min-w-0"
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <p className="text-xs font-medium text-foreground truncate min-w-0">
                    {r.agentName || r.label || 'Merchant agent'}
                  </p>
                  <p className="font-mono text-xs font-bold tabular-nums text-destructive shrink-0">
                    −{formatUGX(r.clampedShortfall)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 rounded-xl bg-primary/5 border border-primary/10 p-3 flex gap-2">
        <Wallet className="h-4 w-4 text-primary shrink-0 mt-0.5" />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          A merchant agent can only ask for a refund of money they have already sent out from their
          own phone. We refund it only after we see the MTN or Airtel message proving what they
          paid. If the two figures do not match, the gap must be corrected with a written reason.
        </p>
      </div>

      <div className="mt-2 rounded-xl bg-warning/5 border border-warning/20 p-3 flex gap-2">
        <ArrowRightLeft className="h-4 w-4 text-warning shrink-0 mt-0.5" />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground">How to pay them:</span> send the money to
          the merchant agent's float number using MTN or Airtel only. The MTN/Airtel confirmation
          message is read automatically and the real money on our side goes down on its own — never
          adjust these figures by hand. Financial Ops pays merchant agents only, never customers:
          customer withdrawal requests are claimed and paid out by merchant agents.
        </p>
      </div>

      <MerchantReconcileDialog
        position={reconciling}
        open={!!reconciling}
        onOpenChange={(v) => !v && setReconciling(null)}
      />

      <MerchantFloatStatementDialog
        position={statementFor}
        open={!!statementFor}
        onOpenChange={(v) => !v && setStatementFor(null)}
      />

      <MerchantDebtSettlementDialog
        open={debtsOpen}
        onOpenChange={setDebtsOpen}
        headlineOwed={owedTotal}
      />

      <MerchantCapacityHistoryDialog
        open={!!historyFor}
        onOpenChange={(v) => !v && setHistoryFor(null)}
        agentId={historyFor?.agentId ?? null}
        agentName={historyFor?.name ?? 'Merchant agent'}
        performance={perfRowFor(historyFor?.agentId)}
      />

      <MerchantCapacityOverrideDialog
        open={!!overrideFor}
        onOpenChange={(v) => !v && setOverrideFor(null)}
        agentId={overrideFor?.agentId ?? null}
        agentName={overrideFor?.name ?? 'Merchant agent'}
        earnedCapacity={capacityFor(overrideFor?.agentId)?.performanceCapacity ?? 0}
        canEdit={canEditFloat}
        readOnlyReason={readOnlyReason}
      />

      <MerchantCapacityBulkOverrideDialog
        open={bulkOverrideOpen}
        onOpenChange={setBulkOverrideOpen}
        desks={rows
          .filter((r) => !!r.agentId)
          .map((r) => ({
            agentId: r.agentId as string,
            agentName: r.agentName || r.label || 'Merchant agent',
            capacity: capacityFor(r.agentId),
          }))}
        canEdit={canEditFloat}
        readOnlyReason={readOnlyReason}
      />



      <div className="mt-4">
        <MerchantOwnMoneyReviewPanel />
      </div>
    </div>
  );
}
