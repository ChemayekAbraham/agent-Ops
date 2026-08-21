import { useMemo, useState } from 'react';
import { ChevronDown, Download, ShieldAlert, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { formatUGX } from '@/lib/rentCalculations';
import { useMerchantSettlementDebts } from '@/hooks/useMerchantFloat';
import {
  generateMerchantDebtSettlementPdf,
  buildMerchantDebtSettlementFilename,
} from '@/lib/merchantDebtSettlementPdf';

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
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  headlineOwed?: number;
}) {
  const { data, isLoading, error } = useMerchantSettlementDebts(open);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const groups = useMemo(() => (data ?? []).filter((g) => g.payable > 0 || g.underReview > 0), [data]);
  const payableGroups = groups.filter((g) => g.payable > 0);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>What we owe each merchant agent</DialogTitle>
          <DialogDescription>
            Only money an agent has confirmed they paid from their own phone, and that we have not
            refunded, counts here. Amounts still awaiting confirmation are listed but never added.
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
              Awaiting confirmation
            </p>
            <p className="mt-1 font-mono text-xl font-bold tabular-nums text-warning break-all">
              {isLoading ? '—' : formatUGX(reviewTotal)}
            </p>
            <p className="text-[10px] text-muted-foreground mt-1">
              Float shortfalls filed for review — not money owed yet
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
            <Button size="sm" onClick={download} disabled={busy || payableGroups.length === 0}>
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
              Download settlement PDF
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          {isLoading && <p className="text-xs text-muted-foreground">Loading agent debts…</p>}
          {!isLoading && groups.length === 0 && !error && (
            <p className="text-xs text-muted-foreground">
              No merchant agent has a confirmed unpaid advance right now.
            </p>
          )}
          {groups.map((g) => {
            const isOpen = !!expanded[g.agentId];
            return (
              <div key={g.agentId} className="rounded-xl border border-border bg-background">
                <div className="flex items-start gap-3 p-3">
                  <Checkbox
                    checked={!!selected[g.agentId]}
                    disabled={g.payable <= 0}
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
                    {g.underReview > 0 && (
                      <p className="text-[10px] text-warning">
                        {formatUGX(g.underReview)} across {g.reviewLines.length} claim
                        {g.reviewLines.length === 1 ? '' : 's'} still awaiting confirmation — excluded
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
                          <p className="text-[10px] text-success">
                            {`Books at that moment: desk float ${formatUGX(l.floatPositionAtPayout)} — short by ${formatUGX(Math.max(0, -l.floatPositionAtPayout))}, so this much came from their own phone money.`}
                          </p>
                          {l.note && (
                            <p className="text-[10px] text-muted-foreground">{l.note}</p>
                          )}
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
                        {g.reviewLines.slice(0, 8).map((l) => (
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
                          </div>
                        ))}
                        {g.reviewLines.length > 8 && (
                          <p className="text-[10px] text-muted-foreground">
                            +{g.reviewLines.length - 8} more
                          </p>
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
    </Dialog>
  );
}
