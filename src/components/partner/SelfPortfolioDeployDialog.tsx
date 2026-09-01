import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { formatDynamic } from '@/lib/currencyFormat';
import { toast } from 'sonner';
import { CalendarClock, CheckCircle2, HandCoins, Info, Loader2, PlusCircle, Sparkles, Star } from 'lucide-react';


/**
 * Self Portfolio Management — deployment decision.
 *
 * A partner deploying capital is never asked about policy, only about outcome.
 * Two priced options, side by side:
 *
 *   A. Add to the existing portfolio — earns immediately, pro-rata for the rest
 *      of the current month, then the full monthly rate. Inherits the parent
 *      portfolio's maturity date, so a top-up never extends the monthly term.
 *   B. Start a new monthly portfolio — fresh anchor date, one monthly cycle.
 *
 * Guard: inside the final days of a portfolio, option A is closed. That window
 * is the principal-return runway, so new capital must start its own term.
 * The server enforces the same guard; this UI only explains it early.
 */

interface Eligibility {
  commitment_id: string;
  status: string;
  committed_amount: number;
  monthly_rate: number;
  term_end_at: string | null;
  next_payout_at: string | null;
  days_remaining: number;
  cycles_remaining: number;
  days_in_cycle: number;
  days_left_in_cycle: number;
  allow_topup: boolean;
  block_reason: string | null;
  available_balance: number;
}

type Choice = 'topup' | 'new' | 'direct';

const shortDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

