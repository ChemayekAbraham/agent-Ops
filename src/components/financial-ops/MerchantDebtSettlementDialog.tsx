import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Calendar, Check, Download, FileText, History, Info, Loader2, Phone, ShieldAlert, User, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { formatUGX } from '@/lib/rentCalculations';
import { Textarea } from '@/components/ui/textarea';
import {
  useMerchantSettlementDebts,
  useSettleMerchantOutOfPocket,
  useMerchantOopSettlementHistory,
  useReviewMerchantOutOfPocket,
} from '@/hooks/useMerchantFloat';
import {
  generateMerchantDebtSettlementPdf,
  buildMerchantDebtSettlementFilename,
} from '@/lib/merchantDebtSettlementPdf';

/**
 * Plain-language wording for every reason `settle_merchant_out_of_pocket` can return in
 * its `skipped` list. Collapsing these into one sentence hid a separation-of-duties block
 * behind "already paid or not yet confirmed".
 */
const SKIP_REASON_LABELS: Record<string, string> = {
  MERCHANT_OOP_SETTLEMENT_SELF_BLOCKED:
    'this desk belongs to you — another finance approver must send it',
  already_reimbursed: 'already paid back',
  not_confirmed_yet: 'not confirmed yet',
  estimated_telecom_charge_not_claimable: 'estimated sending fee — not claimable',
  not_evidenced_by_books: 'the books do not show the desk was short',
  partially_evidenced_only: 'only part of it is backed by the books',
};


/**
 * Drill-down for "Money we must send back to them".
 *
 * The board headline is a lifetime paid-out-minus-float differential and is
 * contaminated. This screen only ever pays against CONFIRMED, unreimbursed
 * out-of-pocket advances, and shows each transaction that created the debt.
 * Read-only: selecting and exporting changes nothing in the books.
 */
