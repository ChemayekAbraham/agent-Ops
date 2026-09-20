import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDynamic } from '@/lib/currencyFormat';
import { fetchAllPages } from '@/lib/fetchAllPages';
import { toast } from 'sonner';
import { Check, ChevronLeft, ChevronRight, Home, Loader2, MapPin, Plus, RefreshCw, ShieldCheck, TrendingUp, Wallet } from 'lucide-react';

import { SelfPortfolioDeployDialog } from './SelfPortfolioDeployDialog';
import { SelfPortfolioPlanDetailSheet } from './SelfPortfolioPlanDetailSheet';
import { PlanShareButton } from './PlanShareButton';
import { SlotAmount } from './SlotAmount';
import {
  HouseSupportBar,
  HouseSupportCard,
  useVerifiedEmptyHouses,
  type SupportableHouse,
} from './SelfSupportHousesSection';
import { EmptyHouseDetailSheet } from '@/components/agent/EmptyHouseDetailSheet';

const MIN_FUNDING = 50000;
const MONTHLY_ROI_RATE = 15;
const PLANS_PER_PAGE = 4;

export type FeedOrder = 'rent' | 'houses';



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
  proxy_agent_phone: string | null;
}

/**
 * Self Portfolio Management — Phase Two
 * Partner funds approved rent plans straight from their operational float.
 * Privacy: tenant first name only, landlord name shown, no contact details ever leave the server.
 */
