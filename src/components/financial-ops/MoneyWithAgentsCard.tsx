import { useState } from 'react';
import { AlertCircle, HandCoins, ArrowRightLeft, AlertTriangle, SlidersHorizontal, ShieldAlert, RefreshCw, Gauge, Coins, Smartphone, Undo2, Info, ChevronDown, ChevronUp, ArrowRight } from 'lucide-react';
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
import { MerchantDeskStatementDialog } from './MerchantDeskStatementDialog';
import { CompanyReceiptsToPlacePanel } from './CompanyReceiptsToPlacePanel';
import { MerchantDeskFundingSummaryCard } from './MerchantDeskFundingSummaryCard';
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
  const [deskSheetFor, setDeskSheetFor] = useState<MerchantFloatPosition | null>(null);
  const qc = useQueryClient();
  const [sweeping, setSweeping] = useState(false);
  const [debtsOpen, setDebtsOpen] = useState(false);
  // The overview shows the three headline figures; the working tools sit behind this.
  const [showDetails, setShowDetails] = useState(false);
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



  // ---- Cells shared by the table (wide screens) and the stacked cards (phones) ----
  const agentLabel = (r: MerchantFloatPosition) => r.agentName || r.label || 'Merchant agent';

  const agentCell = (r: MerchantFloatPosition) => (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setStatementFor(r)}
        className="text-left text-base font-extrabold uppercase leading-tight text-[#5A1FD0] underline decoration-[#B79BF2] underline-offset-2 hover:text-[#4413A8] dark:text-violet-300"
      >
        {agentLabel(r)}
      </button>
      {r.agentId && (
        <button
          type="button"
          onClick={() => setDeskSheetFor(r)}
          className="mt-1.5 block w-fit whitespace-nowrap rounded-md border border-[#C9CFDA] px-2 py-0.5 text-xs font-semibold text-slate-600 hover:border-[#6D2EE8] hover:text-[#5A1FD0] dark:border-slate-600 dark:text-slate-300"
        >
          Desk sheet
        </button>
      )}
      <p className="mt-1 flex items-center gap-1.5 text-sm text-foreground">
        <Smartphone className="h-4 w-4 shrink-0 text-slate-500" strokeWidth={1.75} aria-hidden="true" />
        {r.agentPhone || '—'}
      </p>
    </div>
  );

  const capacityCell = (r: MerchantFloatPosition) => {
    const cap = capacityFor(r.agentId);
    const earned = cap?.earnedCapacity ?? 0;
    return (
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={!r.agentId}
            onClick={() => r.agentId && setHistoryFor({ agentId: r.agentId, name: agentLabel(r) })}
            title={cap?.blocker ? cap.blocker : `${cap?.reason || 'No verified payout record yet'}. Tap for capacity history`}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-extrabold uppercase tracking-wide disabled:cursor-default ${
              earned > 0
                ? 'border-[#9B6FF0] bg-[#EDE5FF] text-[#5A1FD0] dark:bg-violet-500/25 dark:text-violet-100'
                : 'border-slate-300 bg-white text-slate-800 dark:bg-transparent dark:text-slate-100'
            }`}
          >
            <Gauge className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Qualifies {perfLoading ? '…' : formatUGX(earned)}/day
          </button>
          {cap?.override && (
            <span
              className="inline-flex items-center rounded-full border border-[#9B6FF0] bg-[#EDE5FF] px-3 py-1 text-xs font-extrabold uppercase tracking-wide text-[#5A1FD0]"
              title={`Override by ${cap.override.setBy || 'Financial Ops'}: ${cap.override.reason}`}
            >
              override · earned {formatUGX(cap.performanceCapacity)}
            </span>
          )}
          {pot > 0 && (
            <span className="inline-flex items-center rounded-full bg-[#5A1FD0] px-3 py-1 text-xs font-extrabold uppercase tracking-wide text-white">
              send {formatUGX(cap?.suggestedAllocation ?? 0)}
            </span>
          )}
          {isUnverified(r) && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#FFD6D6] px-3 py-1 text-xs font-extrabold uppercase tracking-wide text-[#B42318]">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" /> {evidenceLabel(r)}
            </span>
          )}
        </div>
        {cap?.blocker ? (
          <p className="flex items-start gap-1.5 text-sm font-medium text-[#C2410C]">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
            <span>Blocked · {cap.blocker.replace(/^blocked:?\s*/i, '')}</span>
          </p>
        ) : (
          <p className="text-sm text-foreground/80">
            {capacityLabel(cap).replace(/^./, (c) => c.toUpperCase()).replace(' — ', ' · ')}
            {cap && cap.earnedCapacity > 0 ? <span className="block">Avg {formatUGX(Math.round(cap.dailyThroughput))}/day paid out</span> : null}
          </p>
        )}
      </div>
    );
  };

  const movementsCell = (r: MerchantFloatPosition) => {
    const movements = movementsFor(r);
    const latestAt = latestMovementAt(r);
    return (
      <div className="space-y-0.5 text-sm tabular-nums">
        {movements.length === 0 ? (
          <p className="text-muted-foreground">No float movements</p>
        ) : (
          movements.map((m, idx) => (
            <p key={`${m.agentId}-${m.date}-${idx}`} className="font-bold text-foreground">
              {m.direction === 'cash_in' ? '+' : '−'}{formatUGX(m.amount)}
              <span className="ml-1.5 font-normal text-muted-foreground">· {format(new Date(m.date), 'd MMM')}</span>
            </p>
          ))
        )}
        {latestAt && <p className="pt-0.5 text-xs text-muted-foreground">Last movement {format(new Date(latestAt), 'd MMM yyyy · HH:mm')}</p>}
      </div>
    );
  };

  const paidCell = (r: MerchantFloatPosition) => (
    <dl className="space-y-1 text-sm tabular-nums">
      <div className="flex items-baseline justify-between gap-4"><dt className="text-muted-foreground">Paid out</dt><dd className="font-bold text-foreground">{formatUGX(r.paidOut)}</dd></div>
      <div className="flex items-baseline justify-between gap-4"><dt className="text-muted-foreground">Reimbursed</dt><dd className="font-bold text-foreground">{formatUGX(r.reimbursed)}</dd></div>
    </dl>
  );

  const floatCell = (r: MerchantFloatPosition) => {
    const holding = r.companyCashWithAgent > 0;
    const settled = !holding && r.owedToAgent <= 0 && r.ownCashUnderReview <= 0;
    const booksProveLess = spendableFloat(r) < Math.max(0, r.ledgerFloatHeld);
    return (
      <div>
        <p className="text-xl font-extrabold text-foreground">{formatUGX(spendableFloat(r))}</p>
        <p className="text-sm text-muted-foreground">
          {spendableFloat(r) > 0 ? 'Float balance on their phone' : holding ? 'Our money still on their phone' : settled ? 'Nothing outstanding either way' : 'We must send this back to them'}
        </p>
        {isUnverified(r) && <p className="mt-1 text-xs font-semibold text-[#B42318]">{formatUGX(excludedFloat(r))} not counted as float</p>}
        {booksProveLess && <p className="mt-1 text-xs text-muted-foreground">Shown on their phone {formatUGX(Math.max(0, r.ledgerFloatHeld))}. Books prove less.</p>}
        {r.clampedShortfall > 0 && <p className="mt-1 text-xs font-bold text-[#B42318]">Hides a {formatUGX(r.clampedShortfall)} deficit</p>}
        {r.ownCashUnderReview > 0 && <p className="mt-1 text-xs font-bold text-[#B42318]">{formatUGX(r.ownCashUnderReview)} of their own money filed but not supported by the books. Not payable.</p>}
      </div>
    );
  };

  const actionsCell = (r: MerchantFloatPosition) => (
    <div className="flex flex-row flex-wrap gap-x-5 gap-y-2 lg:flex-col lg:gap-y-3">
      <button
        type="button"
        disabled={!r.agentId}
        onClick={() => r.agentId && setOverrideFor({ agentId: r.agentId, name: agentLabel(r) })}
        title="Temporarily adjust this desk's qualified capacity (reason required)"
        className="inline-flex min-h-[32px] items-center gap-2 text-sm font-bold text-[#5A1FD0] hover:underline disabled:cursor-default disabled:opacity-50 dark:text-violet-300"
      >
        <SlidersHorizontal className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" /> Adjust
      </button>
      {canEditFloat ? (
        <button
          type="button"
          onClick={() => setReconciling(r)}
          className="inline-flex min-h-[32px] items-center gap-2 text-sm font-bold text-[#5A1FD0] hover:underline dark:text-violet-300"
        >
          <RefreshCw className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" /> Fix balance
        </button>
      ) : (
        <p className="max-w-[10rem] text-xs text-muted-foreground">{readOnlyReason}</p>
      )}
    </div>
  );

  const tile = 'flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-[#D2BFFA] bg-[#EFE8FF] text-[#6D2EE8] dark:bg-violet-500/20 dark:border-violet-400/40';
  const th = 'px-4 py-3 text-left text-sm font-bold text-foreground';

  return (
    <div className="min-w-0 rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className={tile}><HandCoins className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" /></span>
          <div className="min-w-0">
            <h2 className="text-xl font-bold tracking-tight text-foreground">Money With Merchant Agents</h2>
            <p className="text-sm text-muted-foreground">Company funds held by agents and reimbursements owed</p>
          </div>
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 sm:w-auto sm:shrink-0 sm:justify-start sm:gap-3">
          {onOpenTimeline && (
            <button type="button" onClick={onOpenTimeline} className="inline-flex min-h-[44px] items-center gap-2 text-sm font-bold text-[#5A1FD0] hover:underline dark:text-violet-300 sm:min-h-0">
              <ArrowRightLeft className="h-[18px] w-[18px]" aria-hidden="true" /> Settlement timeline <ArrowRight className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-border bg-background px-4 text-sm font-bold text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {showDetails ? 'Hide details' : 'Show details'}
            {showDetails ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {/* The three headline figures */}
      <div className="mt-5 grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="flex min-w-0 items-center gap-4 py-3 sm:py-0 sm:pr-6">
          <span className={tile}><Coins className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" /></span>
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">Float they can spend now</p>
            <p className="break-all text-2xl font-black tracking-tight text-foreground sm:text-[28px]">{isLoading ? '—' : formatUGX(floatTotal)}</p>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-4 py-3 sm:px-6 sm:py-0">
          <span className={tile}><Smartphone className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" /></span>
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">Our cash still on their phones</p>
            <p className="break-all text-2xl font-black tracking-tight text-foreground sm:text-[28px]">{isLoading ? '—' : formatUGX(heldTotal)}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDebtsOpen(true)}
          title="See what each agent is owed, the transactions behind it, and download a settlement PDF"
          className="flex min-w-0 items-center gap-4 rounded-lg py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:py-0 sm:pl-6"
        >
          <span className={tile}><Undo2 className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" /></span>
          <span className="min-w-0">
            <span className="block text-sm text-muted-foreground">Money we must send back to them</span>
            <span className="block break-all text-2xl font-black tracking-tight text-foreground sm:text-[28px]">{isLoading ? '—' : formatUGX(owedTotal)}</span>
            {!isLoading && underReviewTotal > 0 && (
              <span className="mt-0.5 block text-xs font-semibold text-[#B42318]">
                + {formatUGX(underReviewTotal)} filed but not supported by the books across {underReviewDesks} {underReviewDesks === 1 ? 'desk' : 'desks'}. Not payable.
              </span>
            )}
          </span>
        </button>
      </div>

      <p className="mt-4 flex items-start gap-2 text-sm text-foreground/80">
        <Info className="mt-0.5 h-[18px] w-[18px] shrink-0 text-slate-500" strokeWidth={1.75} aria-hidden="true" />
        Only evidenced amounts included. Unverified claims remain separate.
      </p>

      {deficitTotal > 0 && (
        <div className="mt-4 rounded-2xl border-2 border-dashed border-[#E8605A] bg-[#FFE6E4] p-3.5 dark:bg-red-500/15">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#B42318]" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-xs font-extrabold uppercase tracking-wider text-[#B42318]">Hidden deficit across desks</p>
              <p className="mt-1 text-lg font-extrabold tabular-nums text-[#B42318]">{formatUGX(deficitTotal)}</p>
              <p className="mt-1 text-xs text-foreground/80">
                {deficitRows.length} desk{deficitRows.length === 1 ? '' : 's'} true position is negative by this amount. It can't show as a negative number, but this is real, not spendable float.
              </p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-border bg-muted/30 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            {/(not authorized|forbidden|permission)/i.test((error as { message?: string })?.message ?? '')
              ? 'This board is only visible to finance roles.'
              : `This board could not load: ${(error as { message?: string })?.message ?? 'unknown error'}`}
          </p>
        </div>
      )}

      {showDetails && !error && (
        <>
          {/* Plan today's distribution */}
          {rows.length > 0 && (
            <section className="mt-5 rounded-2xl border border-[#B79BF2] bg-[#F7F2FF] p-4 dark:bg-violet-500/10 sm:p-5" aria-label="Plan today's distribution">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-xl font-bold text-foreground">Plan today's distribution</h3>
                  <p className="mt-1 text-sm text-foreground/80">Each agent's share is based on their own verified payout record, not shared equally.</p>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-sm text-foreground">Amount to distribute (UGX)</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={potInput}
                      onChange={(e) => setPotInput(e.target.value)}
                      placeholder="e.g. 5000000"
                      className="h-11 w-48 rounded-xl border border-border bg-background px-3 text-base tabular-nums outline-none focus:border-[#6D2EE8] focus:ring-2 focus:ring-[#B79BF2]"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-sm text-foreground">Record window</span>
                    <select
                      value={capacityWindow}
                      onChange={(e) => setCapacityWindow(Number(e.target.value))}
                      className="h-11 rounded-xl border border-border bg-background px-3 text-base font-medium outline-none focus:border-[#6D2EE8] focus:ring-2 focus:ring-[#B79BF2]"
                    >
                      <option value={7}>Last 7 days</option>
                      <option value={14}>Last 14 days</option>
                      <option value={30}>Last 30 days</option>
                      <option value={90}>Last 90 days</option>
                    </select>
                  </label>
                  {potInput && (
                    <button type="button" onClick={() => setPotInput('')} className="h-11 rounded-xl border border-border bg-background px-4 text-sm font-semibold text-muted-foreground hover:text-foreground">
                      Clear
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setBulkOverrideOpen(true)}
                    title="Adjust several desks' qualified capacity in one action (one reason, per-desk durations)"
                    className="inline-flex h-11 items-center gap-2 rounded-xl border border-border bg-background px-4 text-base font-semibold text-foreground hover:bg-muted/60"
                  >
                    <SlidersHorizontal className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" /> Bulk adjust capacity
                  </button>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className="rounded-xl border border-border bg-background px-4 py-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-foreground">Earned capacity today</p>
                  <p className="text-xl font-extrabold tabular-nums text-[#5A1FD0] dark:text-violet-300">{perfLoading ? '—' : formatUGX(capacityTotal)}</p>
                  <p className="text-sm text-foreground/80">across {eligibleDesks} qualifying desk{eligibleDesks === 1 ? '' : 's'}</p>
                </div>
                <div className="rounded-xl border border-border bg-background px-4 py-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-foreground">Recommended split</p>
                  <p className="text-xl font-extrabold tabular-nums text-foreground">{pot > 0 ? formatUGX(allocatedTotal) : '—'}</p>
                  <p className="text-sm text-foreground/80">{pot > 0 ? `of ${formatUGX(pot)} entered` : 'Enter an amount to see each agent’s share'}</p>
                </div>
                <div className="rounded-xl border border-border bg-background px-4 py-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-foreground">Already with them</p>
                  <p className="text-xl font-extrabold tabular-nums text-[#5A1FD0] dark:text-violet-300">{isLoading ? '—' : formatUGX(floatTotal)}</p>
                  <p className="text-sm text-foreground/80">Spendable float still on their phones</p>
                </div>
              </div>
              {pot > 0 && capacityTotal === 0 && (
                <p className="mt-3 text-sm font-medium text-foreground/80">No desk currently qualifies on record, so nothing can be recommended.</p>
              )}
            </section>
          )}

          <div className="mt-4 flex items-center justify-between gap-3 text-sm">
            <p className="text-foreground">Total float with merchant agents (evidenced only)</p>
            <p className="text-lg font-extrabold tabular-nums text-foreground">{isLoading ? '—' : formatUGX(floatTotal)}</p>
          </div>

          {/* Active merchant agents */}
          <div className="mt-4 border-t border-border pt-4">
            <div className="flex flex-wrap items-baseline gap-3">
              <h3 className="text-xl font-bold text-foreground">Active merchant agents</h3>
              <span className="text-sm text-muted-foreground"><span className="mr-2 text-border">|</span>Newest movement first · {rows.length} {rows.length === 1 ? 'agent' : 'agents'}</span>
            </div>

            {isLoading && <p className="mt-3 text-sm text-muted-foreground">Loading merchant positions…</p>}
            {!isLoading && rows.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No merchant activity in the current window.</p>}

            {rows.length > 0 && (
              <>
                {/* Wide screens: the table */}
                <div className="mt-3 hidden overflow-hidden rounded-2xl border border-border lg:block">
                  <table className="w-full table-fixed border-collapse">
                    <thead className="bg-muted/50">
                      <tr className="border-b border-border">
                        <th className={`${th} w-[17%]`}>Agent</th>
                        <th className={`${th} w-[24%]`}>Capacity &amp; record</th>
                        <th className={`${th} w-[17%]`}>Recent movements</th>
                        <th className={`${th} w-[18%]`}>Paid out / Reimbursed</th>
                        <th className={`${th} w-[17%]`}>Float balance</th>
                        <th className={`${th} w-[7%]`}>Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {rows.map((r) => (
                        <tr key={r.deskId} className={`align-top ${isUnverified(r) ? 'bg-[#FFF3F2] dark:bg-red-500/10' : ''}`}>
                          <td className="px-4 py-4">{agentCell(r)}</td>
                          <td className="px-4 py-4">{capacityCell(r)}</td>
                          <td className="px-4 py-4">{movementsCell(r)}</td>
                          <td className="px-4 py-4">{paidCell(r)}</td>
                          <td className="px-4 py-4">{floatCell(r)}</td>
                          <td className="px-4 py-4">{actionsCell(r)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Phones and tablets: one card per agent */}
                <ul className="mt-3 space-y-3 lg:hidden">
                  {rows.map((r) => (
                    <li key={r.deskId} className={`space-y-3 rounded-2xl border p-4 ${isUnverified(r) ? 'border-dashed border-[#E8605A] bg-[#FFF3F2] dark:bg-red-500/10' : 'border-border bg-background'}`}>
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        {agentCell(r)}
                        <div className="min-w-0 sm:max-w-[55%] sm:shrink-0 sm:text-right">{floatCell(r)}</div>
                      </div>
                      {capacityCell(r)}
                      <div className="grid gap-3 sm:grid-cols-2">
                        {movementsCell(r)}
                        {paidCell(r)}
                      </div>
                      <div className="border-t border-border pt-2">{actionsCell(r)}</div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          {/* Evidence safeguards: money the books do not support stays visible, separate from float */}
          {excludedRows.length > 0 && (
            <div className="mt-4 rounded-xl border-2 border-dashed border-[#E8605A] bg-[#FFF0EF] p-3.5 dark:bg-red-500/10">
              <div className="flex items-start gap-2.5">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[#B42318]" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-xs font-extrabold uppercase tracking-wider text-[#B42318]">Unverified, excluded from float</p>
                  <p className="mt-0.5 text-sm text-foreground/80">
                    {formatUGX(excludedTotal)} shown on merchant desks that the books do not support. Not spendable, not owed, and not included in any figure above. Under investigation.
                  </p>
                </div>
              </div>
              <ul className="mt-2 space-y-1.5">
                {excludedRows.map((r) => (
                  <li key={`excluded-${r.deskId}`} className="min-w-0 rounded-lg border border-border bg-background px-3 py-2">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <p className="min-w-0 truncate text-sm font-semibold text-foreground">{agentLabel(r)}</p>
                      <p className="shrink-0 text-sm font-extrabold tabular-nums text-[#B42318]">{formatUGX(excludedFloat(r))}</p>
                    </div>
                    {r.clampArtifactAmount > 0 && <p className="text-xs text-muted-foreground">{formatUGX(r.clampArtifactAmount)}: cache exceeds what the ledger supports</p>}
                    {r.assertedOnlyAmount > 0 && <p className="text-xs text-muted-foreground">{formatUGX(r.assertedOnlyAmount)}: no independent evidence found</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {deficitRows.length > 0 && (
            <div className="mt-4 rounded-xl border-2 border-dashed border-[#E8605A] bg-[#FFF0EF] p-3.5 dark:bg-red-500/10">
              <div className="flex items-start gap-2.5">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[#B42318]" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-xs font-extrabold uppercase tracking-wider text-[#B42318]">Hidden deficit: the zero floor is hiding a shortfall</p>
                  <p className="mt-0.5 text-sm text-foreground/80">
                    {formatUGX(deficitTotal)} across {deficitRows.length} desk{deficitRows.length === 1 ? '' : 's'}. These agents have paid out more than they were ever credited. The true position is negative, but the board can never display less than UGX 0. This is money owed TO the company, not float.
                  </p>
                </div>
              </div>
              <ul className="mt-2 space-y-1.5">
                {deficitRows.map((r) => (
                  <li key={`deficit-${r.deskId}`} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
                    <p className="min-w-0 truncate text-sm font-semibold text-foreground">{agentLabel(r)}</p>
                    <p className="shrink-0 text-sm font-extrabold tabular-nums text-[#B42318]">−{formatUGX(r.clampedShortfall)}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Rules, kept short */}
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl bg-muted/60 px-4 py-3 text-sm text-foreground/90">
            <p className="flex min-w-[16rem] flex-1 items-start gap-2.5">
              <Info className="mt-0.5 h-[18px] w-[18px] shrink-0 text-slate-500" strokeWidth={1.75} aria-hidden="true" />
              Refund only after the provider message proves the agent paid from their own phone.
            </p>
            <p className="flex min-w-[18rem] flex-[1.6] items-start gap-2.5 sm:border-l sm:border-border sm:pl-6">
              <Info className="mt-0.5 h-[18px] w-[18px] shrink-0 text-slate-500" strokeWidth={1.75} aria-hidden="true" />
              Pay merchant agents via MTN or Airtel to their float number. Confirmation is read automatically; never adjust figures by hand. Financial Ops pays agents, never customers.
            </p>
            <button
              type="button"
              onClick={runFloatSweep}
              disabled={sweeping}
              title="Post the company-float deduction for any payout that completed without one (last 7 days)"
              className="inline-flex min-h-[44px] items-center gap-2 text-sm font-bold text-[#5A1FD0] hover:underline disabled:opacity-50 dark:text-violet-300 sm:min-h-0"
            >
              <RefreshCw className={`h-[18px] w-[18px] ${sweeping ? 'animate-spin' : ''}`} strokeWidth={1.75} aria-hidden="true" />
              {sweeping ? 'Repairing…' : 'Repair payout deductions'}
            </button>
          </div>
        </>
      )}

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

      <MerchantDeskStatementDialog
        position={deskSheetFor}
        open={!!deskSheetFor}
        onOpenChange={(v) => !v && setDeskSheetFor(null)}
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



      {showDetails && (
        <>
          <div className="mt-4">
            <CompanyReceiptsToPlacePanel
              desks={rows
                .filter((r) => !!r.agentId)
                .map((r) => ({
                  agentId: r.agentId as string,
                  name: r.agentName || r.label || 'Merchant agent',
                  float: Math.max(0, r.ledgerFloatHeld),
                }))}
            />
          </div>

          <div className="mt-4">
            <MerchantOwnMoneyReviewPanel />
          </div>

          <div className="mt-4">
            <MerchantDeskFundingSummaryCard />
          </div>
        </>
      )}
    </div>
  );
}
