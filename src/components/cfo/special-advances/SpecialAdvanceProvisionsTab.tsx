import { useState, useMemo, useRef } from 'react';
import { Loader2, Info, AlertTriangle, ShieldCheck, HelpCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import {
  IMPAIRMENT_MINIMUMS,
  buildProvisionReviewRequest,
  describeSpecialAdvanceError,
  isMissingServerFunction,
  newIdempotencyKey,
} from '@/lib/specialAdvances';
import {
  useSpecialAdvanceProvisionPreview,
  usePostProvisionReview,
} from '@/hooks/useSpecialAdvances';

export function SpecialAdvanceProvisionsTab() {
  const [individualRates, setIndividualRates] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const idempotencyKey = useRef(newIdempotencyKey());
  const postProvisionReview = usePostProvisionReview();

  const previewReq = useMemo(() => ({
    individual_rates: individualRates,
  }), [individualRates]);

  const previewQuery = useSpecialAdvanceProvisionPreview(previewReq);
  const preview = previewQuery.data;
  const isMissing = isMissingServerFunction(previewQuery.error);

  const handleRateChange = (advanceId: string, value: string) => {
    const num = Number(value.replace(/[^0-9]/g, ''));
    setIndividualRates((prev) => {
      const next = { ...prev };
      if (!value || num === 0) {
        delete next[advanceId];
      } else {
        next[advanceId] = num;
      }
      return next;
    });
    idempotencyKey.current = newIdempotencyKey();
  };

  const executeSubmit = async () => {
    const payload = buildProvisionReviewRequest({
      individualRates,
      note: note.trim() || null,
      idempotencyKey: idempotencyKey.current,
      // the preview total the CFO saw: the server posts nothing if balances moved since (PROVISION_REVIEW_STALE)
      expectedTotalDelta: preview?.total_delta,
    });

    const res = await postProvisionReview.mutateAsync(payload);
    idempotencyKey.current = newIdempotencyKey();
    toast.success(`Provision review ${res.reference} posted`);
    setNote('');
    setIndividualRates({});
    previewQuery.refetch();
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await executeSubmit();
    } catch (err) {
      setError(describeSpecialAdvanceError(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (isMissing) {
    return (
      <div className="rounded-xl border border-muted bg-card p-10 text-center text-xs space-y-2">
        <Info className="mx-auto h-7 w-7 text-muted-foreground/60" />
        <p className="font-semibold text-foreground">Impairment Provisions (Phase C)</p>
        <p className="text-muted-foreground">
          Special Advances impairment provisions and allowance accounting (Account A25) are not available yet on this
          database. They will activate once Phase C migrations are applied.
        </p>
      </div>
    );
  }

  const lines = preview?.lines ?? [];

  return (
    <div className="space-y-4">
      {/* Impairment Guidelines Card — Flagged as Draft / Pending CFO Approval */}
      <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs space-y-3" aria-label="Impairment Provision Guidelines">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <h4 className="font-semibold text-foreground">Proposed Impairment Assessment Guidelines</h4>
            <Badge variant="outline" className="border-amber-600/30 text-amber-700 dark:text-amber-400 bg-amber-500/10 text-[10px]">
              Draft — Requires CFO Policy Approval
            </Badge>
          </div>
          <span className="text-[11px] text-muted-foreground font-mono">Contra-asset A25 / Expense X4</span>
        </div>
        <p className="text-muted-foreground text-[11px]">
          The thresholds below are draft technical minimums subject to formal CFO executive approval. The server models required allowances according to days past due. A CFO may specify a higher individual assessment rate per advance (never below minimum). All figures and ledger entries are calculated by the server upon second-CFO approval.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-1">
          {IMPAIRMENT_MINIMUMS.map((m) => (
            <div key={m.label} className="rounded-lg border border-border/60 bg-card/80 p-2 text-center">
              <span className="block text-[10px] text-muted-foreground">{m.label}</span>
              <span className="text-xs font-bold text-foreground">{m.rate}%</span>
            </div>
          ))}
        </div>
      </section>

      {/* Provision Lines Preview Table */}
      <section className="rounded-xl border border-border bg-card overflow-hidden" aria-label="Provision Review Preview">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 p-4">
          <div>
            <h4 className="text-sm font-semibold text-foreground">Active Advance Portfolios</h4>
            <p className="text-[11px] text-muted-foreground">
              As of date: {preview?.as_of_date ?? 'Today'} · Total held before: {formatUGX(preview?.allowance_held ?? 0)}
            </p>
          </div>
          {preview && (
            <div className="text-right">
              <span className="text-xs text-muted-foreground block">Proposed net change:</span>
              <span className={`text-base font-bold tabular-nums ${preview.total_delta >= 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                {preview.total_delta >= 0 ? `+${formatUGX(preview.total_delta)}` : formatUGX(preview.total_delta)}
              </span>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-[11px] text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Reference</th>
                <th className="px-3 py-2 text-right font-medium">Gross balance</th>
                <th className="px-3 py-2 text-right font-medium">Days past due</th>
                <th className="px-3 py-2 text-right font-medium">Min rate</th>
                <th className="px-3 py-2 text-right font-medium">Individual rate</th>
                <th className="px-3 py-2 text-right font-medium">Applied</th>
                <th className="px-3 py-2 text-right font-medium">Required</th>
                <th className="px-3 py-2 text-right font-medium">Held</th>
                <th className="px-3 py-2 text-right font-medium">Net delta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50 tabular-nums">
              {previewQuery.isLoading && (
                <tr><td colSpan={9} className="py-8 text-center text-muted-foreground">Loading server preview...</td></tr>
              )}
              {previewQuery.isError && !isMissing && (
                <tr>
                  <td colSpan={9} role="alert" className="py-8 text-center text-destructive">
                    {describeSpecialAdvanceError(previewQuery.error)}
                  </td>
                </tr>
              )}
              {!previewQuery.isLoading && !previewQuery.isError && lines.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-muted-foreground">
                    No active paid-out Special Advances to review.
                  </td>
                </tr>
              )}
              {lines.map((l) => {
                const advanceKey = l.advance_id;
                const currentIndividual = individualRates[advanceKey] ?? '';
                return (
                  <tr key={l.advance_id} className="hover:bg-muted/20">
                    <td className="px-3 py-2 font-mono font-medium text-primary">
                      {l.reference ?? l.advance_id.slice(0, 8)}
                    </td>
                    <td className="px-3 py-2 text-right">{formatUGX(l.gross_outstanding)}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={l.days_past_due > 0 ? 'text-amber-600 font-semibold' : 'text-muted-foreground'}>
                        {l.days_past_due}d
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{l.minimum_rate}%</td>
                    <td className="px-3 py-2 text-right">
                      <Input
                        type="text"
                        inputMode="numeric"
                        placeholder={`${l.minimum_rate}`}
                        className="h-7 w-16 text-right text-xs inline-block"
                        value={currentIndividual}
                        onChange={(e) => handleRateChange(advanceKey, e.target.value)}
                        disabled={submitting}
                        title="Enter higher assessment rate, or 0 / clear to revert to minimum"
                      />
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-foreground">{l.applied_rate}%</td>
                    <td className="px-3 py-2 text-right font-medium">{formatUGX(l.required_allowance)}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{formatUGX(l.held_before)}</td>
                    <td className={`px-3 py-2 text-right font-bold ${l.delta >= 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                      {l.delta >= 0 ? `+${formatUGX(l.delta)}` : formatUGX(l.delta)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Submission Controls */}
        {lines.length > 0 && (
          <div className="border-t border-border/60 p-4 space-y-3 bg-muted/10">
            <div className="space-y-1.5 text-xs">
              <Label htmlFor="provision-review-note" className="font-medium">
                Review justification note (optional)
              </Label>
              <Textarea
                id="provision-review-note"
                rows={2}
                placeholder="Details of collective or individual assessment..."
                maxLength={1000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={submitting}
              />
            </div>

            {error && <p role="alert" className="text-xs text-destructive font-medium">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button
                id="provision-request-submit"
                size="sm"
                disabled={submitting || !preview || previewQuery.isFetching}
                onClick={() => void handleSubmit()}
              >
                {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Post provision review
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default SpecialAdvanceProvisionsTab;