export function SelfPortfolioFundingCard({
  partnerId,
  feedOrder,
  onFeedOrderChange,
}: {
  partnerId: string;
  feedOrder: FeedOrder;
  onFeedOrderChange: (value: FeedOrder) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [detailPlan, setDetailPlan] = useState<FundablePlan | null>(null);
  const [page, setPage] = useState(0);
  const [houseSelected, setHouseSelected] = useState<string[]>([]);
  const [detailHouse, setDetailHouse] = useState<SupportableHouse | null>(null);
  // Short code arriving from a branded /s/<code> share link (?share=<code>).
  const [sharedPlanId, setSharedPlanId] = useState<string | null>(null);


  // Cached so returning to this tab paints instantly; refreshes happen silently.
  const plansQuery = useQuery({
    queryKey: ['psm-fundable-plans'],
    queryFn: async () => {
      const { items, total, meta } = await fetchAllPages<FundablePlan, { available: number }>({
        pageSize: 100,
        concurrency: 8,
        fetchPage: async (offset, limit) => {
          const { data, error } = await supabase.rpc('partner_self_list_fundable_plans', {
            p_limit: limit,
            p_offset: offset,
          });
          if (error) throw error;
          const payload = (data ?? {}) as {
            plans?: FundablePlan[];
            total?: number;
            available_balance?: number;
          };
          const batch = payload.plans ?? [];
          return {
            items: batch,
            total: Number(payload.total ?? batch.length),
            meta: { available: Number(payload.available_balance ?? 0) },
          };
        },
      });

      return {
        plans: items,
        total,
        available: meta?.available ?? 0,
      };

    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const fundedQuery = useQuery({
    queryKey: ['psm-self-portfolio', partnerId],
    enabled: !!partnerId,
    queryFn: async () => {
      const { data } = await supabase.rpc('partner_self_portfolio', { p_partner_id: partnerId });
      const payload = (data ?? {}) as {
        lines?: { rent_request_id: string; status?: string; principal?: number }[];
        commitments?: {
          id?: string;
          status?: string;
          next_payout_at?: string | null;
          monthly_rate?: number;
          created_at?: string;
          committed_amount?: number;
          kind?: 'rent' | 'houses' | 'unknown';
          portfolio_code?: string | null;
        }[];
        totals?: { total_earned?: number; total_paid?: number; active?: number };
      };

      // Newest active portfolio per kind. Rent-plan capital may only top up a
      // rent portfolio, house capital only a house portfolio — the flows differ.
      const activeCommitments = (payload.commitments ?? [])
        .filter((c) => c.status === 'active')
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));

      const rentCommitment = activeCommitments.find((c) => c.kind === 'rent') ?? null;
      const houseCommitment = activeCommitments.find((c) => c.kind === 'houses') ?? null;

      return {
        fundedIds: (payload.lines ?? []).map((l) => l.rent_request_id),
        activeCommitmentId: rentCommitment?.id ?? null,
        houseCommitment: houseCommitment
          ? {
              id: String(houseCommitment.id),
              committed_amount: Number(houseCommitment.committed_amount ?? 0),
              portfolio_code: houseCommitment.portfolio_code ?? null,
            }
          : null,
      };
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const housesQuery = useVerifiedEmptyHouses();

  const plans = plansQuery.data?.plans ?? [];

  const houses = housesQuery.data?.houses ?? [];
  const available = plansQuery.data?.available ?? 0;
  const fundedIds = fundedQuery.data?.fundedIds ?? [];
  const activeCommitmentId = fundedQuery.data?.activeCommitmentId ?? null;
  const activeHouseCommitment = fundedQuery.data?.houseCommitment ?? null;

  
  // Only the very first load blocks the card; refetches keep the cards on screen.
  const loading = (plansQuery.isLoading && !plansQuery.data) || (housesQuery.isLoading && !housesQuery.data);


  const load = useCallback(async () => {
    await Promise.all([plansQuery.refetch(), housesQuery.refetch()]);
    setPage(0);
  }, [plansQuery, housesQuery]);

  const loadFunded = useCallback(async () => {
    await fundedQuery.refetch();
  }, [fundedQuery]);


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
    onFeedOrderChange('rent');
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

  const houseTotal = useMemo(
    () =>
      houses
        .filter((h) => houseSelected.includes(h.house_id))
        .reduce((sum, h) => sum + Number(h.monthly_rent || 0), 0),
    [houses, houseSelected],
  );

  // Both lists draw from the same operational float.
  const remaining = Math.max(0, available - total - houseTotal);
  const overBudget = total + houseTotal > available;

  // The dashboard switch intentionally separates ready-tenant Rent Plans from
  // vacant houses so supporters always know which funding path they are using.
  type FeedItem =
    | { kind: 'plan'; id: string; plan: FundablePlan }
    | { kind: 'house'; id: string; house: SupportableHouse };

  const feed = useMemo<FeedItem[]>(() => {
    const planItems: FeedItem[] = plans.map((plan) => ({
      kind: 'plan',
      id: plan.rent_request_id,
      plan,
    }));
    const houseItems: FeedItem[] = houses.map((house) => ({
      kind: 'house',
      id: house.house_id,
      house,
    }));
    return feedOrder === 'houses' ? houseItems : planItems;
  }, [plans, houses, feedOrder]);

  const pageCount = Math.max(1, Math.ceil(feed.length / PLANS_PER_PAGE));
  const pageStart = page * PLANS_PER_PAGE;
  const pageItems = feed.slice(pageStart, pageStart + PLANS_PER_PAGE);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  const toggle = (id: string) => {
    if (selected.includes(id)) {
      setSelected((prev) => prev.filter((x) => x !== id));
      return;
    }
    if (houseSelected.length > 0) {
      toast.error('You can fund either rent plans or houses in one submission — not both. Clear your selected houses first.');
      return;
    }
    const plan = plans.find((p) => p.rent_request_id === id);
    const cost = Number(plan?.funding_amount || 0);
    if (cost > remaining) {
      toast.error(
        `Not enough operational float. This plan needs ${formatDynamic(cost)} and you have ${formatDynamic(remaining)} left to fund.`,
      );
      return;
    }
    setSelected((prev) => [...prev, id]);
  };

  const toggleHouse = (id: string) => {
    if (houseSelected.includes(id)) {
      setHouseSelected((prev) => prev.filter((x) => x !== id));
      return;
    }
    if (selected.length > 0) {
      toast.error('You can fund either rent plans or houses in one submission — not both. Clear your selected rent plans first.');
      return;
    }
    const house = houses.find((h) => h.house_id === id);
    const cost = Number(house?.monthly_rent || 0);
    if (cost > remaining) {
      toast.error(
        `Not enough operational float. This house needs ${formatDynamic(cost)} and you have ${formatDynamic(remaining)} left to fund.`,
      );
      return;
    }
    setHouseSelected((prev) => [...prev, id]);
  };



  const openDeploy = () => {
    if (total < MIN_FUNDING) {
      toast.error(`Minimum funding is ${formatDynamic(MIN_FUNDING)}.`);
      return;
    }
    if (total > available) {
      toast.error('Your operational float is not enough for this selection.');
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
      <Card className="p-3 sm:p-4 rounded-xl sm:rounded-2xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-muted-foreground">Available to fund</p>
            <p className="text-base sm:text-lg font-black text-foreground">{formatDynamic(available)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Minimum {formatDynamic(MIN_FUNDING)} per plan
            </p>
            <p className="hidden sm:block text-[10px] font-semibold text-muted-foreground mt-0.5">
              You can only select plans up to your operational float —{' '}
              {formatDynamic(remaining)} left to fund
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={busy}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </Card>
      <p className="text-[11px] font-semibold text-muted-foreground px-1">
        {plans.length} rent request{plans.length === 1 ? '' : 's'} · {houses.length} house
        {houses.length === 1 ? '' : 's'}
      </p>


      {feed.length === 0 && (
        <Card className="p-6 rounded-2xl text-center">
          <Wallet className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm font-semibold">Nothing awaiting money right now</p>
          <p className="text-xs text-muted-foreground mt-1">
            Rent requests appear here after approval, and verified empty houses appear as soon as they are listed.
          </p>
        </Card>
      )}





      {pageItems.map((item, i) => {
        const globalIndex = pageStart + i;
        const prevKind = globalIndex > 0 ? feed[globalIndex - 1].kind : null;
        const groupHeader =
          globalIndex > 0 && prevKind !== item.kind ? (
            <div key={`hr-${item.kind}`} className="flex items-center gap-2 px-1 pt-2">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[10px] font-black uppercase tracking-wider text-muted-foreground">
                {item.kind === 'house' ? 'Houses' : 'Rent requests'}
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
          ) : null;

        if (item.kind === 'house') {
          return (
            <div key={`house-${item.id}`} className="space-y-3">
              {groupHeader}
              <HouseSupportCard
                house={item.house}
                isSelected={houseSelected.includes(item.id)}
                remaining={remaining}
                busy={busy}
                onToggle={toggleHouse}
                onOpenDetail={setDetailHouse}
              />
            </div>
          );
        }

        return (
          <div key={`plan-${item.id}`} className="space-y-3">
            {groupHeader}
            {(() => {
        const plan = item.plan;

        const isFunded = fundedIds.includes(plan.rent_request_id);
        const heldByOther = !!plan.held_by && plan.held_by !== partnerId;
        const isSelected = selected.includes(plan.rent_request_id);
        const unaffordable = !isSelected && Number(plan.funding_amount || 0) > remaining;
        const images = (plan.house_image_urls ?? []).filter(Boolean);
        const monthlyRoi = Math.round((Number(plan.funding_amount || 0) * MONTHLY_ROI_RATE) / 100);
        const planMonths = plan.duration_days ? Math.max(1, Math.round(Number(plan.duration_days) / 30)) : 1;
        const totalReturn = monthlyRoi * planMonths;
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
            className={`relative overflow-hidden rounded-2xl p-0 transition-all cursor-pointer border ${isSelected ? 'ring-2 ring-primary bg-primary/5 border-primary' : 'border-primary/30 hover:border-primary/60'}`}
          >
            <div className="flex flex-col">
              {/* Photo */}
              <div className="relative aspect-[16/10] sm:aspect-[4/3] w-full shrink-0 overflow-hidden bg-muted">
                {images.length > 0 ? (
                  <img src={images[0]} alt={titleLine} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <Home className="h-7 w-7 text-muted-foreground" />
                  </div>
                )}
                {/* Card-type badge: this row is a tenant rent plan. */}
                <span className="absolute left-1.5 top-1.5 rounded-full bg-primary px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-primary-foreground shadow-sm">
                  Rent plan
                </span>
                {images.length > 1 && (
                  <span className="absolute bottom-1.5 right-1.5 rounded-full bg-background/85 px-1.5 py-0.5 text-[9px] font-bold backdrop-blur">
                    +{images.length - 1}
                  </span>
                )}
              </div>

              {/* Details */}
              <div className="min-w-0 flex-1 p-4">
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
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <PlanShareButton plan={plan} />
                    {!isFunded && (
                      <Button
                        size="icon"
                        variant={isSelected ? 'secondary' : 'default'}
                        disabled={heldByOther || busy}
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

                {/* Earnings breakdown: monthly amount, timeframe, total return */}
                <div className="mt-2.5 grid grid-cols-3 gap-1.5 rounded-xl bg-primary/5 px-2.5 py-2">
                  <div className="min-w-0">
                    <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">You earn</p>
                    <p className="truncate text-xs font-black text-primary sm:text-sm">{formatDynamic(monthlyRoi)}</p>
                    <p className="text-[9px] text-muted-foreground">per month</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">For</p>
                    <p className="truncate text-xs font-black sm:text-sm">{planMonths} {planMonths === 1 ? 'month' : 'months'}</p>
                    <p className="text-[9px] text-muted-foreground">{plan.duration_days ? `${plan.duration_days} days` : 'plan term'}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">Total return</p>
                    <p className="truncate text-xs font-black text-primary sm:text-sm">{formatDynamic(totalReturn)}</p>
                    <p className="text-[9px] text-muted-foreground">by plan end</p>
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
            })()}
          </div>
        );
      })}

      {feed.length > PLANS_PER_PAGE && (
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
            {pageStart + 1}–{Math.min(pageStart + PLANS_PER_PAGE, feed.length)} of {feed.length} · Page {page + 1} of {pageCount}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-[11px]"
            disabled={page >= pageCount - 1}
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
              This selection is {formatDynamic(total - available)} more than your operational
              float of {formatDynamic(available)}. Remove a plan or add funds.
            </p>
          ) : (
            <p className="mt-2 text-[10px] text-muted-foreground">
              {formatDynamic(remaining)} of your operational float still unused · returns
              start the day you deploy.
            </p>
          )}
        </Card>
      )}

      {houseSelected.length > 0 && (
        <HouseSupportBar
          selectedCount={houseSelected.length}
          total={houseTotal}
          available={Math.max(0, available - total)}
          busy={busy}
          setBusy={setBusy}
          selectedIds={houseSelected}
          activeHouseCommitment={activeHouseCommitment}

          onSubmitted={async (outcome) => {
            setHouseSelected([]);
            await housesQuery.refetch();
            if (outcome === 'submitted') await loadFunded();
          }}
        />
      )}

      <EmptyHouseDetailSheet
        house={detailHouse}
        open={!!detailHouse}
        onOpenChange={(v) => !v && setDetailHouse(null)}
        isPartner
        isPicked={!!detailHouse && houseSelected.includes(detailHouse.house_id)}
        onTogglePick={(h) => toggleHouse(h.house_id)}
      />


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