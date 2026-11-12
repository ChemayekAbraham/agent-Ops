import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2, AlertCircle, RotateCcw, AlertTriangle, PlusCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { kampalaLabel, kampalaTodayYmd } from '@/lib/kampalaDays';
import { rateLabel } from '@/lib/specialAdvancePreview';
import {
  STATUS_LABEL,
  CORRECTION_KIND_LABEL,
  combinedAccessFee,
  describeSpecialAdvanceError,
  newIdempotencyKey,
  type SpecialAdvanceStatement,
  type CorrectionKind,
} from '@/lib/specialAdvances';
import {
  useDisburseSpecialAdvance,
  useRecordSpecialAdvanceRepayment,
  useSpecialAdvanceDecision,
  useSpecialAdvanceStatement,
  uploadSpecialAdvanceProof,
} from '@/hooks/useSpecialAdvances';
import { SpecialAdvanceProofInput, SpecialAdvanceProofLink } from './SpecialAdvanceProofInput';
import { SpecialAdvanceCorrectionDialog } from './SpecialAdvanceCorrectionDialog';
import { SpecialAdvanceWriteOffDialog } from './SpecialAdvanceWriteOffDialog';
import { SpecialAdvanceTopUpDialog } from './SpecialAdvanceTopUpDialog';
import { SpecialAdvanceRecoveryForm } from './SpecialAdvanceRecoveryForm';

const EVENT_TEXT: Record<string, string> = {
  created: 'Recorded',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  disbursed: 'Paid out',
  settled: 'Settled',
  reopened: 'Reopened by correction',
  reversed: 'Payout reversed by correction',
  correction_posted: 'Correction posted',
  written_off: 'Written off',
  write_off_posted: 'Write-off posted',
  provision_posted: 'Provision posted',
  recovery_recorded: 'Recovery recorded',
  topup_posted: 'Top-up added and paid out',
};

const INSTALMENT_TEXT: Record<string, string> = {
  paid: 'Paid',
  not_due: 'Not paid out',
  overdue: 'Overdue',
  part_paid: 'Part paid',
  due: 'Due',
};

export type SpecialAdvanceSheetAction = 'repay' | 'topup' | 'reverse' | null;

