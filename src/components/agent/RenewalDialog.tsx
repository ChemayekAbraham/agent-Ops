import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle, CheckCircle2, ImagePlus, Info, Loader2, RefreshCw, TrendingDown, X } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import { optimizeImage } from '@/lib/imageOptimizer';
import { cn } from '@/lib/utils';
import {
  DEFAULT_MIN_EXPLANATION,
  RENEWAL_REASONS,
  parseRentInput,
  renewalChanged,
  renewalChoiceProblem,
  renewalErrorMessage,
  renewalHint,
  type RenewalChoice,
  type RenewalReasonCode,
} from '@/lib/renewalAdvice';
import { fetchRenewalAdvice, fetchRenewalPreview, useRenewalAdvice, useRenewalPreview } from '@/hooks/useRenewalAdvice';
import { useRenewalOtp } from './RenewalOtpDialog';

export interface RenewalTarget {
  /** the completed plan being renewed */
  prevId: string;
  tenantName: string;
  currentRent: number;
  currentDays: number;
}

const groupDigits = (n: number) => (Number.isFinite(n) ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '');

/**
 * Renew a completed Rent Plan: the agent chooses the new rent and number of days, sees the server's advice and daily payment,
 * gives a reason when something changed, and the tenant then confirms with a code that carries the same figures.
 * Resolves with the choice, or null when the agent or the tenant backs out. The caller then calls renew_rent_request with
 * renewRpcArgs(prevId, choice, gps).
 */
export function useRenewalFlow() {
  const otp = useRenewalOtp();
  const [target, setTarget] = useState<RenewalTarget | null>(null);
  const resolver = useRef<((c: RenewalChoice | null) => void) | null>(null);

  const start = useCallback(
    async (t: RenewalTarget): Promise<RenewalChoice | null> => {
      const choice = await new Promise<RenewalChoice | null>((resolve) => {
        resolver.current = resolve;
        setTarget(t);
      });
      setTarget(null);
      if (!choice) return null;
      const consented = await otp.requestConsent(t.prevId, t.tenantName, {
        newRent: choice.newRent,
        newDays: choice.newDays,
        dailyRepayment: choice.dailyRepayment,
      });
      return consented ? choice : null;
    },
    [otp.requestConsent],
  );

  const finish = useCallback((c: RenewalChoice | null) => {
    resolver.current?.(c);
    resolver.current = null;
  }, []);

  const dialogs = (
    <>
      <RenewalChoiceDialog target={target} onDone={finish} />
      {otp.dialog}
    </>
  );
  return { start, dialogs };
}

interface DialogProps {
  target: RenewalTarget | null;
  onDone: (choice: RenewalChoice | null) => void;
}

