import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { formatDynamic } from '@/lib/currencyFormat';
import { toast } from 'sonner';
import { Check, Home, Loader2, MapPin, Plus, ShieldCheck, TrendingUp, UserCheck } from 'lucide-react';
import type { HouseOpportunity } from '@/components/agent/EmptyHouseDetailSheet';

export const HOUSE_MONTHLY_ROI_RATE = 15;
export const HOUSE_MIN_FUNDING = 50000;

export type SupportableHouse = HouseOpportunity;

const prettyName = (raw?: string | null) =>
  (raw ?? '')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Rental home';

export const houseTitleLine = (house: SupportableHouse) =>
  house.title?.trim() ||
  `${prettyName(house.house_category)}${house.district ? ` in ${prettyName(house.district)}` : ''}`;

export const houseAddressLine = (house: SupportableHouse) =>
  [house.village, house.sub_county, house.district, 'Uganda'].filter(Boolean).join(', ');

/**
 * Verified empty houses a partner can support directly.
 *
 * No tenant is attached, so there is no repayment schedule, no landlord float
 * release and no agent float release. The selection total becomes the portfolio
 * principal, pends until Partner Operations approve it, and is booked as
 * self-support operational funding tagged per house.
 */
export function useVerifiedEmptyHouses() {
  return useQuery({
    queryKey: ['psh-verified-empty-houses'],
    queryFn: async () => {
      const pageSize = 100;
      const houses: SupportableHouse[] = [];
      let offset = 0;
      let total = 0;

      do {
        const { data, error } = await supabase.rpc('agent_list_empty_house_opportunities', {
          p_search: null,
          p_limit: pageSize,
          p_offset: offset,
          p_district: null,
          p_verified_only: true,
          p_gps_only: false,
          p_min_rent: null,
          p_max_rent: null,
          p_near_lat: null,
          p_near_lng: null,
          p_radius_km: null,
        });
        if (error) throw error;
        const payload = (data ?? {}) as { houses?: SupportableHouse[]; total?: number };
        const batch = payload.houses ?? [];
        houses.push(...batch);
        total = Number(payload.total ?? houses.length);
        offset += batch.length;
        if (batch.length === 0) break;
      } while (offset < total);

      return {
        houses: houses.filter(
          (h) => h.verified === true && Number(h.monthly_rent) > 0,
        ),
        total,
      };
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

/** One selectable verified empty house, styled to match the tenant plan cards. */
export function HouseSupportCard({
  house,
  isSelected,
  remaining,
  busy,
  onToggle,
  onOpenDetail,
}: {
  house: SupportableHouse;
  isSelected: boolean;
  remaining: number;
  busy: boolean;
  onToggle: (id: string) => void;
  onOpenDetail: (house: SupportableHouse) => void;
}) {
  const images = (house.image_urls ?? []).filter(Boolean);
  const monthlyRoi = Math.round((Number(house.monthly_rent || 0) * HOUSE_MONTHLY_ROI_RATE) / 100);
  const titleLine = houseTitleLine(house);
  const addressLine = houseAddressLine(house);
  const unaffordable = !isSelected && Number(house.monthly_rent || 0) > remaining;

  return (
    <Card
      data-house-id={house.house_id}
      role="button"
      tabIndex={0}
      onClick={() => onOpenDetail(house)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpenDetail(house);
        }
      }}
      className={`relative overflow-hidden rounded-3xl p-2.5 transition-all cursor-pointer border ${
        isSelected ? 'ring-2 ring-primary bg-primary/5 border-primary' : 'border-primary/30 hover:border-primary/60'
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden rounded-2xl bg-muted sm:aspect-square sm:w-32">
          {images.length > 0 ? (
            <img
              src={images[0]}
              alt={titleLine}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
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

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold leading-tight sm:text-base">{titleLine}</p>
          <p className="mt-0.5 flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
            <MapPin className="mt-0.5 h-3 w-3 flex-none" />
            <span className="line-clamp-2">{addressLine || 'Uganda'}</span>
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
              {HOUSE_MONTHLY_ROI_RATE}% / month
            </span>
            <Badge variant="secondary" className="rounded-full text-[10px] font-semibold">
              Verified
            </Badge>
            {house.landlord_name ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                {house.landlord_name}
              </span>
            ) : null}
          </div>

          {/* Fall-back agent on record: who places the tenant for this house. */}
          <p className="mt-1.5 flex items-center gap-1 text-[10px] font-semibold text-muted-foreground">
            <UserCheck className="h-3 w-3 flex-none text-primary" />
            <span className="truncate">
              {house.listing_agent_name
                ? `Agent on record · ${house.listing_agent_name}`
                : 'Agent on record · assigned by Agent Operations'}
            </span>
          </p>

          <div className="mt-2 flex items-end justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-base font-black leading-none sm:text-lg">
                {formatDynamic(house.monthly_rent)}
              </p>
              <p className="mt-1 truncate text-[10px] text-muted-foreground">
                Earn <span className="font-bold text-primary">{formatDynamic(monthlyRoi)}</span> monthly
              </p>
            </div>
            <Button
              size="icon"
              variant={isSelected ? 'secondary' : 'default'}
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onToggle(house.house_id);
              }}
              aria-label={`${isSelected ? 'Remove' : 'Select'} house ${titleLine}`}
              className="h-10 w-10 shrink-0 rounded-full shadow-sm"
            >
              {isSelected ? <Check className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
            </Button>
          </div>

          {unaffordable && (
            <p className="mt-1.5 text-[10px] font-semibold text-muted-foreground">
              Add {formatDynamic(Number(house.monthly_rent) - remaining)} to your balance to include this house.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Submit bar for a selected set of verified empty houses. */
export function HouseSupportBar({
  selectedCount,
  total,
  available,
  busy,
  setBusy,
  selectedIds,
  onSubmitted,
}: {
  selectedCount: number;
  total: number;
  available: number;
  busy: boolean;
  setBusy: (v: boolean) => void;
  selectedIds: string[];
  onSubmitted: (outcome: 'submitted' | 'stale') => void;
}) {
  const overBudget = total > available;

  const submit = async () => {
    if (total < HOUSE_MIN_FUNDING) {
      toast.error(`Minimum funding is ${formatDynamic(HOUSE_MIN_FUNDING)}.`);
      return;
    }
    if (overBudget) {
      toast.error('Your withdrawable balance is not enough for this selection.');
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.rpc('partner_support_houses', {
        p_house_ids: selectedIds,
        p_term_months: 1,
      });
      if (error) throw error;
      toast.success('Submitted — pending approval', {
        description: `Partner Operations will review your ${formatDynamic(total)} house portfolio. Your money stays in your wallet until it is approved, and your confirmation email is sent once approval goes through.`,
        duration: 9000,
      });
      onSubmitted('submitted');
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'Submission failed';
      if (raw.includes('AGREEMENT_REQUIRED')) {
        toast.error('Sign your partner agreement first', {
          description: 'A signed partnership agreement is required before you can create a portfolio.',
        });
      } else if (raw.includes('HOUSES_UNAVAILABLE')) {
        toast.error('Some houses are no longer available. Refresh and reselect.');
        onSubmitted('stale');
      } else if (raw.includes('PARTNER_FUNDS_SHORT')) {
        toast.error('Your withdrawable balance does not cover this selection.');
      } else {
        toast.error(raw);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-3 rounded-2xl border-primary/25 bg-background/95 p-3 sm:p-4 shadow-xl backdrop-blur-md">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-muted-foreground">
            {selectedCount} house{selectedCount > 1 ? 's' : ''} selected
          </p>
          <p className="text-xl sm:text-2xl font-black leading-none text-primary">{formatDynamic(total)}</p>
        </div>
        <Button
          onClick={() => void submit()}
          disabled={busy || total < HOUSE_MIN_FUNDING || overBudget}
          className="shrink-0 w-full sm:w-auto"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          <span className="ml-2">Fund these houses</span>
        </Button>
      </div>

      <div className="mt-3 flex flex-col gap-1.5 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-[11px] font-semibold text-muted-foreground">
          <TrendingUp className="h-3.5 w-3.5 text-primary shrink-0" />
          <span>Projected returns · {HOUSE_MONTHLY_ROI_RATE}% monthly</span>
        </div>
        <p className="text-sm sm:text-base font-black leading-none text-primary">
          {formatDynamic(Math.round((total * HOUSE_MONTHLY_ROI_RATE) / 100))}
        </p>
      </div>

      {overBudget ? (
        <p className="mt-2 text-[10px] font-semibold text-destructive">
          This selection is {formatDynamic(total - available)} more than your withdrawable balance of{' '}
          {formatDynamic(available)}. Remove a house or add funds.
        </p>
      ) : (
        <p className="mt-2 text-[10px] text-muted-foreground">
          Your money stays in your wallet until Partner Operations approve. No landlord or agent payout happens —
          no tenant is involved yet.
        </p>
      )}
    </Card>
  );
}