export function SelfPortfolioDeployDialog({
  open,
  onOpenChange,
  activeCommitmentId,
  selectedIds,
  total,
  onDeployed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeCommitmentId: string | null;
  selectedIds: string[];
  total: number;
  onDeployed: () => void | Promise<void>;
}) {
  const { user } = useAuth();
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<Choice>('new');
  const [capacity, setCapacity] = useState<number | null>(null);
  const [depositDate, setDepositDate] = useState('');

  const loadEligibility = useCallback(async () => {
    if (!activeCommitmentId) {
      setEligibility(null);
      setChoice('direct');
      return;
    }

    setLoading(true);
    const { data, error } = await supabase.rpc('partner_self_topup_eligibility', {
      p_commitment_id: activeCommitmentId,
    });
    if (error) {
      setEligibility(null);
      setChoice('new');
    } else {
      const payload = data as unknown as Eligibility;
      setEligibility(payload);
      setChoice(payload?.allow_topup ? 'topup' : 'new');
    }
    setLoading(false);
  }, [activeCommitmentId]);

  /** Spendable wallet + operational float — the funds a direct release can draw on. */
  const loadCapacity = useCallback(async () => {
    if (!user?.id) return;
    const { data, error } = await supabase.rpc('funder_support_capacity', { p_user_id: user.id });
    setCapacity(error ? null : Number(data ?? 0));
  }, [user?.id]);

  useEffect(() => {
    if (open) {
      setDepositDate('');
      void loadEligibility();
      void loadCapacity();
    }
  }, [open, loadEligibility, loadCapacity]);

  const rate = Number(eligibility?.monthly_rate ?? 15);
  const fullMonthly = Math.round((total * rate) / 100);

  /** Pro-rata slice for the remainder of the current cycle. */
  const prorata = useMemo(() => {
    if (!eligibility) return 0;
    const daysInCycle = Math.max(1, Number(eligibility.days_in_cycle || 30));
    const daysLeft = Math.max(0, Math.min(Number(eligibility.days_left_in_cycle || 0), daysInCycle));
    return Math.round((fullMonthly * daysLeft) / daysInCycle);
  }, [eligibility, fullMonthly]);

  const cyclesRemaining = Number(eligibility?.cycles_remaining ?? 0);
  const topupProjection = prorata + fullMonthly * cyclesRemaining;
  const newProjection = fullMonthly;
  const canTopUp = !!eligibility?.allow_topup;
  const covered = capacity !== null && capacity >= total && total > 0;
  const needsDepositDate = choice === 'direct' && !covered;
  const todayISO = new Date().toISOString().slice(0, 10);

  /**
   * With no active self-support portfolio, the direct landlord-float release is the
   * offer. The new-portfolio path only reappears when a direct release cannot cover
   * the amount, so the landlord float can still be funded another way.
   */
  const showNewPortfolio = !!eligibility || !covered;

  useEffect(() => {
    if (!open || eligibility) return;
    setChoice(covered ? 'direct' : 'new');
  }, [open, eligibility, covered]);




  const deploy = async () => {
    if (selectedIds.length === 0) return;
    if (needsDepositDate && !depositDate) {
      toast.error('Add the date you will deposit this amount');
      return;
    }
    setBusy(true);
    try {
      const { error: claimError } = await supabase.rpc('partner_self_claim_plans', {
        p_rent_request_ids: selectedIds,
      });
      if (claimError) throw claimError;

      if (choice === 'direct') {
        const { data, error } = await supabase.rpc('funder_support_tenant_direct', {
          p_rent_request_ids: selectedIds,
          p_promised_deposit_date: depositDate || null,
          p_term_months: 1,
        });
        if (error) throw error;
        const payload = (data ?? {}) as { funding_mode?: string; from_float?: number };
        if (payload.funding_mode === 'receivable') {
          toast.success('Support pledged', {
            description: `Recorded as a landlord float receivable of ${formatDynamic(total)}. Deposit it into your wallet by ${new Date(depositDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} and it releases to the landlord float.`,
            duration: 9000,
          });
        } else {
          toast.success('Submitted — pending approval', {
            description: `${formatDynamic(total)} is committed and waiting for Partner Operations to verify it. Nothing leaves your wallet or operational float until they approve, and only then is it released to the landlord float.`,
            duration: 9000,
          });
        }

      } else if (choice === 'topup' && eligibility) {
        const { error } = await supabase.rpc('partner_self_top_up', {
          p_commitment_id: eligibility.commitment_id,
          p_rent_request_ids: selectedIds,
        });
        if (error) throw error;
        toast.success('Submitted — pending approval', {
          description:
            prorata > 0
              ? `Partner Operations will review your top-up. Your ${formatDynamic(total)} stays in your wallet until then, and earns ${formatDynamic(prorata)} for the rest of this month once approved. You will receive a confirmation email after approval.`
              : `Partner Operations will review your top-up. Your ${formatDynamic(total)} stays in your wallet until then. You will receive a confirmation email after approval.`,
          duration: 8000,
        });
      } else {
        const { error } = await supabase.rpc('partner_self_confirm_commitment', {
          p_rent_request_ids: selectedIds,
          p_term_months: 1,
        });
        if (error) throw error;
        toast.success('Submitted — pending approval', {
          description: `Partner Operations will review your new portfolio. Your ${formatDynamic(total)} stays in your wallet until it is approved, and your confirmation email is sent once approval goes through.`,
          duration: 8000,
        });
      }


      onOpenChange(false);
      await onDeployed();
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'Deployment failed';
      // Server-side maturity guard: fall back to the new-portfolio path.
      if (raw.includes('PSM_TOPUP_WINDOW_CLOSED')) {
        setChoice('new');
        await loadEligibility();
        toast.error(raw.replace(/^.*PSM_TOPUP_WINDOW_CLOSED:\s*/, ''));
      } else if (raw.includes('DEPOSIT_DATE_REQUIRED')) {
        setChoice('direct');
        toast.error('Add the date you will deposit this amount into your wallet');
      } else if (raw.includes('DEPOSIT_DATE_IN_PAST')) {
        toast.error('Pick a deposit date from today onwards');
      } else if (raw.includes('AGREEMENT_REQUIRED')) {

        toast.error('Sign your partner agreement first', {
          description: 'A signed partnership agreement is required before you can create a portfolio.',
        });
      } else {
        toast.error(raw);
      }
      await supabase.rpc('partner_self_release_claims', { p_rent_request_ids: selectedIds });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">Deploy {formatDynamic(total)}</DialogTitle>
          <DialogDescription className="text-xs">
            Supporting {selectedIds.length} tenant plan{selectedIds.length === 1 ? '' : 's'}. Your
            capital starts earning the day it is deployed — it does not wait for the landlord payout
            step. Principal is never reduced by tenant outcomes.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full rounded-2xl" />
            <Skeleton className="h-24 w-full rounded-2xl" />
          </div>
        ) : (
          <div className="space-y-3">
            {eligibility && (
              <button
                type="button"
                disabled={!canTopUp || busy}
                onClick={() => setChoice('topup')}
                aria-pressed={choice === 'topup'}
                className={`w-full text-left rounded-2xl border p-3 transition-colors ${
                  choice === 'topup' ? 'border-primary bg-primary/5' : 'border-border'
                } ${!canTopUp ? 'opacity-60' : ''}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <PlusCircle className="h-4 w-4 text-primary shrink-0" />
                      <p className="text-sm font-bold truncate">Add to my current portfolio</p>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Earns from today, pro-rata for the rest of this month, then the full monthly
                      rate. Matures with the parent portfolio on {shortDate(eligibility.term_end_at)}.
                    </p>
                  </div>
                  {canTopUp && cyclesRemaining >= 3 && (
                    <Badge className="gap-1 text-[10px] shrink-0 bg-primary text-primary-foreground hover:bg-primary">
                      <Star className="h-3 w-3 fill-current" aria-hidden="true" />
                      Recommended
                    </Badge>
                  )}
                </div>

                {canTopUp ? (
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {[
                      { label: 'Rest of this month', value: formatDynamic(prorata) },
                      { label: 'Then per month', value: formatDynamic(fullMonthly) },
                      { label: `Over ${cyclesRemaining} cycle${cyclesRemaining === 1 ? '' : 's'}`, value: formatDynamic(topupProjection) },
                    ].map((f) => (
                      <div key={f.label} className="rounded-xl bg-muted/40 px-2 py-1.5 min-w-0">
                        <p className="text-[9px] uppercase tracking-wide font-semibold text-muted-foreground truncate">
                          {f.label}
                        </p>
                        <p className="text-xs font-black mt-0.5 truncate">{f.value}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-2 flex items-start gap-2 rounded-xl bg-muted/40 px-2.5 py-2">
                    <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                    <p className="text-[10px] text-muted-foreground">
                      {eligibility.block_reason ?? 'Top-ups are closed on this portfolio.'}
                    </p>
                  </div>
                )}
              </button>
            )}

            {showNewPortfolio && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setChoice('new')}
              aria-pressed={choice === 'new'}
              className={`w-full text-left rounded-2xl border p-3 transition-colors ${
                choice === 'new' ? 'border-primary bg-primary/5' : 'border-border'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-primary shrink-0" />
                    <p className="text-sm font-bold truncate">Start a new monthly portfolio</p>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Fresh start date, one monthly payout on its own anniversary date.
                  </p>
                </div>
                {eligibility && (!canTopUp || cyclesRemaining < 3) && (
                  <Badge className="gap-1 text-[10px] shrink-0 bg-primary text-primary-foreground hover:bg-primary">
                    <Star className="h-3 w-3 fill-current" aria-hidden="true" />
                    Recommended
                  </Badge>
                )}
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {[
                  { label: 'Per month', value: formatDynamic(fullMonthly) },
                  { label: 'Cycles', value: '1' },
                  { label: 'Over the term', value: formatDynamic(newProjection) },
                ].map((f) => (
                  <div key={f.label} className="rounded-xl bg-muted/40 px-2 py-1.5 min-w-0">
                    <p className="text-[9px] uppercase tracking-wide font-semibold text-muted-foreground truncate">
                      {f.label}
                    </p>
                    <p className="text-xs font-black mt-0.5 truncate">{f.value}</p>
                  </div>
                ))}
              </div>
            </button>
            )}


            <button
              type="button"
              disabled={busy}
              onClick={() => setChoice('direct')}
              aria-pressed={choice === 'direct'}
              className={`w-full text-left rounded-2xl border p-3 transition-colors ${
                choice === 'direct' ? 'border-primary bg-primary/5' : 'border-border'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <HandCoins className="h-4 w-4 text-primary shrink-0" />
                    <p className="text-sm font-bold truncate">Support this landlord now</p>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {covered
                      ? "Moves the capital straight out of your spendable wallet or operational float onto the tenant's agent landlord float — no approval wait."
                      : 'You have no balance to cover this. It is recorded as a landlord float receivable and releases once you deposit on the date you choose.'}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {!eligibility && covered && (
                    <Badge className="gap-1 text-[10px] bg-primary text-primary-foreground hover:bg-primary">
                      <Star className="h-3 w-3 fill-current" aria-hidden="true" />
                      Recommended
                    </Badge>
                  )}
                  <Badge variant={covered ? 'secondary' : 'outline'} className="text-[10px]">
                    {covered ? 'Instant' : 'Deposit date needed'}
                  </Badge>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {[
                  { label: 'Available now', value: capacity === null ? '—' : formatDynamic(capacity) },
                  { label: 'To landlord float', value: formatDynamic(total) },
                  { label: 'Per month', value: formatDynamic(fullMonthly) },
                ].map((f) => (
                  <div key={f.label} className="rounded-xl bg-muted/40 px-2 py-1.5 min-w-0">
                    <p className="text-[9px] uppercase tracking-wide font-semibold text-muted-foreground truncate">
                      {f.label}
                    </p>
                    <p className="text-xs font-black mt-0.5 truncate">{f.value}</p>
                  </div>
                ))}
              </div>
            </button>

            {needsDepositDate && (
              <div className="space-y-1.5 rounded-2xl border border-primary/30 bg-primary/5 p-3">
                <Label htmlFor="psm-deposit-date" className="text-[11px] font-bold">
                  Date you will deposit {formatDynamic(total)} (required)
                </Label>
                <Input
                  id="psm-deposit-date"
                  type="date"
                  min={todayISO}
                  value={depositDate}
                  onChange={(e) => setDepositDate(e.target.value)}
                  className="h-10"
                />
                <p className="text-[10px] text-muted-foreground">
                  Until the deposit lands, this stays a landlord float receivable in your name.
                </p>
              </div>
            )}

            <div className="flex items-start gap-2 rounded-xl bg-muted/30 px-2.5 py-2">
              <CalendarClock className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
              <p className="text-[10px] text-muted-foreground">
                Returns pay monthly into your withdrawable balance and are never compounded
                automatically. At the end of the monthly term, principal is returned over the
                standard settlement window.
              </p>
            </div>

            <Button
              className="w-full"
              onClick={() => void deploy()}
              disabled={busy || selectedIds.length === 0 || (needsDepositDate && !depositDate)}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              <span className="ml-2">
                {choice === 'topup'
                  ? 'Add to portfolio'
                  : choice === 'direct'
                    ? covered
                      ? 'Support Tenant'
                      : 'Pledge with deposit date'
                    : 'Start new portfolio'}
              </span>
            </Button>

          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}