import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Download, ShieldAlert, Loader2, Wallet, History, X } from 'lucide-react';
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
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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
      <div className="mt-1">
        <Textarea
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder="Why is this not money we owe? (at least 10 characters)"
          className="text-[11px]"
          rows={2}
        />
        <div className="mt-1 flex gap-2">
          <Button
            size="sm"
            variant="destructive"
            className="h-6 gap-1 px-2 text-[10px]"
            disabled={rejectReason.trim().length < 10 || rejectMutation.isPending}
            onClick={() => submitReject(advanceId)}
          >
            {rejectMutation.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            Reject claim
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            onClick={closeReject}
          >
            Cancel
          </Button>
        </div>
      </div>
    ) : (
      <Button
        size="sm"
        variant="ghost"
        className="mt-1 h-6 gap-1 px-2 text-[10px] text-destructive hover:text-destructive"
        onClick={() => {
          setRejectFor(advanceId);
          setRejectReason('');
        }}
      >
        <X className="h-3 w-3" /> Not owed — reject
      </Button>
    );

  useEffect(() => {
    if (open && focusAgentId) {
      setExpanded((e) => ({ ...e, [focusAgentId]: true }));
    }
  }, [open, focusAgentId]);

  const groups = useMemo(() => (data ?? []).filter((g) => g.payable > 0 || g.underReview > 0), [data]);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>What we owe each merchant agent</DialogTitle>
          <DialogDescription>
            Only money an agent has confirmed they paid from their own phone, and that we have not
            refunded, counts here. Claims the ledger does not support are listed but never added.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Confirmed — settle now
            </p>
            <p className="mt-1 font-mono text-xl font-bold tabular-nums text-primary break-all">
              {isLoading ? '—' : formatUGX(payableTotal)}
            </p>
            <p className="text-[10px] text-muted-foreground mt-1">
              {payableGroups.length} agent{payableGroups.length === 1 ? '' : 's'} with a clean, evidenced claim
            </p>
          </div>
          <div className="rounded-xl border border-warning/30 bg-warning/5 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Not payable — books disagree
            </p>
            <p className="mt-1 font-mono text-xl font-bold tabular-nums text-warning break-all">
              {isLoading ? '—' : formatUGX(reviewTotal)}
            </p>
            <p className="text-[10px] text-muted-foreground mt-1">
              Books show float was available, or it is an estimated telecom charge
            </p>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Board headline (unclean)
            </p>
            <p className="mt-1 font-mono text-xl font-bold tabular-nums text-muted-foreground break-all">
              {typeof headlineOwed === 'number' ? formatUGX(headlineOwed) : '—'}
            </p>
            <p className="text-[10px] text-muted-foreground mt-1">
              Lifetime paid-out minus float recorded. Do not pay against this figure.
            </p>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/30 p-3">
            <ShieldAlert className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <p className="text-[11px] text-muted-foreground">
              Could not load agent debts: {(error as { message?: string })?.message ?? 'unknown error'}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={toggleAll}
            disabled={payableGroups.length === 0}
            className="text-[11px] font-medium text-primary hover:underline disabled:opacity-50"
          >
            {chosen.length === payableGroups.length && payableGroups.length > 0
              ? 'Clear selection'
              : 'Select all agents'}
          </button>
          <div className="flex items-center gap-3">
            <p className="text-[11px] text-muted-foreground">
              Selected: <span className="font-mono font-bold text-foreground">{formatUGX(chosenTotal)}</span>
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setHistoryOpen((v) => !v)}
            >
              <History className="mr-1.5 h-3.5 w-3.5" />
              Recently settled
            </Button>
            <Button size="sm" variant="outline" onClick={download} disabled={busy || payableGroups.length === 0}>
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
              Download settlement PDF
            </Button>
            <Button
              size="sm"
              onClick={() => setConfirmSettleOpen(true)}
              disabled={settleMutation.isPending || chosen.length === 0}
            >
              {settleMutation.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wallet className="mr-1.5 h-3.5 w-3.5" />
              )}
              Send to Wallet
            </Button>
          </div>
        </div>

        {historyOpen && (
          <div className="rounded-xl border border-border bg-muted/20 p-3 space-y-1.5 max-h-48 overflow-y-auto">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Recently settled — money already sent back to agent wallets
            </p>
            {(!history || history.length === 0) && (
              <p className="text-[11px] text-muted-foreground">No settlements recorded yet.</p>
            )}
            {(history ?? []).map((h) => (
              <div key={h.id} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-foreground truncate">{h.agentName}</span>
                <span className="text-muted-foreground whitespace-nowrap">
                  {format(new Date(h.settledAt), 'd MMM yyyy · HH:mm')}
                </span>
                <span className="font-mono font-semibold text-foreground shrink-0">{formatUGX(h.amount)}</span>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2">
          {isLoading && <p className="text-xs text-muted-foreground">Loading agent debts…</p>}
          {!isLoading && groups.length === 0 && !error && (
            <p className="text-xs text-muted-foreground">
              No merchant agent has a confirmed unpaid advance right now.
            </p>
          )}
          {groups.map((g) => {
            const isOpen = !!expanded[g.agentId];
            const isFocused = g.agentId === focusAgentId;
            return (
              <div
                key={g.agentId}
                ref={isFocused ? (el) => el?.scrollIntoView({ block: 'center' }) : undefined}
                className={`rounded-xl border bg-background ${isFocused ? 'border-primary ring-1 ring-primary/40' : 'border-border'}`}
              >
                <div className="flex items-start gap-3 p-3">
                  <Checkbox
                    checked={!!selected[g.agentId]}
                    disabled={g.payable <= 0 || g.isOwnDesk}
                    onCheckedChange={(v) =>
                      setSelected((s) => ({ ...s, [g.agentId]: !!v }))
                    }
                    className="mt-1"
                  />
                  <button
                    type="button"
                    onClick={() => setExpanded((e) => ({ ...e, [g.agentId]: !isOpen }))}
                    className="flex-1 min-w-0 text-left"
                  >
                    <p className="text-sm font-medium text-foreground truncate">{g.agentName}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {g.agentPhone || '—'} · {g.payableLines.length} confirmed transaction
                      {g.payableLines.length === 1 ? '' : 's'}
                      {g.oldestAt ? ` · oldest ${format(new Date(g.oldestAt), 'd MMM yyyy')}` : ''}
                    </p>
                    {g.isOwnDesk && g.payable > 0 && (
                      <p className="text-[10px] text-warning">
                        This is your own desk — {formatUGX(g.payable)} is owed to you, and another
                        finance approver must send it to your wallet.
                      </p>
                    )}
                    {g.underReview > 0 && (
                      <p className="text-[10px] text-warning">
                        {formatUGX(g.underReview)} across {g.reviewLines.length} claim
                        {g.reviewLines.length === 1 ? '' : 's'} the books do not support — excluded
                      </p>
                    )}

                  </button>
                  <div className="text-right shrink-0">
                    <p className="font-mono text-sm font-bold tabular-nums text-foreground">
                      {formatUGX(g.payable)}
                    </p>
                    <p className="text-[10px] text-muted-foreground">to settle</p>
                    <ChevronDown
                      className={`ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    />
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-border px-3 py-2 space-y-1">
                    {g.payableLines.length === 0 && (
                      <p className="text-[11px] text-muted-foreground">No confirmed transactions.</p>
                    )}
                    {g.payableLines.map((l) => (
                      <div key={l.id} className="flex items-start justify-between gap-3 py-1">
                        <div className="min-w-0">
                          <p className="text-[11px] font-medium text-foreground">
                            {l.kind === 'telecom'
                              ? 'Telecom sending charge they paid'
                              : 'Customer payout from their own phone money'}
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {format(new Date(l.payoutAt), 'd MMM yyyy · HH:mm')}
                            {` · paid to ${l.recipientName || 'Unknown recipient'}`}
                            {l.recipientPhone ? ` · ${l.recipientPhone}` : ''}
                          </p>
                          <p className="text-[10px] text-muted-foreground truncate">
                            {`TID ${l.payoutTid || 'not returned by provider'}`}
                            {l.withdrawalId ? ` · ref ${l.withdrawalId.slice(0, 8)}` : ''}
                            {l.payoutAmount ? ` · payout ${formatUGX(l.payoutAmount)}` : ''}
                            {` · float used ${formatUGX(l.floatUsed)}`}
                          </p>
                          {l.isFinanceAttested ? (
                            <p className="text-[10px] text-success">
                              Attested by Finance. The money moved outside the system, so there is no
                              ledger or provider trace to reconstruct.
                              {l.attestationBasis ? ` ${l.attestationBasis}` : ''}
                            </p>
                          ) : (
                            <p className="text-[10px] text-success">
                              {`Books at that moment: desk float ${formatUGX(l.floatPositionAtPayout)} — short by ${formatUGX(Math.max(0, -l.floatPositionAtPayout))}, so this much came from their own phone money.`}
                            </p>
                          )}
                          {l.note && (
                            <p className="text-[10px] text-muted-foreground">{l.note}</p>
                          )}
                          {rejectControl(l.id)}
                        </div>
                        <p className="font-mono text-[11px] font-bold tabular-nums text-foreground shrink-0">
                          {formatUGX(l.amount)}
                        </p>
                      </div>
                    ))}
                    {g.reviewLines.length > 0 && (
                      <div className="mt-2 rounded-lg border border-dashed border-warning/50 bg-warning/5 p-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-warning">
                          Not payable — the books show float was available
                        </p>
                        {(allReview[g.agentId] ? g.reviewLines : g.reviewLines.slice(0, 8)).map((l) => (
                          <div key={l.id} className="mt-1">
                            <p className="text-[10px] text-muted-foreground">
                              {format(new Date(l.payoutAt), 'd MMM yyyy · HH:mm')} · {formatUGX(l.amount)}
                              {` · paid to ${l.recipientName || 'Unknown recipient'}`}
                              {l.recipientPhone ? ` · ${l.recipientPhone}` : ''}
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                              {`TID ${l.payoutTid || 'not returned by provider'}`}
                              {l.withdrawalId ? ` · ref ${l.withdrawalId.slice(0, 8)}` : ''}
                              {l.isEstimate
                                ? ' · estimated telecom charge, not yet claimable'
                                : ` · desk float at that moment ${formatUGX(l.floatPositionAtPayout)}`}
                            </p>
                            {rejectControl(l.id)}
                          </div>
                        ))}
                        {g.reviewLines.length > 8 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="mt-1 h-6 w-full px-2 text-[10px]"
                            onClick={() =>
                              setAllReview((m) => ({ ...m, [g.agentId]: !m[g.agentId] }))
                            }
                          >
                            {allReview[g.agentId]
                              ? 'Show fewer'
                              : `Show all ${g.reviewLines.length} claims`}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
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
