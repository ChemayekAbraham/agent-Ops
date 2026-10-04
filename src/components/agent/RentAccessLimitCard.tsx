import { useMemo, useState } from 'react';
import { TrendingUp, TrendingDown, Info, Sparkles, MessageCircle, Loader2, Check, Wand2, Pencil, AlertCircle, Wallet, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUGX } from '@/lib/rentCalculations';
import {
  calculateRentAccessLimit,
  TIER_META,
  RENT_ACCESS_PAID_INCREMENT_UGX,
  RENT_ACCESS_MISSED_DECREMENT_UGX,
  RENT_ACCESS_MAX_LIMIT_UGX,
  type RepaymentLike,
} from '@/lib/rentAccessLimit';
import { useRentAccessLimitParams } from '@/hooks/useRentAccessLimitParams';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { RentAccessLimitShareDialog } from './RentAccessLimitShareDialog';

/**
 * Sensible UGX bounds for monthly rent.
 * - MIN: 10,000 UGX (anything lower is almost certainly a typo / wrong unit)
 * - MAX: 50,000,000 UGX (covers high-end Kampala properties; protects against
 *        accidentally entering yearly rent or adding extra zeros)
 * - STEP: 500 UGX (rent is rarely quoted with finer granularity)
 */
const RENT_MIN_UGX = 10_000;
const RENT_MAX_UGX = 50_000_000;
const RENT_STEP_UGX = 500;

type RentValidation =
  | { ok: true; value: number }
  | { ok: false; reason: 'empty' | 'too_low' | 'too_high' | 'not_round' | 'nan'; message: string };

function validateMonthlyRentUGX(raw: string): RentValidation {
  const cleaned = raw.replace(/[^0-9]/g, '');
  if (!cleaned) {
    return { ok: false, reason: 'empty', message: 'Enter the monthly rent amount.' };
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    return { ok: false, reason: 'nan', message: 'Rent must be a valid number.' };
  }
  if (n < RENT_MIN_UGX) {
    return {
      ok: false,
      reason: 'too_low',
      message: `Rent looks too low — minimum is ${RENT_MIN_UGX.toLocaleString('en-UG')} UGX.`,
    };
  }
  if (n > RENT_MAX_UGX) {
    return {
      ok: false,
      reason: 'too_high',
      message: `Rent looks too high — maximum is ${RENT_MAX_UGX.toLocaleString('en-UG')} UGX. Did you enter yearly rent?`,
    };
  }
  if (n % RENT_STEP_UGX !== 0) {
    return {
      ok: false,
      reason: 'not_round',
      message: `Round to the nearest ${RENT_STEP_UGX.toLocaleString('en-UG')} UGX.`,
    };
  }
  return { ok: true, value: n };
}

interface RentAccessLimitCardProps {
  tenantId: string;
  tenantName: string;
  tenantPhone: string;
  monthlyRent: number | null;
  repayments: RepaymentLike[];
  /** Optional Welile AI ID to show on the share artefacts */
  aiId?: string;
  /**
   * If set, the card shows a "auto-detected from last rent plan" pill —
   * meaning monthlyRent was inferred from prior rent_requests, not stored on profile.
   */
  detectedFromHistory?: boolean;
  /**
   * Suggested monthly rent to pre-fill the prompt with (e.g. last known rent).
   */
  suggestedRent?: number | null;
  /**
   * Called after the rent is successfully saved to profiles.monthly_rent.
   * Parent should refresh its profile state so the card re-renders with the new value.
   */
  onRentSaved?: (rent: number) => void;
}

/**
 * Prominent, marketing-grade Rent Access Limit card for the tenant profile.
 * Recomputes on the fly — no DB writes.
 */