export function RenewalChoiceDialog({ target, onDone }: DialogProps) {
  const { user } = useAuth();
  const open = !!target;
  const prevId = target?.prevId ?? null;

  const [rentText, setRentText] = useState('');
  const [days, setDays] = useState<number | null>(null);
  const [reason, setReason] = useState<RenewalReasonCode | null>(null);
  const [explanation, setExplanation] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState<string | null>(null);
  const [evidencePreview, setEvidencePreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const problemRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!target) return;
    setRentText(groupDigits(target.currentRent));
    setDays(target.currentDays);
    setReason(null); setExplanation(''); setEvidenceUrl(null); setEvidencePreview(null);
    setUploading(false); setSubmitting(false); setProblem(null);
  }, [target]);

  // The message sits under the form: bring it into view so a stopped Continue is never silent on a small screen.
  useEffect(() => { if (problem) problemRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, [problem]);

  const rent = parseRentInput(rentText);
  const advice = useRenewalAdvice(prevId, days, open);
  const preview = useRenewalPreview(prevId, rent, days, open);

  const currentRent = target?.currentRent ?? 0;
  const currentDays = target?.currentDays ?? 0;
  const changed = target ? Number.isFinite(rent) && days !== null && renewalChanged(rent, days, currentRent, currentDays) : false;
  const minExplanation = preview.data?.min_explanation_length ?? DEFAULT_MIN_EXPLANATION;
  const hint = advice.data && !advice.loading && Number.isFinite(rent) && rent > 0
    ? renewalHint(rent, advice.data.current_rent, advice.data.suggested_max_rent)
    : null;
  const dayOptions = useMemo(() => {
    const list = advice.data?.allowed_days ?? (target ? [target.currentDays] : []);
    return list.includes(currentDays) ? list : [...list, currentDays].sort((a, b) => a - b);
  }, [advice.data, target, currentDays]);

  const onPickPhoto = async (file: File | undefined) => {
    if (!file || !user || !prevId) return;
    setUploading(true); setProblem(null);
    try {
      // Canvas -> WebP, longest side 1200px, like every other photo in the agent flows
      const optimized = await optimizeImage(file, { maxWidth: 1200, maxHeight: 1200, quality: 0.85 });
      const ext = optimized.file.name.split('.').pop() || 'webp';
      const path = `${user.id}/renewal-evidence/${prevId}-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from('house-images').upload(path, optimized.file, { cacheControl: '86400', upsert: true });
      if (error) throw error;
      setEvidenceUrl(supabase.storage.from('house-images').getPublicUrl(path).data.publicUrl);
      setEvidencePreview(optimized.previewUrl);
    } catch {
      setProblem('The photo could not be uploaded. Check your connection and try again, or continue without it.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const submit = async () => {
    if (!target || submitting) return;
    const early = renewalChoiceProblem({ newRent: rent, newDays: days, changed, reasonCode: reason, explanation, minExplanation });
    if (early) { setProblem(early); return; }
    setSubmitting(true); setProblem(null);
    try {
      // Fresh from the server at the moment of sending, never what was on screen a minute ago.
      const [, fresh] = await Promise.all([fetchRenewalAdvice(target.prevId, days), fetchRenewalPreview(target.prevId, rent, days)]);
      const stillChanged = renewalChanged(rent, days!, currentRent, currentDays);
      const late = renewalChoiceProblem({
        newRent: rent, newDays: days, changed: stillChanged, reasonCode: reason, explanation, minExplanation: fresh.min_explanation_length,
      });
      if (late) { setProblem(late); return; }
      onDone({
        newRent: rent,
        newDays: days!,
        dailyRepayment: fresh.daily_repayment,
        totalRepayment: fresh.total_repayment,
        changed: stillChanged,
        reasonCode: stillChanged ? reason : null,
        explanation: stillChanged ? explanation.trim() : '',
        evidenceUrl: stillChanged ? evidenceUrl : null,
      });
    } catch (e) {
      setProblem(renewalErrorMessage(e, minExplanation));
    } finally {
      setSubmitting(false);
    }
  };

  const busy = submitting || uploading;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onDone(null); }}>
      <DialogContent className="max-h-[92dvh] w-[calc(100vw-1.5rem)] max-w-md overflow-y-auto p-4 sm:p-6">
        <DialogHeader className="text-left">
          <DialogTitle className="flex items-center gap-2 text-base">
            <RefreshCw className="h-4 w-4 text-primary" />
            Renew Rent Plan
          </DialogTitle>
          <DialogDescription className="text-xs">
            {target?.tenantName ? `${target.tenantName}. ` : ''}Choose the rent and number of days for the new Rent Plan.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-baseline justify-between rounded-lg bg-muted/50 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Current rent</span>
            <span className="font-semibold">{formatUGX(currentRent)} <span className="text-xs font-normal text-muted-foreground">for {currentDays} days</span></span>
          </div>

          <AdviceCard loading={advice.loading && !advice.data} refreshing={advice.loading && !!advice.data} advice={advice.data} error={!!advice.error} days={days} />

          <div className="space-y-1.5">
            <Label htmlFor="renewal-new-rent" className="text-sm">New rent (UGX)</Label>
            <Input
              id="renewal-new-rent"
              inputMode="numeric"
              autoComplete="off"
              value={rentText}
              onChange={(e) => { setRentText(groupDigits(parseRentInput(e.target.value))); setProblem(null); }}
              className="h-11 text-base"
              aria-describedby="renewal-hint"
            />
            <div id="renewal-hint" aria-live="polite"><RentHint hint={hint} loading={advice.loading} /></div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="renewal-days" className="text-sm">Number of days</Label>
            <Select value={days === null ? '' : String(days)} onValueChange={(v) => { setDays(Number(v)); setProblem(null); }}>
              <SelectTrigger id="renewal-days" className="h-11 text-base"><SelectValue placeholder="Choose days" /></SelectTrigger>
              <SelectContent className="max-h-64">
                {dayOptions.map((d) => (
                  <SelectItem key={d} value={String(d)}>{d} days{d === currentDays ? ' (current)' : ''}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border bg-card px-3 py-2.5 text-sm" aria-live="polite">
            {preview.loading && !preview.data ? (
              <Skeleton className="h-5 w-2/3" />
            ) : preview.error ? (
              <p className="text-destructive">{renewalErrorMessage(preview.error)}</p>
            ) : preview.data ? (
              <div className={cn('flex flex-wrap items-baseline justify-between gap-x-3', preview.loading && 'opacity-60')}>
                <span className="text-muted-foreground">New daily payment</span>
                <span className="text-base font-semibold">{formatUGX(preview.data.daily_repayment)} <span className="text-xs font-normal text-muted-foreground">a day</span></span>
                <span className="w-full text-xs text-muted-foreground">
                  Total to repay {formatUGX(preview.data.total_repayment)}{preview.data.repayment_frequency === 'weekly' ? ', collected weekly' : ''}
                </span>
              </div>
            ) : (
              <p className="text-muted-foreground">Enter a rent to see the daily payment.</p>
            )}
          </div>

          {changed && (
            <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-500/30 dark:bg-amber-500/5">
              <div>
                <p className="text-sm font-medium">Why is the rent or number of days changing?</p>
                <p className="text-xs text-muted-foreground">Reviewers will read this.</p>
              </div>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Reason for the change">
                {RENEWAL_REASONS.map((r) => (
                  <button
                    key={r.code}
                    type="button"
                    aria-pressed={reason === r.code}
                    onClick={() => { setReason(r.code); setProblem(null); }}
                    className={cn(
                      'min-h-10 rounded-full border px-3.5 py-1.5 text-sm transition-colors',
                      reason === r.code ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
                    )}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="renewal-explanation" className="text-sm">Explain the change</Label>
                <Textarea
                  id="renewal-explanation"
                  value={explanation}
                  onChange={(e) => { setExplanation(e.target.value); setProblem(null); }}
                  rows={3}
                  placeholder="For example: the landlord raised the rent from the first of next month."
                  className="text-base"
                />
                <p className={cn('text-right text-xs', explanation.trim().length >= minExplanation ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground')}>
                  {explanation.trim().length}/{minExplanation} characters minimum
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Landlord note photo <span className="font-normal text-muted-foreground">(optional)</span></Label>
                {evidencePreview ? (
                  <div className="flex items-center gap-3">
                    <img src={evidencePreview} alt="Landlord note" className="h-16 w-16 rounded-md border object-cover" />
                    <Button type="button" variant="ghost" size="sm" onClick={() => { setEvidenceUrl(null); setEvidencePreview(null); }}>
                      <X className="mr-1 h-4 w-4" /> Remove
                    </Button>
                  </div>
                ) : (
                  <>
                    <input ref={fileRef} type="file" accept="image/*" className="sr-only" id="renewal-evidence" onChange={(e) => void onPickPhoto(e.target.files?.[0])} />
                    <Button type="button" variant="outline" className="h-11 w-full gap-2" disabled={uploading} onClick={() => fileRef.current?.click()}>
                      {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                      {uploading ? 'Uploading…' : 'Add a photo of the landlord note'}
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}

          {problem && (
            <p ref={problemRef} role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {problem}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <Button type="button" variant="outline" className="h-11 flex-1" disabled={busy} onClick={() => onDone(null)}>Cancel</Button>
            <Button type="button" className="h-11 flex-1" disabled={busy || !!preview.error} onClick={() => void submit()}>
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {submitting ? 'Checking…' : 'Continue'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AdviceCard({ loading, refreshing, advice, error, days }: {
  loading: boolean; refreshing: boolean; advice: import('@/lib/renewalAdvice').RenewalAdvice | null; error: boolean; days: number | null;
}) {
  if (loading) {
    return <div className="space-y-2 rounded-lg border p-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /></div>;
  }
  if (error || !advice) {
    return (
      <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
        <Info className="mt-0.5 h-4 w-4 shrink-0" /> The suggestion could not be loaded. You can still renew at any rent; try reopening this window to see it.
      </p>
    );
  }
  return (
    <div className={cn('rounded-lg border border-primary/20 bg-primary/5 p-3', refreshing && 'opacity-60')} aria-live="polite">
      <p className="text-sm font-semibold">Suggested up to {formatUGX(advice.suggested_max_rent)}</p>
      <p className="text-[11px] text-muted-foreground">For {days ?? advice.chosen_days} days. Advice only: you can ask for any rent.</p>
      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
        {advice.reasons.filter((_, i, a) => i < a.length - 1).map((line, i) => <li key={i}>{line}</li>)}
      </ul>
    </div>
  );
}

function RentHint({ hint, loading }: { hint: ReturnType<typeof renewalHint> | null; loading: boolean }) {
  if (!hint) return loading ? <p className="text-xs text-muted-foreground">Checking…</p> : null;
  if (hint.kind === 'lower') {
    return <p className="flex items-center gap-1.5 text-xs font-medium text-sky-700 dark:text-sky-400"><TrendingDown className="h-3.5 w-3.5" /> Lower than current rent</p>;
  }
  if (hint.kind === 'above') {
    return (
      <p className="flex items-start gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Above suggestion by {formatUGX(hint.aboveBy)} ({hint.abovePct}%). Reviewers will see this.
      </p>
    );
  }
  return <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> Within suggestion</p>;
}
