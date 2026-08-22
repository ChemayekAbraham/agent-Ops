import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDynamic } from '@/lib/currencyFormat';
import { toast } from 'sonner';
import { CalendarClock, Check, ChevronLeft, ChevronRight, Home, Loader2, MapPin, Plus, RefreshCw, ShieldCheck, TrendingUp, Wallet } from 'lucide-react';

import { SelfPortfolioDeployDialog } from './SelfPortfolioDeployDialog';
import { SelfPortfolioPlanDetailSheet } from './SelfPortfolioPlanDetailSheet';
import { PlanShareButton } from './PlanShareButton';
import { SlotAmount } from './SlotAmount';

const MIN_FUNDING = 50000;
const MONTHLY_ROI_RATE = 15;
const PLANS_PER_PAGE = 4;

interface EarningsSummary {
  nextPayoutDate: string | null;
  expectedThisCycle: number;
  totalEarned: number;
  totalPaid: number;
}

const ordinal = (day: number) => {
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${day}${suffix}`;
};

interface FundablePlan {
  rent_request_id: string;
  funding_amount: number;
  duration_days: number | null;
  daily_repayment: number | null;
  request_city: string | null;
  house_category: string | null;
  projected_end_date: string | null;
  repayment_cadence: string | null;
  tenant_first_name: string | null;
  tenant_full_name: string | null;
  tenant_location: string | null;
  tenant_avatar_url: string | null;
  tenant_has_photo?: boolean | null;
  landlord_name: string | null;
  landlord_phone: string | null;
  lc1_chairperson_name: string | null;
  house_image_urls: string[] | null;
  held_by: string | null;
  hold_expires_at: string | null;
  request_latitude?: number | string | null;
  request_longitude?: number | string | null;
}

/**
 * Self Portfolio Management — Phase Two
 * Partner funds approved rent plans straight from their withdrawable balance.
 * Privacy: tenant first name only, landlord name shown, no contact details ever leave the server.
 */
export function SelfPortfolioFundingCard({ partnerId }: { partnerId: string }) {
  const [plans, setPlans] = useState<FundablePlan[]>([]);
  const [available, setAvailable] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fundedIds, setFundedIds] = useState<string[]>([]);
  const [earnings, setEarnings] = useState<EarningsSummary | null>(null);
  const [activeCommitmentId, setActiveCommitmentId] = useState<string | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);
  const [detailPlan, setDetailPlan] = useState<FundablePlan | null>(null);
  const [page, setPage] = useState(0);
  // Short code arriving from a branded /s/<code> share link (?share=<code>).
  const [sharedPlanId, setSharedPlanId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('partner_self_list_fundable_plans', {
      p_limit: 20,
      p_offset: 0,
    });
    if (error) {
      setPlans([]);
    } else {
      const payload = (data ?? {}) as { plans?: FundablePlan[]; available_balance?: number };
      setPlans(payload.plans ?? []);
      setPage(0);
      setAvailable(Number(payload.available_balance ?? 0));
    }
    setLoading(false);
  }, []);

  const loadFunded = useCallback(async () => {
    const { data } = await supabase.rpc('partner_self_portfolio', { p_partner_id: partnerId });
    const payload = (data ?? {}) as {
      lines?: { rent_request_id: string; status?: string; principal?: number }[];
      commitments?: {
        id?: string;
        status?: string;
        next_payout_at?: string | null;
        monthly_rate?: number;
        created_at?: string;
      }[];
      totals?: { total_earned?: number; total_paid?: number; active?: number };
    };
    setFundedIds((payload.lines ?? []).map((l) => l.rent_request_id));

    const activeCommitments = (payload.commitments ?? []).filter((c) => c.status === 'active');
    // Newest active portfolio is the top-up target.
    setActiveCommitmentId(
      [...activeCommitments]
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0]?.id ??
        null,
    );
    const nextPayoutDate = activeCommitments
      .map((c) => c.next_payout_at)
      .filter((d): d is string => !!d)
      .sort()[0] ?? null;
    const rate = Number(activeCommitments[0]?.monthly_rate ?? 15);
    const activePrincipal = Number(payload.totals?.active ?? 0);

    setEarnings({
      nextPayoutDate,
      expectedThisCycle: Math.round((activePrincipal * rate) / 100),
      totalEarned: Number(payload.totals?.total_earned ?? 0),
      totalPaid: Number(payload.totals?.total_paid ?? 0),
    });
  }, [partnerId]);

  useEffect(() => {
    void load();
    void loadFunded();
  }, [load, loadFunded]);

  // Resolve ?share=<code> to the plan it points at, then clean the URL.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('share');
    if (!code || !/^[A-Za-z0-9]{4,12}$/.test(code)) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.rpc('resolve_short_link', { p_code: code }).maybeSingle();
      const planId = ((data as any)?.target_params ?? {})?.plan;
      if (!cancelled && planId) setSharedPlanId(String(planId));
      const url = new URL(window.location.href);
      url.searchParams.delete('share');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Bring the shared plan into view on its page and open its details sheet.
  useEffect(() => {
    if (!sharedPlanId || plans.length === 0) return;
    const index = plans.findIndex((p) => p.rent_request_id === sharedPlanId);
    if (index < 0) return;
    setPage(Math.floor(index / PLANS_PER_PAGE));
    setDetailPlan(plans[index]);
    setSharedPlanId(null);
    window.setTimeout(() => {
      document
        .querySelector(`[data-plan-id="${sharedPlanId}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 250);
  }, [sharedPlanId, plans]);

  const total = useMemo(
    () =>
      plans
        .filter((p) => selected.includes(p.rent_request_id))
        .reduce((sum, p) => sum + Number(p.funding_amount || 0), 0),
    [plans, selected],
  );

  const remaining = Math.max(0, available - total);
  const overBudget = total > available;

  const toggle = (id: string) => {
    if (selected.includes(id)) {
      setSelected((prev) => prev.filter((x) => x !== id));
      return;
    }
    const plan = plans.find((p) => p.rent_request_id === id);
    const cost = Number(plan?.funding_amount || 0);
    if (cost > remaining) {
      toast.error(
        `Not enough withdrawable balance. This plan needs ${formatDynamic(cost)} and you have ${formatDynamic(remaining)} left to fund.`,
      );
      return;
    }
    setSelected((prev) => [...prev, id]);
  };

  const openDeploy = () => {
    if (total < MIN_FUNDING) {
      toast.error(`Minimum funding is ${formatDynamic(MIN_FUNDING)}.`);
      return;
    }
    if (total > available) {
      toast.error('Your withdrawable balance is not enough for this selection.');
      return;
    }
    setDeployOpen(true);
  };

  const handleDeployed = async () => {
    setSelected([]);
    await Promise.all([load(), loadFunded()]);
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Card className="p-4 rounded-2xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-muted-foreground">Available to fund</p>
            <p className="text-lg font-black text-foreground">{formatDynamic(available)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Minimum {formatDynamic(MIN_FUNDING)} per plan
            </p>
            <p className="text-[10px] font-semibold text-muted-foreground mt-0.5">
              You can only select plans up to your withdrawable balance —{' '}
              {formatDynamic(remaining)} left to fund
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={busy}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </Card>

      {earnings && (earnings.nextPayoutDate || earnings.totalEarned > 0) && (
        <Card className="p-4 rounded-2xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground">Returns this cycle</p>
              <p className="text-lg font-black text-foreground">{formatDynamic(earnings.expectedThisCycle)}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Paid to date {formatDynamic(earnings.totalPaid)} of {formatDynamic(earnings.totalEarned)} earned
              </p>
            </div>
            <div className="text-right">
              <div className="flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
                <CalendarClock className="h-3.5 w-3.5" />
                <span>Next payout</span>
              </div>
              <p className="text-sm font-bold">
                {earnings.nextPayoutDate
                  ? new Date(earnings.nextPayoutDate).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })
                  : '—'}
              </p>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground mt-2">
            {earnings.nextPayoutDate
              ? `Returns pay into your withdrawable balance on the ${ordinal(new Date(earnings.nextPayoutDate).getDate())} of each month — your own contribution date.`
              : 'Returns start the day you deploy, then pay monthly on your deployment date.'}
          </p>
        </Card>
      )}

      {plans.length === 0 && (
        <Card className="p-6 rounded-2xl text-center">
          <Wallet className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm font-semibold">No approved plans awaiting money right now</p>
          <p className="text-xs text-muted-foreground mt-1">
            Plans appear here after approval and disappear once the landlord is paid.
          </p>
        </Card>
      )}

      {plans.length > 1 && (
        <div className="flex items-center justify-between gap-2 px-1">
          <p className="text-[11px] font-semibold text-muted-foreground">
            {plans.length} tenant plan{plans.length > 1 ? 's' : ''} available
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            disabled={busy}
            onClick={() => {
              if (selected.length > 0) {
                setSelected([]);
                return;
              }
              let budget = available;
              const picked: string[] = [];
              let skipped = 0;
              for (const p of plans) {
                if (fundedIds.includes(p.rent_request_id)) continue;
                if (p.held_by && p.held_by !== partnerId) continue;
                const cost = Number(p.funding_amount || 0);
                if (cost > budget) { skipped += 1; continue; }
                budget -= cost;
                picked.push(p.rent_request_id);
              }
              setSelected(picked);
              if (skipped > 0) {
                toast.info(
                  `Selected what your withdrawable balance of ${formatDynamic(available)} covers. ${skipped} plan${skipped > 1 ? 's' : ''} skipped — add funds to include ${skipped > 1 ? 'them' : 'it'}.`,
                );
              }
            }}
          >
            {selected.length > 0 ? 'Clear selection' : 'Select what I can afford'}
          </Button>
        </div>
      )}

      {plans
        .slice(page * PLANS_PER_PAGE, page * PLANS_PER_PAGE + PLANS_PER_PAGE)
        .map((plan) => {
        const isFunded = fundedIds.includes(plan.rent_request_id);
        const heldByOther = !!plan.held_by && plan.held_by !== partnerId;
        const isSelected = selected.includes(plan.rent_request_id);
        const unaffordable = !isSelected && Number(plan.funding_amount || 0) > remaining;
        const images = (plan.house_image_urls ?? []).filter(Boolean);
        const monthlyRoi = Math.round((Number(plan.funding_amount || 0) * MONTHLY_ROI_RATE) / 100);
        const prettyName = (raw?: string | null) =>
          (raw ?? '')
            .replace(/[_-]/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Rental home';
        const titleLine = `${prettyName(plan.house_category)}${plan.request_city ? ` in ${prettyName(plan.request_city)}` : ''}`;
        const village = plan.tenant_location?.split(',')[0]?.trim();
        const district = plan.request_city?.split(',')[0]?.trim();
        const addressLine = [village, district, 'Uganda'].filter(Boolean).join(', ');

        return (
          <Card
            key={plan.rent_request_id}
            data-plan-id={plan.rent_request_id}
            role="button"
            tabIndex={0}
            onClick={() => setDetailPlan(plan)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setDetailPlan(plan);
              }
            }}
            className={`relative overflow-hidden rounded-3xl p-2.5 transition-all cursor-pointer border ${isSelected ? 'ring-2 ring-primary bg-primary/5 border-primary' : 'border-primary/30 hover:border-primary/60'}`}
          >
            <div className="flex flex-col gap-3 sm:flex-row">
              {/* Photo */}
              <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden rounded-2xl bg-muted sm:aspect-square sm:w-32">
                {images.length > 0 ? (
                  <img src={images[0]} alt={titleLine} loading="lazy" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <Home className="h-7 w-7 text-muted-foreground" />
                  </div>
                )}
                {images.length > 1 && (
                  <span className="absolute bottom-1.5 right-1.5 rounded-full bg-background/85 px-1.5 py-0.5 text-[9px] font-bold backdrop-blur">
                    +{images.length - 1}
                  </span>
                )}
              </div>

              {/* Details */}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold leading-tight sm:text-base">{titleLine}</p>
                <p className="mt-0.5 flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
                  <MapPin className="mt-0.5 h-3 w-3 flex-none" />
                  <span className="line-clamp-2">{addressLine || 'Uganda'}</span>
                </p>

                {/* KPI chips */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
                    {MONTHLY_ROI_RATE}% / month
                  </span>
                  {plan.duration_days ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                      {plan.duration_days} days
                    </span>
                  ) : null}
                  {isFunded ? (
                    <Badge variant="secondary" className="rounded-full text-[10px] font-semibold">Funded by you</Badge>
                  ) : heldByOther ? (
                    <Badge variant="secondary" className="rounded-full text-[10px] font-semibold">On hold</Badge>
                  ) : null}
                </div>

                {/* Price row + action */}
                <div className="mt-2 flex items-end justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-base font-black leading-none sm:text-lg">
                      {formatDynamic(plan.funding_amount)}
                    </p>
                    <p className="mt-1 truncate text-[10px] text-muted-foreground">
                      Earn <span className="font-bold text-primary">{formatDynamic(monthlyRoi)}</span> monthly
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <PlanShareButton plan={plan} />
                    {!isFunded && (
                      <Button
                        size="icon"
                        variant={isSelected ? 'secondary' : 'default'}
                        disabled={heldByOther || busy || unaffordable}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(plan.rent_request_id);
                        }}
                        aria-label={`${isSelected ? 'Remove' : 'Select'} plan for ${plan.tenant_full_name ?? plan.tenant_first_name ?? 'tenant'}`}
                        className="h-10 w-10 shrink-0 rounded-full shadow-sm"
                      >
                        {isSelected ? <Check className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
                      </Button>
                    )}
                  </div>
                </div>

                {unaffordable && !heldByOther && (
                  <p className="mt-1.5 text-[10px] font-semibold text-muted-foreground">
                    Add {formatDynamic(Number(plan.funding_amount) - remaining)} to your balance to include this plan.
                  </p>
                )}
              </div>
            </div>
          </Card>
        );
      })}

      {plans.length > PLANS_PER_PAGE && (
        <div className="flex items-center justify-between gap-2 px-1 pt-1">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-[11px]"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            <span className="ml-1">Previous</span>
          </Button>
          <p className="text-[11px] font-semibold text-muted-foreground">
            Page {page + 1} of {Math.ceil(plans.length / PLANS_PER_PAGE)}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-[11px]"
            disabled={page >= Math.ceil(plans.length / PLANS_PER_PAGE) - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            <span className="mr-1">Next</span>
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {selected.length > 0 && (
        <Card className="mt-3 rounded-2xl border-primary/25 bg-background/95 p-3 sm:p-4 shadow-xl backdrop-blur-md">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-muted-foreground">
                {selected.length} plan{selected.length > 1 ? 's' : ''} selected
              </p>
              <SlotAmount
                value={total}
                className="text-xl sm:text-2xl font-black leading-none text-primary"
              />
            </div>
            <Button
              onClick={openDeploy}
              disabled={busy || total < MIN_FUNDING || overBudget}
              className="shrink-0 w-full sm:w-auto"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              <span className="ml-2">{activeCommitmentId ? 'Deploy or top up' : 'Fund now'}</span>
            </Button>
          </div>

          <div className="mt-3 flex flex-col gap-1.5 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-[11px] font-semibold text-muted-foreground">
              <TrendingUp className="h-3.5 w-3.5 text-primary shrink-0" />
              <span>Projected returns · {MONTHLY_ROI_RATE}% monthly</span>
            </div>
            <SlotAmount
              value={Math.round((total * MONTHLY_ROI_RATE) / 100)}
              className="text-sm sm:text-base font-black leading-none text-primary"
            />
          </div>

          {overBudget ? (
            <p className="mt-2 text-[10px] font-semibold text-destructive">
              This selection is {formatDynamic(total - available)} more than your withdrawable
              balance of {formatDynamic(available)}. Remove a plan or add funds.
            </p>
          ) : (
            <p className="mt-2 text-[10px] text-muted-foreground">
              {formatDynamic(remaining)} of your withdrawable balance still unused · returns
              start the day you deploy.
            </p>
          )}
        </Card>
      )}

      <SelfPortfolioDeployDialog
        open={deployOpen}
        onOpenChange={setDeployOpen}
        activeCommitmentId={activeCommitmentId}
        selectedIds={selected}
        total={total}
        onDeployed={handleDeployed}
      />

      <SelfPortfolioPlanDetailSheet
        plan={detailPlan}
        open={!!detailPlan}
        onOpenChange={(v) => !v && setDetailPlan(null)}
        isFunded={!!detailPlan && fundedIds.includes(detailPlan.rent_request_id)}
      />
    </div>
  );
}