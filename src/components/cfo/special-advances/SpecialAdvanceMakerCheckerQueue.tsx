import { useState } from 'react';
import { Clock, ShieldCheck, CheckCircle2, XCircle, ArrowDownLeft, FileText, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { kampalaLabel } from '@/lib/kampalaDays';
import {
  CORRECTION_KIND_LABEL,
  correctionActions,
  isMissingServerFunction,
  describeSpecialAdvanceError,
  type CorrectionDecision,
} from '@/lib/specialAdvances';
import {
  useSpecialAdvanceCorrections,
  useSpecialAdvanceProvisionReviews,
  useSpecialAdvanceWriteOffs,
} from '@/hooks/useSpecialAdvances';
import { useSafeAuth } from '@/components/auth/useSafeAuth';
import { SpecialAdvanceProofLink } from './SpecialAdvanceProofInput';
import { SpecialAdvanceDecideDialog } from './SpecialAdvanceDecideDialog';

export function SpecialAdvanceMakerCheckerQueue({ onOpenAdvance }: { onOpenAdvance?: (id: string) => void }) {
  const { user } = useSafeAuth();
  const currentUserId = user?.id;

  const correctionsQuery = useSpecialAdvanceCorrections('pending');
  const provisionsQuery = useSpecialAdvanceProvisionReviews('pending');
  const writeOffsQuery = useSpecialAdvanceWriteOffs('pending');

  const [dialogTarget, setDialogTarget] = useState<{
    type: 'correction' | 'provision_review' | 'write_off';
    id: string;
    reference: string;
    decision: CorrectionDecision;
  } | null>(null);

  // Check if any queries failed due to pending backend functions
  const isCorrectionsMissing = isMissingServerFunction(correctionsQuery.error);
  const isProvisionsMissing = isMissingServerFunction(provisionsQuery.error);
  const isWriteOffsMissing = isMissingServerFunction(writeOffsQuery.error);

  const corrections = correctionsQuery.data ?? [];
  const provisions = provisionsQuery.data ?? [];
  const writeOffs = writeOffsQuery.data ?? [];

  const totalPending = corrections.length + provisions.length + writeOffs.length;
  const isLoading = correctionsQuery.isLoading || provisionsQuery.isLoading || writeOffsQuery.isLoading;

  return (
    <div className="space-y-4">
      {/* Notice if any Phase B/C functions are pending deployment */}
      {(isCorrectionsMissing || isProvisionsMissing || isWriteOffsMissing) && (
        <div className="rounded-xl border border-muted bg-muted/20 p-3 text-xs text-muted-foreground flex items-center gap-2">
          <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>
            Some approval queues (Phase B/C) are not available yet on this database and will activate once deployed.
          </span>
        </div>
      )}

      {isLoading && (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-xs text-muted-foreground">
          Loading approval queue...
        </div>
      )}

      {!isLoading && totalPending === 0 && (
        <div className="rounded-xl border border-border bg-card p-10 text-center text-xs space-y-2">
          <ShieldCheck className="mx-auto h-8 w-8 text-muted-foreground/60" />
          <p className="font-medium text-foreground">Nothing awaiting a second CFO</p>
          <p className="text-muted-foreground">
            All submitted corrections, provision reviews and write-offs have been processed.
          </p>
        </div>
      )}

      {/* 1. Pending Corrections */}
      {corrections.length > 0 && (
        <section className="rounded-xl border border-border bg-card overflow-hidden" aria-label="Pending Corrections">
          <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-foreground">Corrections</h4>
              <Badge variant="outline" className="text-[10px] h-5">{corrections.length}</Badge>
            </div>
            <span className="text-[11px] text-muted-foreground">Two-CFO maker-checker</span>
          </div>

          <div className="divide-y divide-border/60">
            {corrections.map((c) => {
              const actions = correctionActions(c, currentUserId);
              return (
                <div key={c.id} className="p-4 space-y-3 text-xs">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-primary">{c.reference}</span>
                        <Badge variant="secondary" className="text-[10px]">
                          {CORRECTION_KIND_LABEL[c.kind] ?? c.kind}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground text-[11px] mt-0.5">
                        Advance:{' '}
                        <button
                          type="button"
                          className="font-mono text-primary hover:underline"
                          onClick={() => onOpenAdvance?.(c.advance_id)}
                        >
                          {c.advance_reference}
                        </button>
                        {c.repayment && ` · Repayment ref: ${c.repayment.reference}`}
                      </p>
                    </div>

                    <div className="text-right">
                      <span className="text-sm font-bold tabular-nums text-foreground">
                        {formatUGX(c.amount)}
                      </span>
                      <p className="text-[10px] text-muted-foreground">
                        Requested by {c.requested_by_name ?? 'CFO'} · {kampalaLabel(c.requested_at)}
                      </p>
                    </div>
                  </div>

                  <div className="rounded-lg bg-muted/40 p-2.5 text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">Reason: </span>
                    <span>“{c.reason}”</span>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <SpecialAdvanceProofLink path={c.proof_path} label="View attached proof" />

                    <div className="flex items-center gap-2">
                      {actions.includes('approve') && (
                        <Button
                          size="sm"
                          className="h-8 text-xs font-semibold"
                          onClick={() => setDialogTarget({ type: 'correction', id: c.id, reference: c.reference, decision: 'approve' })}
                        >
                          Approve
                        </Button>
                      )}
                      {actions.includes('reject') && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs font-semibold text-destructive hover:bg-destructive/10"
                          onClick={() => setDialogTarget({ type: 'correction', id: c.id, reference: c.reference, decision: 'reject' })}
                        >
                          Reject
                        </Button>
                      )}
                      {actions.includes('withdraw') && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs font-semibold"
                          onClick={() => setDialogTarget({ type: 'correction', id: c.id, reference: c.reference, decision: 'withdraw' })}
                        >
                          Withdraw
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 2. Pending Provision Reviews */}
      {provisions.length > 0 && (
        <section className="rounded-xl border border-border bg-card overflow-hidden" aria-label="Pending Provision Reviews">
          <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-foreground">Provision Reviews</h4>
              <Badge variant="outline" className="text-[10px] h-5">{provisions.length}</Badge>
            </div>
            <span className="text-[11px] text-muted-foreground">Phase C Impairment</span>
          </div>

          <div className="divide-y divide-border/60">
            {provisions.map((p) => {
              const actions = correctionActions(p, currentUserId);
              return (
                <div key={p.id} className="p-4 space-y-3 text-xs">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <span className="font-mono font-bold text-primary">{p.reference}</span>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        As of date: {p.as_of_date} · Lines: {p.lines?.length ?? 0}
                      </p>
                    </div>

                    <div className="text-right">
                      <span className={`text-sm font-bold tabular-nums ${p.total_delta >= 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                        {p.total_delta >= 0 ? `+${formatUGX(p.total_delta)}` : formatUGX(p.total_delta)}
                      </span>
                      <p className="text-[10px] text-muted-foreground">
                        Requested by {p.requested_by_name ?? 'CFO'} · {kampalaLabel(p.requested_at)}
                      </p>
                    </div>
                  </div>

                  {p.note && (
                    <div className="rounded-lg bg-muted/40 p-2 text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground">Note: </span>
                      <span>“{p.note}”</span>
                    </div>
                  )}

                  {/* Summary of lines */}
                  {p.lines && p.lines.length > 0 && (
                    <div className="overflow-x-auto rounded-lg border border-border/60">
                      <table className="w-full text-[11px]">
                        <thead className="bg-muted/30 text-muted-foreground text-[10px]">
                          <tr>
                            <th className="px-2 py-1 text-left">Advance</th>
                            <th className="px-2 py-1 text-right">Gross</th>
                            <th className="px-2 py-1 text-right">DPD</th>
                            <th className="px-2 py-1 text-right">Rate</th>
                            <th className="px-2 py-1 text-right">Required</th>
                            <th className="px-2 py-1 text-right">Held</th>
                            <th className="px-2 py-1 text-right">Change</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/40 tabular-nums">
                          {p.lines.map((l, idx) => (
                            <tr key={idx}>
                              <td className="px-2 py-1 font-mono text-primary">{l.reference ?? l.advance_id.slice(0, 8)}</td>
                              <td className="px-2 py-1 text-right">{formatUGX(l.gross_outstanding)}</td>
                              <td className="px-2 py-1 text-right">{l.days_past_due}d</td>
                              <td className="px-2 py-1 text-right">{l.applied_rate}%</td>
                              <td className="px-2 py-1 text-right">{formatUGX(l.required_allowance)}</td>
                              <td className="px-2 py-1 text-right">{formatUGX(l.held_before)}</td>
                              <td className={`px-2 py-1 text-right font-medium ${l.delta >= 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                                {l.delta >= 0 ? `+${formatUGX(l.delta)}` : formatUGX(l.delta)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="flex justify-end gap-2 pt-1">
                    {actions.includes('approve') && (
                      <Button
                        size="sm"
                        className="h-8 text-xs font-semibold"
                        onClick={() => setDialogTarget({ type: 'provision_review', id: p.id, reference: p.reference, decision: 'approve' })}
                      >
                        Approve review
                      </Button>
                    )}
                    {actions.includes('reject') && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs font-semibold text-destructive hover:bg-destructive/10"
                        onClick={() => setDialogTarget({ type: 'provision_review', id: p.id, reference: p.reference, decision: 'reject' })}
                      >
                        Reject review
                      </Button>
                    )}
                    {actions.includes('withdraw') && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs font-semibold"
                        onClick={() => setDialogTarget({ type: 'provision_review', id: p.id, reference: p.reference, decision: 'withdraw' })}
                      >
                        Withdraw
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 3. Pending Write-offs */}
      {writeOffs.length > 0 && (
        <section className="rounded-xl border border-border bg-card overflow-hidden" aria-label="Pending Write-offs">
          <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-foreground">Write-offs</h4>
              <Badge variant="outline" className="text-[10px] h-5">{writeOffs.length}</Badge>
            </div>
            <span className="text-[11px] text-muted-foreground">Terminal balance write-off</span>
          </div>

          <div className="divide-y divide-border/60">
            {writeOffs.map((w) => {
              const actions = correctionActions(w, currentUserId);
              return (
                <div key={w.id} className="p-4 space-y-3 text-xs">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <span className="font-mono font-bold text-primary">{w.reference}</span>
                      <p className="text-muted-foreground text-[11px] mt-0.5">
                        Advance:{' '}
                        <button
                          type="button"
                          className="font-mono text-primary hover:underline"
                          onClick={() => onOpenAdvance?.(w.advance_id)}
                        >
                          {w.advance_reference}
                        </button>
                      </p>
                    </div>

                    <div className="text-right">
                      <span className="text-sm font-bold tabular-nums text-destructive">
                        {formatUGX(w.gross_amount)}
                      </span>
                      <p className="text-[10px] text-muted-foreground">
                        Allowance released: {formatUGX(w.allowance_released)} · Net loss: {formatUGX(w.net_loss)}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        Requested by {w.requested_by_name ?? 'CFO'} · {kampalaLabel(w.requested_at)}
                      </p>
                    </div>
                  </div>

                  <div className="rounded-lg bg-muted/40 p-2.5 text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">Reason: </span>
                    <span>“{w.reason}”</span>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <SpecialAdvanceProofLink path={w.proof_path} label="View attached evidence" />

                    <div className="flex items-center gap-2">
                      {actions.includes('approve') && (
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-8 text-xs font-semibold"
                          onClick={() => setDialogTarget({ type: 'write_off', id: w.id, reference: w.reference, decision: 'approve' })}
                        >
                          Approve write-off
                        </Button>
                      )}
                      {actions.includes('reject') && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs font-semibold"
                          onClick={() => setDialogTarget({ type: 'write_off', id: w.id, reference: w.reference, decision: 'reject' })}
                        >
                          Reject
                        </Button>
                      )}
                      {actions.includes('withdraw') && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs font-semibold"
                          onClick={() => setDialogTarget({ type: 'write_off', id: w.id, reference: w.reference, decision: 'withdraw' })}
                        >
                          Withdraw
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <SpecialAdvanceDecideDialog
        open={!!dialogTarget}
        onOpenChange={(o) => { if (!o) setDialogTarget(null); }}
        target={dialogTarget}
      />
    </div>
  );
}

export default SpecialAdvanceMakerCheckerQueue;