export function RentAccessLimitCard({
  tenantId,
  tenantName,
  tenantPhone,
  monthlyRent,
  repayments,
  aiId,
  detectedFromHistory,
  suggestedRent,
  onRentSaved,
}: RentAccessLimitCardProps) {
  const [shareOpen, setShareOpen] = useState(false);
  const [showHow, setShowHow] = useState(false);
  const { toast } = useToast();
  const [rentInput, setRentInput] = useState<string>(
    suggestedRent && suggestedRent > 0 ? String(suggestedRent) : '',
  );
  const [savingRent, setSavingRent] = useState(false);
  const { params } = useRentAccessLimitParams();
  const PAID_INC = params.paid_increment_ugx;
  const MISS_DEC = params.missed_decrement_ugx;
  const MAX_LIMIT = params.max_limit_ugx;

  const result = useMemo(
    () => calculateRentAccessLimit(monthlyRent, repayments, new Date(), {
      paidIncrementUgx: PAID_INC,
      missedDecrementUgx: MISS_DEC,
      maxLimitUgx: MAX_LIMIT,
    }),
    [monthlyRent, repayments, PAID_INC, MISS_DEC, MAX_LIMIT],
  );

  // Rent missing → still show the limit card (no minimum-payments gate),
  // but surface an inline prompt to capture monthly rent for share artefacts.
  const rentMissing = !monthlyRent || monthlyRent <= 0;
  if (rentMissing && result.limit === 0 && result.trackedDays === 0) {
    const validation = validateMonthlyRentUGX(rentInput);
    const isEmpty = !rentInput.replace(/[^0-9]/g, '');
    // Only surface validation errors after the user has typed something
    const showError = !validation.ok && !isEmpty;
    const canSave = validation.ok && !savingRent;

    const handleSaveRent = async () => {
      const v = validateMonthlyRentUGX(rentInput);
      if (v.ok === false) {
        toast({
          title: 'Invalid monthly rent',
          description: v.message,
          variant: 'destructive',
        });
        return;
      }
      setSavingRent(true);
      try {
        const { error } = await supabase
          .from('profiles')
          .update({ monthly_rent: v.value })
          .eq('id', tenantId);
        if (error) throw error;
        toast({ title: 'Monthly rent saved', description: `Set to ${formatUGX(v.value)}` });
        onRentSaved?.(v.value);
      } catch (err: any) {
        toast({
          title: 'Could not save rent',
          description: err?.message || 'Please try again.',
          variant: 'destructive',
        });
      } finally {
        setSavingRent(false);
      }
    };

    return (
      <div className="rounded-2xl border border-dashed border-primary/40 bg-primary/5 p-4 sm:p-5 space-y-3">
        <div className="flex items-start gap-2.5">
          <div className="h-9 w-9 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
            <Sparkles className="h-4.5 w-4.5 text-primary" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-foreground">
              Unlock up to {formatUGX(MAX_LIMIT)} in rent money
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Every on-time payment adds {formatUGX(PAID_INC)} to {tenantName.split(' ')[0]}'s limit.
              Add monthly rent below to power the share card.
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="rent-input" className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              Monthly rent (UGX)
            </label>
            <span className="text-[10px] text-muted-foreground">
              {RENT_MIN_UGX.toLocaleString('en-UG')} – {RENT_MAX_UGX.toLocaleString('en-UG')}
            </span>
          </div>
          <div className="flex gap-2">
            <Input
              id="rent-input"
              inputMode="numeric"
              placeholder="e.g. 350,000"
              value={rentInput ? Number(rentInput.replace(/[^0-9]/g, '')).toLocaleString('en-UG') : ''}
              onChange={(e) => setRentInput(e.target.value.replace(/[^0-9]/g, ''))}
              className={cn(
                'h-11 text-sm font-mono font-semibold',
                showError && 'border-destructive focus-visible:ring-destructive',
              )}
              disabled={savingRent}
              aria-invalid={showError}
              aria-describedby="rent-input-help"
            />
            <Button
              type="button"
              onClick={handleSaveRent}
              disabled={!canSave}
              className="h-11 px-4 rounded-md font-bold shrink-0"
            >
              {savingRent ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              <span className="ml-1.5">Save</span>
            </Button>
          </div>
          <div id="rent-input-help" className="min-h-[16px]" aria-live="polite">
            {showError ? (
              <p className="text-[11px] text-destructive flex items-start gap-1">
                <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" aria-hidden />
                <span>{(validation as Extract<RentValidation, { ok: false }>).message}</span>
              </p>
            ) : validation.ok ? (
              <p className="text-[11px] text-success flex items-center gap-1">
                <Check className="h-3 w-3 shrink-0" aria-hidden />
                Looks good — saves as {formatUGX(validation.value)}
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Round to nearest {RENT_STEP_UGX.toLocaleString('en-UG')} UGX. Enter the <strong>monthly</strong>, not yearly, amount.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const tier = TIER_META[result.tier];
  const progressPct = Math.round(result.netAdjustmentPct * 100);

  return (
    <>
      <section
        aria-label="Rent Access Limit"
        className={cn(
          'relative overflow-hidden rounded-2xl border shadow-md',
          'bg-gradient-to-br from-primary/15 via-primary/5 to-background',
          'border-primary/20',
        )}
      >
        {/* Decorative orbs */}
        <div className="absolute -top-10 -right-10 h-32 w-32 rounded-full bg-primary/20 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-12 -left-10 h-28 w-28 rounded-full bg-primary/10 blur-3xl pointer-events-none" />

        <div className="relative p-4 sm:p-5 space-y-3">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] sm:text-xs font-bold uppercase tracking-widest text-primary/80">
                Rent Money You Can Get
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Welile can pay this much rent for you · Grows daily
              </p>
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'mt-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold border cursor-help',
                        'transition-colors',
                        detectedFromHistory
                          ? 'bg-primary/10 text-primary border-primary/20 hover:bg-primary/15'
                          : 'bg-muted text-muted-foreground border-border/60 hover:bg-muted/80',
                      )}
                      aria-label={
                        detectedFromHistory
                          ? 'Monthly rent auto-detected from latest rent request'
                          : 'Monthly rent entered manually'
                      }
                    >
                      {detectedFromHistory ? (
                        <Wand2 className="h-3 w-3" aria-hidden />
                      ) : (
                        <Pencil className="h-3 w-3" aria-hidden />
                      )}
                      Rent: {formatUGX(monthlyRent)} ·{' '}
                      {detectedFromHistory ? 'auto-detected' : 'manual'}
                      <Info className="h-3 w-3 opacity-60" aria-hidden />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="start" className="max-w-[260px] text-xs">
                    {detectedFromHistory ? (
                      <p>
                        Monthly rent of <span className="font-semibold">{formatUGX(monthlyRent)}</span>{' '}
                        was auto-detected from {tenantName.split(' ')[0]}'s latest rent request. It updates
                        automatically whenever a new rent plan is issued.
                      </p>
                    ) : (
                      <p>
                        Monthly rent of <span className="font-semibold">{formatUGX(monthlyRent)}</span>{' '}
                        was entered manually on this profile and is stored as their official monthly rent.
                      </p>
                    )}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <span
              className={cn(
                'shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-bold',
                'bg-background/80 backdrop-blur border border-border/60',
                tier.color,
              )}
              aria-label={`Tier: ${tier.label}`}
            >
              <span aria-hidden>{tier.emoji}</span>
              {tier.label}
            </span>
          </div>

          {/* Main figure */}
          <div>
            <p className="text-3xl sm:text-4xl font-black font-mono text-foreground leading-none break-all">
              {formatUGX(result.limit)}
            </p>
            <p className="text-sm font-semibold text-primary mt-1.5 flex items-center gap-1">
              <Wallet className="h-3.5 w-3.5" aria-hidden />
              {result.atMax
                ? `Maxed out at ${formatUGX(MAX_LIMIT)} — the ceiling`
                : 'You can use this money for rent today'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {progressPct}% toward the {formatUGX(MAX_LIMIT)} ceiling ·{' '}
              <span className="text-success font-semibold">
                +{formatUGX(PAID_INC)}/paid day
              </span>
              {' · '}
              <span className="text-destructive font-semibold">
                −{formatUGX(MISS_DEC)}/missed day
              </span>
            </p>
          </div>

          {/* Today's change pill */}
          <div
            className={cn(
              'flex items-center gap-2 rounded-xl px-3 py-2 border',
              result.paidToday
                ? 'bg-success/10 border-success/30 text-success'
                : 'bg-warning/10 border-warning/30 text-warning',
            )}
            role="status"
            aria-live="polite"
          >
            {result.paidToday ? (
              <TrendingUp className="h-4 w-4 shrink-0" />
            ) : (
              <TrendingDown className="h-4 w-4 shrink-0" />
            )}
            <p className="text-xs sm:text-sm font-semibold flex-1">
              {result.paidToday
                ? result.paymentsToday > 1
                  ? `+${formatUGX(PAID_INC)} earned today · ${result.paymentsToday} payments count as 1 on-time day`
                  : `+${formatUGX(PAID_INC)} earned today`
                : `Pay today to earn +${formatUGX(PAID_INC)} (skip = −${formatUGX(MISS_DEC)})`}
            </p>
          </div>

          {/* Same-day dedupe hint — always visible so tenants know extra payments today don't stack */}
          <p className="text-[11px] text-muted-foreground italic text-center -mt-1">
            Tip: multiple payments on the same calendar day count as <span className="font-semibold">one</span> on-time day.
          </p>

          {/* Stats strip */}
          <div className="grid grid-cols-3 gap-1.5 text-center">
            <Stat label="On-time days" value={result.paidDays} tone="success" />
            <Stat label="Missed days" value={result.missedDays} tone="destructive" />
            <Stat label="Tracked" value={result.trackedDays} tone="muted" />
          </div>

          {/* CTA row — oversized, pulsing share button to nudge agents */}
          <div className="pt-2 space-y-2">
            <div className="relative">
              {/* Glow halo */}
              <span
                aria-hidden
                className="absolute -inset-1 rounded-2xl bg-gradient-to-r from-green-500/40 via-emerald-500/40 to-green-500/40 blur-lg opacity-70 animate-pulse pointer-events-none"
              />
              <Button
                type="button"
                onClick={() => setShareOpen(true)}
                aria-label="Send this rent money offer to the tenant on WhatsApp"
                className={cn(
                  'relative w-full h-16 sm:h-[68px] rounded-2xl',
                  'text-base sm:text-lg font-black tracking-wide uppercase',
                  'bg-gradient-to-r from-[#25D366] via-[#1ebe57] to-[#128C7E] hover:brightness-110',
                  'text-white shadow-[0_10px_30px_-8px_rgba(37,211,102,0.7)]',
                  'ring-2 ring-white/20 active:scale-[0.98] transition-transform',
                )}
              >
                <MessageCircle className="h-6 w-6 sm:h-7 sm:w-7 mr-2 shrink-0" />
                <span className="flex flex-col items-start leading-tight">
                  <span className="text-[10px] sm:text-[11px] font-bold opacity-90 tracking-widest">
                    SHARE ON WHATSAPP
                  </span>
                  <span className="text-base sm:text-lg font-black normal-case">
                    Send {tenantName.split(' ')[0]} {formatUGX(result.limit)}
                  </span>
                </span>
                <ArrowRight className="h-6 w-6 ml-auto shrink-0" />
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] sm:text-xs font-semibold text-foreground/80 flex items-center gap-1">
                <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
                Branded image + link · ready to send
              </p>
              <button
                type="button"
                onClick={() => setShowHow(v => !v)}
                aria-expanded={showHow}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
              >
                <Info className="h-3.5 w-3.5" />
                How it works
              </button>
            </div>
          </div>

          {/* How-it-works */}
          {showHow && (
            <div className="rounded-xl bg-background/70 backdrop-blur border border-border/50 p-3 text-xs space-y-1 animate-fade-in">
              <p className="font-bold text-foreground">How much money can you get?</p>
              <p className="text-muted-foreground">
                Every tenant starts with a fresh limit — no minimum payments needed.
              </p>
              <p className="text-success">
                ✅ Pay rent today → limit grows by {formatUGX(PAID_INC)}
              </p>
              <p className="text-destructive">
                ❌ Miss a day → limit drops by {formatUGX(MISS_DEC)}
              </p>
              <p className="text-foreground">
                🏁 Maximum any tenant can reach: <span className="font-bold">{formatUGX(MAX_LIMIT)}</span>
              </p>
              <p className="text-muted-foreground pt-1 font-medium">
                Pay every day. The more you pay, the more rent Welile can give you.
              </p>
            </div>
          )}
        </div>
      </section>

      <RentAccessLimitShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        tenantId={tenantId}
        tenantName={tenantName}
        tenantPhone={tenantPhone}
        aiId={aiId}
        result={result}
      />
    </>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'success' | 'destructive' | 'muted';
}) {
  const toneClass =
    tone === 'success' ? 'text-success' : tone === 'destructive' ? 'text-destructive' : 'text-foreground';
  return (
    <div className="rounded-lg bg-background/70 backdrop-blur border border-border/40 px-1 py-1.5">
      <p className={cn('text-base font-black font-mono leading-tight', toneClass)}>{value}</p>
      <p className="text-[9px] text-muted-foreground uppercase tracking-wider mt-0.5">{label}</p>
    </div>
  );
}