export function SpecialAdvanceDetailSheet({
  advanceId,
  issuanceEnabled,
  initialAction = null,
  onOpenChange,
}: {
  advanceId: string | null;
  issuanceEnabled: boolean;
  /** Action picked from the table's overflow menu; opens that step once the advance loads. */
  initialAction?: SpecialAdvanceSheetAction;
  onOpenChange: (open: boolean) => void;
}) {
  const st = useSpecialAdvanceStatement(advanceId);
  const a = st.data;

  // Dialog state for reversals
  const [correctionTarget, setCorrectionTarget] = useState<{
    kind: CorrectionKind;
    repaymentId?: string | null;
    amount?: number;
    reference?: string;
    topupId?: string;
    topupWallet?: boolean;
  } | null>(null);

  // Dialog state for write-off
  const [writeOffOpen, setWriteOffOpen] = useState(false);
  // Dialog state for a top-up (CFO, 12 Nov 2026)
  const [topUpOpen, setTopUpOpen] = useState(false);

  // Active repayments (not reversed)
  const standingRepayments = a?.repayments.filter((r) => !r.reversed_by_correction) ?? [];
  const canReversePayout = a?.status === 'disbursed' && a.borrower_kind === 'external' && standingRepayments.length === 0;
  const canWriteOff = a?.status === 'disbursed' && a.position.outstanding > 0;

  // Run the menu action once per opening, after the statement has loaded.
  const handledAction = useRef<string | null>(null);
  useEffect(() => {
    if (!advanceId) { handledAction.current = null; return; }
    if (!a || !initialAction) return;
    const key = `${advanceId}:${initialAction}`;
    if (handledAction.current === key) return;
    handledAction.current = key;
    if (a.status !== 'disbursed') {
      if (initialAction !== 'repay') toast.error('Only a paid-out advance can be topped up or reversed.');
      return;
    }
    if (initialAction === 'topup') setTopUpOpen(true);
    else if (initialAction === 'reverse') {
      if (canReversePayout) setCorrectionTarget({ kind: 'payout_reversal' });
      else toast.error('This payout can be reversed only for an external recipient with no standing repayments. Reverse a repayment from the list below instead.');
    } else if (initialAction === 'repay') {
      document.getElementById('special-advance-repayment-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [advanceId, a, initialAction, canReversePayout]);

  return (
    <Sheet open={!!advanceId} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader className="text-left">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {a ? (
              <>
                <span className="font-mono text-sm text-primary">{a.reference}</span>
                <span>{a.borrower_name ?? 'Borrower'}</span>
              </>
            ) : (
              'Special Advance'
            )}
          </SheetTitle>
          <SheetDescription>
            {a
              ? `${STATUS_LABEL[a.status]} · ${a.borrower_kind === 'external' ? 'External borrower' : 'Welile account'}`
              : 'Loading...'}
          </SheetDescription>
        </SheetHeader>

        {st.isLoading && <p className="py-10 text-center text-xs text-muted-foreground">Loading...</p>}
        {st.isError && (
          <p role="alert" className="py-10 text-center text-xs text-destructive">
            {describeSpecialAdvanceError(st.error)}
          </p>
        )}

        {a && (
          <div className="mt-5 space-y-6 text-xs">
            {/* Financial Terms & Position */}
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
              <Item label="Agreed rate" value={rateLabel(a.rate_percent, a.rate_basis)} />
              <Item label="Term" value={`${a.term_days} days, ${a.frequency} repayments`} />
              <Item label="Principal" value={formatUGX(a.principal)} />
              <Item label="Access fee" value={formatUGX(combinedAccessFee(a))} />
              {a.topups?.some((t) => !t.reversed_by_correction) ? (
                <Item label="Total repayable (incl. top-ups)" value={formatUGX(a.position.total_repayable)} />
              ) : (
                <Item label="Total repayable" value={formatUGX(a.total_repayable)} />
              )}
              <Item label="Paid" value={formatUGX(a.position.total_paid)} />

              {/* Phase A: Receivable only after payout */}
              {a.position.paid_out === false ? (
                <Item
                  label="Repayable after payout"
                  value={formatUGX(a.position.scheduled_outstanding ?? a.total_repayable)}
                />
              ) : (
                <Item label="Outstanding" value={formatUGX(a.position.outstanding)} />
              )}

              {/* Phase C: Allowance held if returned */}
              {a.allowance_held !== undefined && (
                <Item label="Impairment allowance held" value={formatUGX(a.allowance_held)} />
              )}

              {a.position.overdue_amount > 0 && (
                <Item
                  label="Overdue"
                  value={`${formatUGX(a.position.overdue_amount)} (${a.position.overdue_instalments} instalment${a.position.overdue_instalments === 1 ? '' : 's'})`}
                />
              )}

              {a.payout_date && (
                <div className="col-span-2 flex items-center justify-between gap-2 border-t border-border/40 pt-1">
                  <div>
                    <dt className="text-[11px] text-muted-foreground">Payout record</dt>
                    <dd className="mt-0.5 font-medium text-foreground">
                      {kampalaLabel(a.payout_date)} · {a.payout_method === 'wallet' ? 'Credited to Welile wallet' : `${a.payout_method?.replace('_', ' ')} (${a.payout_reference ?? 'no ref'})`}
                    </dd>
                  </div>
                  {a.payout_proof_path && (
                    <SpecialAdvanceProofLink path={a.payout_proof_path} label="View payout proof" />
                  )}
                </div>
              )}

              {(a.topups?.length ?? 0) > 0 && (
                <div className="col-span-2 space-y-1 border-t border-border/40 pt-1">
                  <dt className="text-[11px] text-muted-foreground">Top-ups (included in Outstanding)</dt>
                  {a.topups!.map((t) => (
                    <dd key={t.id} className="flex flex-wrap items-center justify-between gap-2 font-medium text-foreground">
                      <span className={t.reversed_by_correction ? 'text-muted-foreground line-through' : undefined}>
                        <span className="font-mono">{t.reference}</span> · {kampalaLabel(t.topup_date)} · {formatUGX(t.principal)} + fee {formatUGX(t.access_fee)}
                        {' · '}{t.payout_method === 'wallet' ? 'credited to wallet' : `${t.payout_method.replace('_', ' ')} (${t.payout_reference})`}
                      </span>
                      {t.payout_proof_path && <SpecialAdvanceProofLink path={t.payout_proof_path} label="View proof" />}
                      {t.reversed_by_correction ? (
                        <span className="text-[11px] font-normal text-muted-foreground">Reversed</span>
                      ) : a.status === 'disbursed' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px] text-destructive hover:bg-destructive/10"
                          aria-label={`Reverse top-up ${t.reference}`}
                          onClick={() => setCorrectionTarget({ kind: 'topup_reversal', topupId: t.id, amount: t.principal, reference: t.reference,
                            topupWallet: t.payout_method === 'wallet' })}
                        >
                          <RotateCcw className="mr-1 h-3 w-3" /> Reverse
                        </Button>
                      )}
                      <span className="w-full text-[11px] font-normal text-muted-foreground">{t.reason}</span>
                    </dd>
                  ))}
                </div>
              )}

              <Item label="Purpose" value={a.purpose} wide />
              {a.decision_reason && <Item label="Decision note" value={a.decision_reason} wide />}
            </dl>

            {/* Actions Section */}
            <section id="special-advance-actions" className="space-y-3 rounded-xl border border-border p-3">
              {!issuanceEnabled && (a.status === 'pending_approval' || a.status === 'approved') && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                  Issuance is switched off on the server: approval and payout are disabled.
                </p>
              )}

              {/* Status: pending_approval */}
              {a.status === 'pending_approval' && (
                <DecisionForm advance={a} issuanceEnabled={issuanceEnabled} allowApprove />
              )}

              {/* Status: approved */}
              {a.status === 'approved' && (
                <>
                  <PayoutForm advance={a} issuanceEnabled={issuanceEnabled} />
                  <DecisionForm advance={a} issuanceEnabled={issuanceEnabled} allowApprove={false} />
                </>
              )}

              {/* Status: disbursed */}
              {a.status === 'disbursed' && (
                <>
                  <div id="special-advance-repayment-form">
                    <RepaymentForm advance={a} />
                  </div>

                  <div className="flex flex-wrap gap-2 pt-2 border-t border-border/60">
                    <Button
                      id="special-advance-add-topup"
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      onClick={() => setTopUpOpen(true)}
                    >
                      <PlusCircle className="mr-1.5 h-3.5 w-3.5" />
                      Add top-up
                    </Button>

                    {canReversePayout && (
                      <Button
                        id="special-advance-reverse-payout"
                        size="sm"
                        variant="outline"
                        className="text-xs"
                        onClick={() => setCorrectionTarget({ kind: 'payout_reversal' })}
                      >
                        <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                        Reverse the payout
                      </Button>
                    )}

                    {canWriteOff && (
                      <Button
                        id="special-advance-write-off-btn"
                        size="sm"
                        variant="outline"
                        className="text-xs text-destructive hover:bg-destructive/10"
                        onClick={() => setWriteOffOpen(true)}
                      >
                        <AlertTriangle className="mr-1.5 h-3.5 w-3.5" />
                        Request write-off
                      </Button>
                    )}
                  </div>
                </>
              )}

              {/* Status: written_off */}
              {a.status === 'written_off' && (
                <div className="space-y-3">
                  <div className="rounded-lg bg-muted/40 p-2.5 text-muted-foreground">
                    <p className="font-semibold text-foreground">Advance written off</p>
                    <p className="text-[11px]">
                      This advance has been written off. Recoveries may still be recorded.
                    </p>
                  </div>
                  <SpecialAdvanceRecoveryForm advance={a} onSuccess={() => st.refetch()} />
                </div>
              )}

              {/* Status: settled, reversed, rejected, cancelled */}
              {['rejected', 'cancelled', 'settled', 'reversed'].includes(a.status) && (
                <p className="text-muted-foreground">
                  No further action: this advance is{' '}
                  <strong className="text-foreground">{STATUS_LABEL[a.status].toLowerCase()}</strong>.
                </p>
              )}
            </section>

            {/* Schedule Section */}
            <section>
              <h4 className="mb-2 text-sm font-semibold">Schedule</h4>
              <table className="w-full">
                <thead className="text-[10px] uppercase text-muted-foreground">
                  <tr>
                    <th className="py-1 text-left">#</th>
                    <th className="text-left">Due</th>
                    <th className="text-right">Amount</th>
                    <th className="text-right">Paid</th>
                    <th className="text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60 tabular-nums">
                  {a.position.instalments.map((i) => (
                    <tr key={i.number}>
                      <td className="py-1">{i.number}</td>
                      <td>{i.due_date ? kampalaLabel(i.due_date) : '—'}</td>
                      <td className="text-right">{formatUGX(i.amount)}</td>
                      <td className="text-right">{formatUGX(i.paid)}</td>
                      <td className={`text-right ${i.status === 'overdue' ? 'font-semibold text-destructive' : ''}`}>
                        {INSTALMENT_TEXT[i.status] ?? i.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {/* Repayments Section */}
            {a.repayments.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-sm font-semibold">Repayments</h4>
                <ul className="space-y-2">
                  {a.repayments.map((r) => {
                    const isReversed = !!r.reversed_by_correction;
                    return (
                      <li
                        key={r.id}
                        className={`rounded-lg border border-border/60 p-2.5 space-y-1.5 ${isReversed ? 'bg-muted/20 opacity-70' : 'bg-card'}`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className={isReversed ? 'line-through text-muted-foreground' : 'font-medium'}>
                            {kampalaLabel(r.received_date)} · {r.method.replace('_', ' ')} · {r.reference}
                            {isReversed && (
                              <Badge variant="outline" className="ml-2 text-[10px] text-destructive border-destructive/30">
                                Reversed ({r.reversed_by_correction})
                              </Badge>
                            )}
                          </span>
                          <span className={`font-mono font-semibold ${isReversed ? 'line-through text-muted-foreground' : ''}`}>
                            {formatUGX(r.amount)}
                          </span>
                        </div>

                        <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/40 text-[11px]">
                          {r.proof_path ? (
                            <SpecialAdvanceProofLink path={r.proof_path} label="View proof" />
                          ) : (
                            <span className="text-muted-foreground">No proof file attached</span>
                          )}

                          {!isReversed && (a.status === 'disbursed' || a.status === 'settled') && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive gap-1"
                              onClick={() =>
                                setCorrectionTarget({
                                  kind: 'repayment_reversal',
                                  repaymentId: r.id,
                                  amount: r.amount,
                                  reference: r.reference,
                                })
                              }
                            >
                              <RotateCcw className="h-3 w-3" />
                              Reverse this repayment
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {/* Corrections History (Phase B) */}
            {a.corrections && a.corrections.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-sm font-semibold">Corrections History</h4>
                <div className="divide-y divide-border/60 rounded-xl border border-border bg-card">
                  {a.corrections.map((c) => (
                    <div key={c.id} className="p-3 space-y-1.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-primary">{c.reference}</span>
                          <Badge variant="outline" className="text-[10px]">
                            {CORRECTION_KIND_LABEL[c.kind] ?? c.kind}
                          </Badge>
                        </div>
                        <Badge variant="default" className="text-[10px]">
                          Posted
                        </Badge>
                      </div>
                      <p className="text-muted-foreground text-[11px]">
                        Amount: <strong className="text-foreground">{formatUGX(c.amount)}</strong> · Posted by {c.recorded_by_name ?? 'CFO'} on {kampalaLabel(c.recorded_at)}
                      </p>
                      <p className="italic text-muted-foreground text-[11px]">“{c.reason}”</p>
                      {c.proof_path && <SpecialAdvanceProofLink path={c.proof_path} label="View correction proof" />}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Write-offs History (Phase C) */}
            {a.write_offs && a.write_offs.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-sm font-semibold">Write-offs</h4>
                <div className="divide-y divide-border/60 rounded-xl border border-border bg-card">
                  {a.write_offs.map((w) => (
                    <div key={w.id} className="p-3 space-y-1 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-bold text-primary">{w.reference}</span>
                        <Badge variant="destructive" className="text-[10px]">
                          Posted
                        </Badge>
                      </div>
                      <p className="text-muted-foreground text-[11px]">
                        Gross: {formatUGX(w.gross_amount)} · Allowance released: {formatUGX(w.allowance_released)} · Net loss: {formatUGX(w.net_loss)}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        Posted by {w.recorded_by_name ?? 'CFO'} on {kampalaLabel(w.recorded_at)}
                      </p>
                      <p className="italic text-muted-foreground text-[11px]">“{w.reason}”</p>
                      {w.proof_path && <SpecialAdvanceProofLink path={w.proof_path} label="View evidence" />}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Recoveries History (Phase C) */}
            {a.recoveries && a.recoveries.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-sm font-semibold">Recoveries</h4>
                <ul className="space-y-1.5">
                  {a.recoveries.map((rc) => (
                    <li key={rc.id} className="flex items-center justify-between rounded-lg border border-border/60 p-2.5">
                      <div>
                        <p className="font-medium">
                          {kampalaLabel(rc.received_date)} · {rc.method.replace('_', ' ')} · {rc.reference}
                        </p>
                        {rc.note && <p className="text-[10px] text-muted-foreground italic">“{rc.note}”</p>}
                      </div>
                      <div className="text-right">
                        <span className="font-mono font-bold text-emerald-600">+{formatUGX(rc.amount)}</span>
                        {rc.proof_path && <SpecialAdvanceProofLink path={rc.proof_path} label="View proof" />}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Provision History (Phase C) */}
            {a.provision_history && a.provision_history.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-sm font-semibold">Allowance & Provision History</h4>
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full text-[11px]">
                    <thead className="bg-muted/40 text-[10px] text-muted-foreground uppercase">
                      <tr>
                        <th className="px-2.5 py-1 text-left">Review</th>
                        <th className="px-2.5 py-1 text-right">Applied rate</th>
                        <th className="px-2.5 py-1 text-right">Required</th>
                        <th className="px-2.5 py-1 text-right">Change</th>
                        <th className="px-2.5 py-1 text-left">Posted</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60 tabular-nums">
                      {a.provision_history.map((ph, idx) => (
                        <tr key={idx}>
                          <td className="px-2.5 py-1 font-mono text-primary">{ph.review}</td>
                          <td className="px-2.5 py-1 text-right">{ph.applied_rate}%</td>
                          <td className="px-2.5 py-1 text-right">{formatUGX(ph.required_allowance)}</td>
                          <td className={`px-2.5 py-1 text-right font-medium ${ph.delta >= 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                            {ph.delta >= 0 ? `+${formatUGX(ph.delta)}` : formatUGX(ph.delta)}
                          </td>
                          <td className="px-2.5 py-1">{kampalaLabel(ph.recorded_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Audit History */}
            <section>
              <h4 className="mb-2 text-sm font-semibold">History</h4>
              <ol className="space-y-1">
                {(a.events ?? []).map((e, k) => (
                  <li key={k}>
                    <span className="font-medium">{EVENT_TEXT[e.event_type] ?? e.event_type}</span>
                    <span className="text-muted-foreground">
                      {' '}
                      · {new Date(e.created_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' })}
                      {e.actor_name ? ` · ${e.actor_name}` : ''}
                    </span>
                    {e.reason && <span className="block italic text-muted-foreground">“{e.reason}”</span>}
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </SheetContent>

      {/* Reversal dialog */}
      {a && correctionTarget && (
        <SpecialAdvanceCorrectionDialog
          open={!!correctionTarget}
          onOpenChange={(o) => { if (!o) setCorrectionTarget(null); }}
          advance={a}
          kind={correctionTarget.kind}
          repaymentId={correctionTarget.repaymentId}
          repaymentAmount={correctionTarget.amount}
          repaymentReference={correctionTarget.reference}
          topupId={correctionTarget.topupId}
          topupReference={correctionTarget.reference}
          topupAmount={correctionTarget.amount}
          topupWallet={correctionTarget.topupWallet}
          onSuccess={() => st.refetch()}
        />
      )}

      {/* Top-up dialog */}
      {a && a.status === 'disbursed' && (
        <SpecialAdvanceTopUpDialog open={topUpOpen} onOpenChange={setTopUpOpen} advance={a} onSuccess={() => st.refetch()} />
      )}

      {/* Write-off dialog */}
      {a && (
        <SpecialAdvanceWriteOffDialog
          open={writeOffOpen}
          onOpenChange={setWriteOffOpen}
          advance={a}
          onSuccess={() => st.refetch()}
        />
      )}
    </Sheet>
  );
}

function DecisionForm({
  advance,
  issuanceEnabled,
  allowApprove,
}: {
  advance: SpecialAdvanceStatement;
  issuanceEnabled: boolean;
  allowApprove: boolean;
}) {
  const decide = useSpecialAdvanceDecision();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reasonOk = note.trim().length >= 5;

  const runDecision = async (action: 'approve' | 'reject' | 'cancel') => {
    const r = await decide.mutateAsync({ action, advance, reason: note.trim() || null });
    toast.success(`${r.reference} ${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled'}`);
    setNote('');
  };

  const handleAction = async (action: 'approve' | 'reject' | 'cancel') => {
    setError(null);
    try {
      await runDecision(action);
    } catch (e) {
      setError(describeSpecialAdvanceError(e));
    }
  };

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`special-advance-note-${allowApprove ? 'pending' : 'approved'}`}>
          {allowApprove ? 'Decision note (required to reject or cancel)' : 'Reason to cancel before payout'}
        </Label>
        <Textarea
          id={`special-advance-note-${allowApprove ? 'pending' : 'approved'}`}
          rows={2}
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          {allowApprove && (
            <Button
              id="special-advance-approve"
              size="sm"
              disabled={!issuanceEnabled || decide.isPending}
              onClick={() => void handleAction('approve')}
            >
              Approve
            </Button>
          )}
          {allowApprove && (
            <Button
              id="special-advance-reject"
              size="sm"
              variant="outline"
              disabled={!reasonOk || decide.isPending}
              onClick={() => void handleAction('reject')}
            >
              Reject
            </Button>
          )}
          <Button
            id={`special-advance-cancel-${allowApprove ? 'pending' : 'approved'}`}
            size="sm"
            variant="outline"
            disabled={!reasonOk || decide.isPending}
            onClick={() => void handleAction('cancel')}
          >
            Cancel advance
          </Button>
        </div>
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </div>
    </>
  );
}

function PayoutForm({
  advance,
  issuanceEnabled,
}: {
  advance: SpecialAdvanceStatement;
  issuanceEnabled: boolean;
}) {
  const disburse = useDisburseSpecialAdvance();
  const external = advance.borrower_kind === 'external';
  const [date, setDate] = useState(kampalaTodayYmd());
  const [method, setMethod] = useState<'mobile_money' | 'bank_transfer'>('mobile_money');
  const [reference, setReference] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready =
    issuanceEnabled &&
    confirmed &&
    !!date &&
    (!external || reference.trim().length >= 3) &&
    !disburse.isPending;

  const executeDisburse = async (proofPathToUse: string | null) => {
    const r = await disburse.mutateAsync({
      advance,
      payout: external
        ? {
            payout_date: date,
            method,
            reference: reference.trim(),
            ...(proofPathToUse ? { proof_path: proofPathToUse } : {}),
          }
        : { payout_date: date, method: 'wallet' },
    });
    toast.success(`${r.reference} paid out`);
  };

  const handleRun = async () => {
    setError(null);
    let path = uploadedPath;
    try {
      if (external && !path && file) {
        path = await uploadSpecialAdvanceProof(advance.id, file);
        setUploadedPath(path);
      }
      await executeDisburse(path ?? null);
    } catch (e) {
      setError(describeSpecialAdvanceError(e));
    }
  };

  return (
    <>
      <div className="space-y-2">
        <h4 className="text-sm font-semibold">Record payout</h4>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label htmlFor="special-advance-payout-date">Payout date</Label>
            <Input
              id="special-advance-payout-date"
              type="date"
              max={kampalaTodayYmd()}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          {external ? (
            <div>
              <Label htmlFor="special-advance-payout-method">Paid by</Label>
              <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
                <SelectTrigger id="special-advance-payout-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mobile_money">Mobile money</SelectItem>
                  <SelectItem value="bank_transfer">Bank transfer</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : (
            <p className="self-end text-muted-foreground text-[11px]">
              Credited to the borrower's Welile wallet (withdrawable).
            </p>
          )}
        </div>

        {external && (
          <div>
            <Label htmlFor="special-advance-payout-reference">Transaction reference</Label>
            <Input
              id="special-advance-payout-reference"
              maxLength={100}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
        )}

        {external && (
          <SpecialAdvanceProofInput
            id="special-advance-payout-proof"
            label="Archived proof of external payout"
            file={file}
            onFileChange={(f) => {
              setFile(f);
              setUploadedPath(null);
            }}
            required
          />
        )}

        <label htmlFor="special-advance-payout-confirm" className="flex items-start gap-2 pt-1">
          <Checkbox
            id="special-advance-payout-confirm"
            checked={confirmed}
            onCheckedChange={(v) => setConfirmed(v === true)}
          />
          <span>
            I confirm {formatUGX(advance.principal)} is paid to {advance.borrower_name ?? 'the borrower'}
            {external ? ' off-platform with the reference above' : ' into their Welile wallet'}.
          </span>
        </label>

        <Button id="special-advance-payout" size="sm" disabled={!ready} onClick={() => void handleRun()}>
          {disburse.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Record payout
        </Button>
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </div>
    </>
  );
}

function RepaymentForm({ advance }: { advance: SpecialAdvanceStatement }) {
  const record = useRecordSpecialAdvanceRepayment();
  const key = useRef(newIdempotencyKey());

  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(kampalaTodayYmd());
  const [method, setMethod] = useState<'mobile_money' | 'bank_transfer'>('mobile_money');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const value = Number(amount) || 0;
  const outstanding = advance.position.outstanding;

  // Idempotency: new key only on changed inputs; unchanged retry reuses it
  useEffect(() => {
    key.current = newIdempotencyKey();
  }, [amount, date, method, reference]);

  const handleFileChange = (newFile: File | null) => {
    setFile(newFile);
    setUploadedPath(null);
    key.current = newIdempotencyKey();
  };

  const ready =
    value > 0 &&
    value <= outstanding &&
    !!date &&
    reference.trim().length >= 3 &&
    !record.isPending;

  const executeRepayment = async (proofPathToUse: string | null) => {
    await record.mutateAsync({
      advanceId: advance.id,
      repayment: {
        amount: value,
        received_date: date,
        method,
        reference: reference.trim(),
        note: note.trim() || null,
        idempotency_key: key.current,
        ...(proofPathToUse ? { proof_path: proofPathToUse } : {}),
      },
    });

    toast.success(`Repayment of ${formatUGX(value)} recorded`);
    setAmount('');
    setReference('');
    setNote('');
    setFile(null);
    setUploadedPath(null);
  };

  const handleRun = async () => {
    setError(null);
    let path = uploadedPath;
    try {
      if (!path && file) {
        path = await uploadSpecialAdvanceProof(advance.id, file);
        setUploadedPath(path);
      }
      await executeRepayment(path ?? null);
    } catch (e) {
      setError(describeSpecialAdvanceError(e));
    }
  };

  return (
    <>
      <div className="space-y-2">
        <h4 className="text-sm font-semibold">Record a repayment</h4>
        <p className="text-muted-foreground text-[11px]">
          Outstanding: <span className="font-mono">{formatUGX(outstanding)}</span>. Overpayments are not accepted; paying it all settles the advance.
        </p>

        <div className="grid grid-cols-2 gap-2">
          <Field id="special-advance-repay-amount" label="Amount (UGX)">
            <Input
              id="special-advance-repay-amount"
              inputMode="numeric"
              value={amount ? Number(amount).toLocaleString() : ''}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, '').slice(0, 12))}
            />
          </Field>
          <Field id="special-advance-repay-date" label="Date received">
            <Input
              id="special-advance-repay-date"
              type="date"
              max={kampalaTodayYmd()}
              min={advance.payout_date ?? undefined}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          <Field id="special-advance-repay-method" label="Received by">
            <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
              <SelectTrigger id="special-advance-repay-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mobile_money">Mobile money</SelectItem>
                <SelectItem value="bank_transfer">Bank transfer</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id="special-advance-repay-reference" label="Transaction reference">
            <Input
              id="special-advance-repay-reference"
              maxLength={100}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
        </div>

        <Field id="special-advance-repay-note" label="Note (optional)">
          <Textarea
            id="special-advance-repay-note"
            rows={2}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        <SpecialAdvanceProofInput
          id="special-advance-repay-proof"
          label="Archived proof of repayment"
          file={file}
          onFileChange={handleFileChange}
          required
        />

        {value > outstanding && <p className="text-destructive">That is more than is outstanding.</p>}

        <Button id="special-advance-repay" size="sm" disabled={!ready} onClick={() => void handleRun()}>
          {record.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Record repayment
        </Button>
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </div>
    </>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function Item({ label, value, wide }: { label: string; value: string | null; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : undefined}>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words font-medium">{value || '—'}</dd>
    </div>
  );
}

export default SpecialAdvanceDetailSheet;