export function MerchantDebtSettlementDialog({
  open,
  onOpenChange,
  headlineOwed,
  focusAgentId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  headlineOwed?: number;
  /** Reused from other "this agent is owed money" surfaces (e.g. the float
   *  allocation panel's OWED row) — same dialog, no separate settlement UI,
   *  just auto-expanded to the agent that was clicked. */
  focusAgentId?: string;
}) {
  const { data, isLoading, error } = useMerchantSettlementDebts(open);
  const { data: history } = useMerchantOopSettlementHistory(open);
  const settleMutation = useSettleMerchantOutOfPocket();
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  // The agent whose claims are shown on the right. Defaults to the focused agent, else the first one.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmSettleOpen, setConfirmSettleOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Rejection lives ONLY here. `review_merchant_out_of_pocket` is staff-only
  // for a reject, needs a reason of 10+ characters, and writes a system event —
  // nothing is deleted, the claim just stops counting as money we owe.
  const rejectMutation = useReviewMerchantOutOfPocket();
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  // Awaiting-confirmation lists are capped for readability, but every claim has
  // to stay reachable or a desk with dozens of them cannot be fully reviewed.
  const [allReview, setAllReview] = useState<Record<string, boolean>>({});

  const closeReject = () => {
    setRejectFor(null);
    setRejectReason('');
  };

  const submitReject = async (advanceId: string) => {
    try {
      await rejectMutation.mutateAsync({
        id: advanceId,
        decision: 'reject',
        note: rejectReason,
      });
      toast.success('Claim rejected', {
        description: 'It no longer counts as money we owe. The reason is on the record.',
      });
      closeReject();
    } catch (e) {
      toast.error('Could not reject the claim', {
        description: e instanceof Error ? e.message : 'Please try again.',
      });
    }
  };

  /** Reject control for one claim line. Same affordance on payable and
   *  awaiting-confirmation rows, since both are still unreimbursed. */
  const rejectControl = (advanceId: string) =>
    rejectFor === advanceId ? (
      <div className="mt-1 min-w-[16rem]">
        <Textarea
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder="Why is this not money we owe? (at least 10 characters)"
          className="text-sm"
          rows={2}
        />
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            variant="destructive"
            className="min-h-[36px] gap-1 px-3 text-sm"
            disabled={rejectReason.trim().length < 10 || rejectMutation.isPending}
            onClick={() => submitReject(advanceId)}
          >
            {rejectMutation.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            Reject claim
          </Button>
          <Button size="sm" variant="ghost" className="min-h-[36px] px-3 text-sm" onClick={closeReject}>
            Cancel
          </Button>
        </div>
      </div>
    ) : (
      <button
        type="button"
        className="min-h-[32px] text-sm font-semibold text-[#D92D20] underline underline-offset-2 hover:text-[#B42318]"
        onClick={() => {
          setRejectFor(advanceId);
          setRejectReason('');
        }}
      >
        Not owed, reject
      </button>
    );

  useEffect(() => {
    if (open && focusAgentId) setActiveId(focusAgentId);
  }, [open, focusAgentId]);

  const groups = useMemo(() => (data ?? []).filter((g) => g.payable > 0 || g.underReview > 0), [data]);
  const active = groups.find((g) => g.agentId === activeId) ?? groups.find((g) => g.agentId === focusAgentId) ?? groups[0] ?? null;
  // Separation of duties: the settlement RPC refuses a desk belonging to the signed-in
  // actor, so their own desk can never be selected here — it would only come back skipped.
  const payableGroups = groups.filter((g) => g.payable > 0 && !g.isOwnDesk);
  const payableTotal = payableGroups.reduce((s, g) => s + g.payable, 0);
  const reviewTotal = groups.reduce((s, g) => s + g.underReview, 0);

  const chosen = payableGroups.filter((g) => selected[g.agentId]);
  const chosenTotal = chosen.reduce((s, g) => s + g.payable, 0);

  const toggleAll = () => {
    if (chosen.length === payableGroups.length) setSelected({});
    else setSelected(Object.fromEntries(payableGroups.map((g) => [g.agentId, true])));
  };


  const download = async () => {
    const agents = (chosen.length ? chosen : payableGroups);
    if (agents.length === 0) {
      toast.error('Nothing confirmed to settle yet');
      return;
    }
    setBusy(true);
    try {
      const blob = await generateMerchantDebtSettlementPdf({
        payableTotal: agents.reduce((s, g) => s + g.payable, 0),
        underReviewTotal: agents.reduce((s, g) => s + g.underReview, 0),
        agents: agents.map((g) => ({
          agentName: g.agentName,
          agentPhone: g.agentPhone,
          payable: g.payable,
          underReview: g.underReview,
          lines: g.payableLines
            .slice()
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map((l) => ({
              createdAt: l.createdAt,
              kind: l.kind,
              payoutAmount: l.payoutAmount,
              floatUsed: l.floatUsed,
              amount: l.amount,
              withdrawalId: l.withdrawalId,
              note: l.note,
            })),
        })),
      });
      const filename = buildMerchantDebtSettlementFilename(agents.length);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast.success('Settlement schedule downloaded');
    } catch (e: any) {
      toast.error(e?.message || 'Could not build the PDF');
    } finally {
      setBusy(false);
    }
  };

  const sendToWallet = async () => {
    setConfirmSettleOpen(false);
    const advanceIds = chosen.flatMap((g) => g.payableLines.map((l) => l.id));
    if (advanceIds.length === 0) {
      toast.error('Nothing confirmed to settle yet');
      return;
    }
    try {
      const result = await settleMutation.mutateAsync({ advanceIds });
      const settledCount = result.settled.reduce((s, r) => s + r.advance_ids.length, 0);
      const settledTotal = result.settled.reduce((s, r) => s + r.amount, 0);
      if (settledCount > 0) {
        toast.success(
          `Sent ${formatUGX(settledTotal)} to ${result.settled.length} agent wallet${result.settled.length === 1 ? '' : 's'} (${settledCount} claim${settledCount === 1 ? '' : 's'})`,
        );
      }
      if (result.skipped.length > 0) {
        // Show the real reason per claim instead of one catch-all sentence: a
        // separation-of-duties block and an already-paid claim need different actions.
        const counts = new Map<string, number>();
        for (const s of result.skipped) {
          const label = SKIP_REASON_LABELS[s.reason] ?? s.reason;
          counts.set(label, (counts.get(label) ?? 0) + 1);
        }
        toast.warning(`${result.skipped.length} claim(s) could not be settled`, {
          description: Array.from(counts.entries())
            .map(([label, n]) => `${n} × ${label}`)
            .join(' · '),
          duration: 12_000,
        });
      }

      if (settledCount === 0 && result.skipped.length === 0) {
        toast.error('Nothing was settled');
      }
      setSelected({});
    } catch (e: any) {
      toast.error(e?.message || 'Could not send the settlement to the wallet');
    }
  };

  const tileBase = 'rounded-2xl border p-4';
  const sectionLabel = 'text-xs font-extrabold uppercase tracking-wide text-foreground';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto rounded-3xl p-5 sm:p-7">
        <DialogHeader className="space-y-1.5 text-left">
          <DialogTitle className="text-2xl font-black tracking-tight sm:text-3xl">What we owe each merchant agent</DialogTitle>
          <DialogDescription className="text-sm text-foreground/80 sm:text-base">
            Only confirmed own-phone payments that have not been refunded count here. Claims the books do not support are listed separately and never added.
          </DialogDescription>
        </DialogHeader>

        {/* Three figures */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className={`${tileBase} border-[#B79BF2] bg-[#F1EAFF] dark:bg-violet-500/15`}>
            <p className={sectionLabel}>Confirmed, settle now</p>
            <p className="mt-1.5 break-all text-3xl font-black tabular-nums text-[#5A1FD0] dark:text-violet-300">{isLoading ? '—' : formatUGX(payableTotal)}</p>
            <p className="mt-1 text-sm text-foreground/80">{payableGroups.length} agent{payableGroups.length === 1 ? '' : 's'} with a clean, evidenced claim</p>
          </div>
          <div className={`${tileBase} border-[#F0B53F] bg-[#FFF1CF] dark:bg-amber-400/15`}>
            <p className={sectionLabel}>Not payable, books disagree</p>
            <p className="mt-1.5 break-all text-3xl font-black tabular-nums text-[#C2570C] dark:text-amber-300">{isLoading ? '—' : formatUGX(reviewTotal)}</p>
            <p className="mt-1 text-sm text-foreground/80">Float was available, or telecom charges are estimated.</p>
          </div>
          <div className={`${tileBase} border-slate-300 bg-slate-100 dark:bg-slate-800`}>
            <p className={`${sectionLabel} flex items-center gap-2`}><AlertTriangle className="h-4 w-4" aria-hidden="true" /> Board headline (unclean)</p>
            <p className="mt-1.5 break-all text-3xl font-black tabular-nums text-foreground">{typeof headlineOwed === 'number' ? formatUGX(headlineOwed) : '—'}</p>
            <p className="mt-1 text-sm text-foreground/80">Lifetime paid-out minus float recorded. <strong className="text-foreground">Do not pay against this figure.</strong></p>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/30 p-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Could not load agent debts: {(error as { message?: string })?.message ?? 'unknown error'}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <button type="button" onClick={toggleAll} disabled={payableGroups.length === 0} className="min-h-[44px] text-base font-bold text-[#5A1FD0] hover:underline disabled:opacity-50 dark:text-violet-300 sm:min-h-0">
            {chosen.length === payableGroups.length && payableGroups.length > 0 ? 'Clear selection' : 'Select all agents'}
          </button>
          <span className="hidden h-8 w-px bg-border sm:block" aria-hidden="true" />
          <p className="text-base text-foreground">Selected: <span className="font-black tabular-nums">{formatUGX(chosenTotal)}</span></p>
          <Button variant="outline" className="min-h-[44px] gap-2 rounded-xl font-bold" onClick={() => setHistoryOpen((v) => !v)} aria-expanded={historyOpen}>
            <History className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" /> Recently settled
          </Button>
          <Button variant="outline" className="min-h-[44px] gap-2 rounded-xl font-bold" onClick={download} disabled={busy || payableGroups.length === 0}>
            {busy ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : <Download className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />} Download settlement PDF
          </Button>
          <p className="flex max-w-[16rem] items-start gap-2 text-xs text-muted-foreground">
            <FileText className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            PDF includes selected agents, or all payable agents when none are selected.
          </p>
          <Button className="ml-auto min-h-[48px] gap-2 rounded-xl px-6 text-base font-bold" onClick={() => setConfirmSettleOpen(true)} disabled={settleMutation.isPending || chosen.length === 0}>
            {settleMutation.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wallet className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />} Send to Wallet
          </Button>
        </div>

        {historyOpen && (
          <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-xl border border-border bg-muted/30 p-3">
            <p className={sectionLabel}>Recently settled: money already sent back to agent wallets</p>
            {(!history || history.length === 0) && <p className="text-sm text-muted-foreground">No settlements recorded yet.</p>}
            {(history ?? []).map((h) => (
              <div key={h.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate text-foreground">{h.agentName}</span>
                <span className="whitespace-nowrap text-muted-foreground">{format(new Date(h.settledAt), 'd MMM yyyy · HH:mm')}</span>
                <span className="shrink-0 font-bold tabular-nums text-foreground">{formatUGX(h.amount)}</span>
              </div>
            ))}
          </div>
        )}

        {isLoading && <p className="text-sm text-muted-foreground">Loading agent debts…</p>}
        {!isLoading && groups.length === 0 && !error && (
          <p className="text-sm text-muted-foreground">No merchant agent has a confirmed unpaid advance right now.</p>
        )}

        {groups.length > 0 && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
            {/* Left: agents with claims */}
            <section className="min-w-0 rounded-2xl border border-border" aria-label="Agents with claims">
              <h3 className="border-b border-border px-4 py-3 text-lg font-bold text-foreground">Agents with claims</h3>
              <ul className="max-h-72 space-y-2 overflow-y-auto p-2.5 lg:max-h-[34rem]">
                {groups.map((g) => {
                  const isActive = g.agentId === active?.agentId;
                  return (
                    <li key={g.agentId}>
                      <div
                        className={`flex items-start gap-3 rounded-xl border p-3 transition ${isActive ? 'border-[#9B6FF0] bg-[#F1EAFF] dark:bg-violet-500/20' : 'border-border hover:border-[#B79BF2]'}`}
                      >
                        <Checkbox
                          checked={!!selected[g.agentId]}
                          disabled={g.payable <= 0 || g.isOwnDesk}
                          onCheckedChange={(v) => setSelected((s) => ({ ...s, [g.agentId]: !!v }))}
                          aria-label={`Select ${g.agentName}`}
                          className="mt-1 h-5 w-5 border-2 border-[#6D2EE8]"
                        />
                        <button type="button" onClick={() => setActiveId(g.agentId)} aria-pressed={isActive} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-base font-extrabold uppercase text-foreground">{g.agentName}</span>
                            <span className="shrink-0 text-base font-extrabold tabular-nums text-foreground">{formatUGX(g.payable)}</span>
                          </span>
                          {g.payable > 0 ? (
                            <span className="block truncate text-sm text-foreground/80">
                              {g.payableLines.length} confirmed transaction{g.payableLines.length === 1 ? '' : 's'}
                              {g.oldestAt ? ` · oldest ${format(new Date(g.oldestAt), 'd MMM yyyy')}` : ''}
                            </span>
                          ) : (
                            <span className="block text-sm text-foreground/80">Under review · Nothing payable</span>
                          )}
                          {g.underReview > 0 && (
                            <span className="block text-sm font-bold text-[#C2570C] dark:text-amber-300">
                              {formatUGX(g.underReview)} · {g.reviewLines.length} unsupported claim{g.reviewLines.length === 1 ? '' : 's'} excluded
                            </span>
                          )}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>

            {/* Right: the selected agent */}
            {active && (
              <section className="min-w-0 rounded-2xl border border-border" aria-label={`Claims for ${active.agentName}`}>
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
                  <div className="min-w-0">
                    <h3 className="truncate text-2xl font-black uppercase text-foreground">{active.agentName}</h3>
                    <p className="mt-1 flex items-center gap-2 text-base text-foreground/80"><Phone className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" /> {active.agentPhone || '—'}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-black tabular-nums text-foreground">{formatUGX(active.payable)}</p>
                    <p className="text-base text-foreground/80">To settle</p>
                  </div>
                </div>

                <div className="space-y-4 p-4 sm:p-5">
                  {active.isOwnDesk && active.payable > 0 && (
                    <p className="rounded-xl border border-[#F0B53F] bg-[#FFF1CF] px-4 py-3 text-sm font-medium text-foreground dark:bg-amber-400/15">
                      This is your own desk. {formatUGX(active.payable)} is owed to you, and another finance approver must send it to your wallet.
                    </p>
                  )}

                  <div>
                    <h4 className="flex items-center gap-3 text-lg font-bold text-[#5A1FD0] dark:text-violet-300">
                      Confirmed transactions (payable)
                      <span className="rounded-full bg-[#E6DAFF] px-2.5 py-0.5 text-sm font-extrabold text-[#5A1FD0] dark:bg-violet-500/30 dark:text-violet-100">{active.payableLines.length}</span>
                    </h4>
                    {active.payableLines.length === 0 && <p className="mt-2 text-sm text-muted-foreground">No confirmed transactions.</p>}
                    <ul className="mt-3 space-y-3">
                      {active.payableLines.map((l) => (
                        <li key={l.id} className="rounded-2xl border border-border p-4">
                          <div className="flex items-start justify-between gap-3">
                            <p className="text-lg font-bold text-foreground">
                              {l.kind === 'telecom' ? 'Telecom sending charge they paid' : 'Customer payout from their own phone money'}
                            </p>
                            <p className="shrink-0 text-lg font-black tabular-nums text-foreground">{formatUGX(l.amount)}</p>
                          </div>
                          <p className="mt-1.5 flex items-center gap-2 text-sm text-foreground"><Calendar className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" /> {format(new Date(l.payoutAt), 'd MMM yyyy · HH:mm')}</p>
                          <p className="mt-1 flex items-center gap-2 text-sm text-foreground"><User className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" /> Paid to {l.recipientName || 'unknown recipient'}{l.recipientPhone ? ` · ${l.recipientPhone}` : ''}</p>
                          <p className="mt-1.5 break-words text-sm text-muted-foreground">
                            {`TID ${l.payoutTid || 'not returned by provider'}`}
                            {l.withdrawalId ? ` · ref ${l.withdrawalId.slice(0, 8)}` : ''}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {l.payoutAmount ? `Payout ${formatUGX(l.payoutAmount)} · ` : ''}Float used {formatUGX(l.floatUsed)}
                          </p>
                          <div className="mt-3 flex items-start gap-3 rounded-xl border border-[#86D19F] bg-[#D9F3E2] px-4 py-3 dark:border-emerald-500/50 dark:bg-emerald-500/20">
                            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#1A8A47] text-white" aria-hidden="true"><Check className="h-4 w-4" strokeWidth={3.5} /></span>
                            <p className="text-sm font-bold text-[#0B4F25] dark:text-emerald-100">
                              {l.isFinanceAttested
                                ? `Attested by Finance. The money moved outside the system, so there is no ledger or provider trace to reconstruct.${l.attestationBasis ? ` ${l.attestationBasis}` : ''}`
                                : `Books at that moment: desk float ${formatUGX(l.floatPositionAtPayout)}, short by ${formatUGX(Math.max(0, -l.floatPositionAtPayout))}. This amount came from their own phone money.`}
                            </p>
                          </div>
                          {l.note && <p className="mt-2 text-sm text-muted-foreground">{l.note}</p>}
                          <div className="mt-2">{rejectControl(l.id)}</div>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {active.reviewLines.length > 0 && (
                    <div className="rounded-2xl border-2 border-dashed border-[#F0B53F] bg-[#FFFBF0] dark:bg-amber-400/10">
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-t-2xl bg-[#FFE9B5] px-4 py-3 dark:bg-amber-400/25">
                        <p className="flex items-center gap-2 text-base font-extrabold text-[#8A4B00] dark:text-amber-200"><AlertTriangle className="h-5 w-5" aria-hidden="true" /> Not payable · The books show float was available</p>
                        <p className="text-base font-extrabold tabular-nums text-[#8A4B00] dark:text-amber-200">{formatUGX(active.underReview)} excluded</p>
                      </div>
                      <ul className="divide-y divide-[#F0D9A0] px-4">
                        {(allReview[active.agentId] ? active.reviewLines : active.reviewLines.slice(0, 8)).map((l) => (
                          <li key={l.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3">
                            <div className="flex min-w-0 flex-1 items-start gap-2.5">
                              <Calendar className="mt-0.5 h-4 w-4 shrink-0 text-slate-600" strokeWidth={1.75} aria-hidden="true" />
                              <div className="min-w-0">
                                <p className="text-sm font-bold text-foreground">
                                  {format(new Date(l.payoutAt), 'd MMM yyyy · HH:mm')} · {l.isEstimate ? 'Estimated sending fee' : l.recipientName || 'Unknown recipient'}
                                  {l.recipientPhone ? ` · ${l.recipientPhone}` : ''}
                                </p>
                                <p className="break-words text-xs text-muted-foreground">
                                  {`TID ${l.payoutTid || 'not returned by provider'}`}
                                  {l.withdrawalId ? ` · ref ${l.withdrawalId.slice(0, 8)}` : ''}
                                  {l.isEstimate ? ' · not yet claimable' : ` · desk float ${formatUGX(l.floatPositionAtPayout)}`}
                                </p>
                              </div>
                            </div>
                            <p className="shrink-0 text-sm font-extrabold tabular-nums text-foreground">{formatUGX(l.amount)}</p>
                            <div className="shrink-0">{rejectControl(l.id)}</div>
                          </li>
                        ))}
                      </ul>
                      {active.reviewLines.length > 8 && (
                        <Button variant="ghost" className="mx-4 mb-3 min-h-[40px] w-[calc(100%-2rem)] text-sm font-bold" onClick={() => setAllReview((m) => ({ ...m, [active.agentId]: !m[active.agentId] }))}>
                          {allReview[active.agentId] ? 'Show fewer' : `Show all ${active.reviewLines.length} claims`}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>
        )}

        <p className="flex items-start gap-3 border-t border-border pt-4 text-sm text-foreground/90">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" strokeWidth={1.75} aria-hidden="true" />
          <span>
            <strong>Sending to Wallet credits withdrawable wallets and marks confirmed claims reimbursed. You will confirm before money moves.</strong>
            <br />
            Your own desk must be settled by another finance approver.
          </span>
        </p>
      </DialogContent>

      <AlertDialog open={confirmSettleOpen} onOpenChange={setConfirmSettleOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send {formatUGX(chosenTotal)} to {chosen.length} agent wallet{chosen.length === 1 ? '' : 's'}?</AlertDialogTitle>
            <AlertDialogDescription>
              This credits each selected agent's withdrawable wallet directly and marks their confirmed
              own-money claims as reimbursed. This is a real money movement and cannot be undone from here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={sendToWallet}>Send to Wallet</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
