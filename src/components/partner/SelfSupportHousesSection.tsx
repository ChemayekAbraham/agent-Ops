import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatDynamic } from '@/lib/currencyFormat';
import { fetchAllPages } from '@/lib/fetchAllPages';
import { toast } from 'sonner';
import { Check, Home, Loader2, MapPin, Plus, ShieldCheck, TrendingUp, UserCheck, Wallet } from 'lucide-react';
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

/** Renders text with the matching search query highlighted. */
export function HighlightText({
  text,
  query,
  className,
}: {
  text: string;
  query?: string;
  className?: string;
}) {
  if (!query || !text) return <>{text}</>;
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    const index = remaining.toLowerCase().indexOf(normalizedQuery);
    if (index === -1) {
      parts.push(<span key={key++}>{remaining}</span>);
      break;
    }
    if (index > 0) {
      parts.push(<span key={key++}>{remaining.slice(0, index)}</span>);
    }
    parts.push(
      <mark
        key={key++}
        className={`rounded-sm bg-primary/20 px-0.5 text-foreground ${className ?? ''}`}
      >
        {remaining.slice(index, index + normalizedQuery.length)}
      </mark>,
    );
    remaining = remaining.slice(index + normalizedQuery.length);
  }

  return <>{parts}</>;
}

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
      const { items, total } = await fetchAllPages<SupportableHouse>({
        pageSize: 100,
        concurrency: 8,
        fetchPage: async (offset, limit) => {
          const { data, error } = await supabase.rpc('agent_list_empty_house_opportunities', {
            p_search: null,
            p_limit: limit,
            p_offset: offset,
            p_district: null,
            p_verified_only: true,
            p_gps_only: true,
            p_min_rent: null,
            p_max_rent: null,
            p_near_lat: null,
            p_near_lng: null,
            p_radius_km: null,
            // The backend currently has both the legacy 11-argument RPC and the
            // sortable 12-argument RPC. Passing p_sort makes this call resolve to
            // the current overload instead of failing as ambiguous and returning
            // an empty house list to the combined feed.
            p_sort: 'newest',
          });
          if (error) throw error;
          const payload = (data ?? {}) as { houses?: SupportableHouse[]; total?: number };
          const batch = payload.houses ?? [];
          return { items: batch, total: Number(payload.total ?? batch.length) };
        },
      });

      return {
        houses: items.filter((h) => h.verified === true && Number(h.monthly_rent) > 0),
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
  onTopUp,
  flash = false,
  searchQuery = '',
}: {
  house: SupportableHouse;
  isSelected: boolean;
  remaining: number;
  busy: boolean;
  onToggle: (id: string) => void;
  onOpenDetail: (house: SupportableHouse) => void;
  /** Opens the funding flow with the exact missing amount prefilled. */
  onTopUp?: (shortfall: number) => void;
  /** Momentary highlight (e.g. after a "now fundable" notification action). */
  flash?: boolean;
  /** Search query used to highlight matching house names and locations. */
  searchQuery?: string;
}) {
  const images = (house.image_urls ?? []).filter(Boolean);
  const monthlyRoi = Math.round((Number(house.monthly_rent || 0) * HOUSE_MONTHLY_ROI_RATE) / 100);
  const titleLine = houseTitleLine(house);
  const addressLine = houseAddressLine(house);
  const shortfall = Number(house.monthly_rent || 0) - remaining;
  const unaffordable = shortfall > 0;

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
      className={`relative overflow-hidden rounded-2xl p-0 transition-all cursor-pointer border ${
        flash
          ? 'ring-4 ring-success/70 bg-success/10 border-success shadow-lg'
          : isSelected
            ? 'ring-2 ring-primary bg-primary/5 border-primary'
            : 'border-primary/30 hover:border-primary/60'
      }`}
    >
      <div className="flex flex-col">
        <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden bg-muted">
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
          {/* Card-type badge: this row is an empty house, no tenant attached. */}
          <span className="absolute left-1.5 top-1.5 rounded-full bg-secondary px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-secondary-foreground shadow-sm">
            House
          </span>
          {images.length > 1 && (
            <span className="absolute bottom-1.5 right-1.5 rounded-full bg-background/85 px-1.5 py-0.5 text-[9px] font-bold backdrop-blur">
              +{images.length - 1}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1 p-4">
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
            <p className={`mt-1.5 text-[10px] font-semibold ${isSelected ? 'text-primary' : 'text-muted-foreground'}`}>
              {isSelected
                ? `Picked — add ${formatDynamic(shortfall)} to your balance to fund it. It stays saved while you top up.`
                : `Add ${formatDynamic(shortfall)} to your balance to include this house.`}
            </p>
          )}

          {isSelected && unaffordable && onTopUp && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onTopUp(shortfall);
              }}
              aria-label={`Top up ${formatDynamic(shortfall)} to fund ${titleLine}`}
              className="mt-2 h-9 w-full rounded-xl border-primary/40 text-[11px] font-bold text-primary"
            >
              <Wallet className="mr-1.5 h-3.5 w-3.5" />
              Top up {formatDynamic(shortfall)}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

export interface ActiveHouseCommitment {
  id: string;
  committed_amount: number;
  portfolio_code: string | null;
}

/** Submit bar for a selected set of verified empty houses. */
export function HouseSupportBar({
  selectedCount,
  total,
  available,
  busy,
  setBusy,
  selectedIds,
  selectedHouses,
  activeHouseCommitment,
  onSubmitted,
  confirmRequestKey,
}: {
  selectedCount: number;
  total: number;
  available: number;
  busy: boolean;
  setBusy: (v: boolean) => void;
  selectedIds: string[];
  /** Selected house objects used to show a human-readable funding summary. */
  selectedHouses?: SupportableHouse[];
  /**
   * The partner's current ACTIVE house portfolio, if any. Houses can only be
   * added to a house portfolio — a rent-plan portfolio follows a different
   * flow — so this is null whenever they hold none, and the
   * "add to existing portfolio" choice is then not offered at all.
   */
  activeHouseCommitment?: ActiveHouseCommitment | null;
  onSubmitted: (outcome: 'submitted' | 'stale') => void;
  /**
   * Changing this key opens the confirmation dialog from outside (e.g. a
   * balance-ready notification's "Fund this house" action). The submit itself
   * still goes through the dialog's confirm button — nothing auto-submits.
   */
  confirmRequestKey?: string | null;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [target, setTarget] = useState<'existing' | 'new'>('existing');

  // An outside request (balance-ready notification) opens the same confirm
  // dialog the "Fund these houses" button opens. Keyed on change so repeated
  // notifications re-open it; the funder still confirms inside the dialog.
  useEffect(() => {
    if (confirmRequestKey) setConfirmOpen(true);
  }, [confirmRequestKey]);
  const overBudget = total > available;
  const canTopUp = !!activeHouseCommitment;
  const useExisting = canTopUp && target === 'existing';

  const doSubmit = async () => {
    if (total < HOUSE_MIN_FUNDING) {
      toast.error(`Minimum funding is ${formatDynamic(HOUSE_MIN_FUNDING)}.`);
      return;
    }
    if (overBudget) {
      toast.error('Your operational float is not enough for this selection.');
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.rpc('partner_support_houses', {
        p_house_ids: selectedIds,
        p_term_months: 1,
        p_commitment_id: useExisting ? activeHouseCommitment!.id : null,
      });
      if (error) throw error;
      toast.success('Submitted — pending approval', {
        description: useExisting
          ? `Partner Operations will review the ${formatDynamic(total)} you added to your existing house portfolio. Your money stays in your wallet until it is approved.`
          : `Partner Operations will review your ${formatDynamic(total)} house portfolio. Your money stays in your wallet until it is approved, and your confirmation email is sent once approval goes through.`,
        duration: 9000,
      });
      setConfirmOpen(false);
      onSubmitted('submitted');
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'Submission failed';
      if (raw.includes('AGREEMENT_REQUIRED')) {
        toast.error('Sign your partner agreement first', {
          description: 'A signed partnership agreement is required before you can create a portfolio.',
        });
      } else if (raw.includes('HOUSES_UNAVAILABLE')) {
        toast.error('Some houses are no longer available. Refresh and reselect.');
        setConfirmOpen(false);
        onSubmitted('stale');
      } else if (raw.includes('PARTNER_FUNDS_SHORT')) {
        toast.error('Your operational float does not cover this selection.');
      } else if (raw.includes('PORTFOLIO_KIND_MISMATCH')) {
        setTarget('new');
        toast.error('That portfolio funds rent plans. Houses start their own portfolio.');
      } else if (raw.includes('PSM_TOPUP_WINDOW_CLOSED')) {
        setTarget('new');
        toast.error(raw.replace(/^.*PSM_TOPUP_WINDOW_CLOSED:\s*/, ''));
      } else {
        toast.error(raw);
      }
    } finally {
      setBusy(false);
    }
  };


  return (
    <>
      <Card className="sticky bottom-3 z-40 mt-3 rounded-2xl border-primary/25 bg-background/95 p-3 sm:p-4 shadow-xl backdrop-blur-md">

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-muted-foreground">
              {selectedCount} house{selectedCount > 1 ? 's' : ''} selected
            </p>
            <p className="text-xl sm:text-2xl font-black leading-none text-primary">{formatDynamic(total)}</p>
          </div>
          <Button
            onClick={() => setConfirmOpen(true)}
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
            Add {formatDynamic(total - available)} to your balance to fund this selection. Your{' '}
            {selectedCount > 1 ? 'houses stay' : 'house stays'} picked while you top up.
          </p>
        ) : (
          <p className="mt-2 text-[10px] text-muted-foreground">
            Projected amount after 12 months:{' '}
            <span className="font-black text-primary">
              {formatDynamic(Math.round((total * HOUSE_MONTHLY_ROI_RATE * 12) / 100))}
            </span>
          </p>
        )}
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="w-[95vw] max-w-md sm:max-w-lg p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-4 sm:px-6 py-4 border-b">
            <DialogTitle className="text-base sm:text-lg flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" /> Confirm house funding
            </DialogTitle>
            <DialogDescription className="text-xs sm:text-sm">
              You are about to commit{' '}
              <span className="font-black text-primary">{formatDynamic(total)}</span> from your operational
              float to {selectedCount} house{selectedCount > 1 ? 's' : ''}. The portfolio will stay pending
              until Partner Operations approve it. No landlord or agent payout happens because no tenant is
              involved yet.
            </DialogDescription>
          </DialogHeader>

          <div className="px-4 sm:px-6 py-4 space-y-3">
            {/* Selected houses summary */}
            <div className="space-y-2">
              <p className="text-[11px] font-bold text-muted-foreground">
                You are funding {selectedCount} {selectedCount === 1 ? 'house' : 'houses'}
              </p>
              <div className="max-h-60 overflow-y-auto rounded-xl border border-border bg-background space-y-2 p-2">
                {(selectedHouses ?? []).length === 0 ? (
                  <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                    {formatDynamic(total)} total contribution
                  </p>
                ) : (
                  selectedHouses!.map((house) => {
                    const rent = Number(house.monthly_rent || 0);
                    const image = (house.image_urls ?? []).filter(Boolean)[0] ?? house.image_url;
                    return (
                      <div
                        key={house.house_id}
                        className="flex items-start gap-2.5 rounded-lg bg-muted/30 p-2"
                      >
                        {image ? (
                          <img
                            src={image}
                            alt={houseTitleLine(house)}
                            loading="lazy"
                            decoding="async"
                            className="h-14 w-16 shrink-0 rounded-md object-cover"
                          />
                        ) : (
                          <div className="flex h-14 w-16 shrink-0 items-center justify-center rounded-md bg-muted">
                            <Home className="h-5 w-5 text-muted-foreground" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-bold text-foreground">
                            {houseTitleLine(house)}
                          </p>
                          <p className="mt-0.5 flex items-start gap-1 text-[10px] leading-snug text-muted-foreground">
                            <MapPin className="mt-0.5 h-3 w-3 flex-none" />
                            <span className="line-clamp-2">{houseAddressLine(house) || 'Uganda'}</span>
                          </p>
                          <p className="mt-1 text-xs font-black text-primary">{formatDynamic(rent)}</p>
                        </div>
                      </div>
                    );
                  })
                )}
                <div className="flex items-center justify-between border-t border-border pt-2 px-1">
                  <span className="text-[11px] font-bold text-muted-foreground">Total contribution</span>
                  <span className="text-sm font-black text-foreground">{formatDynamic(total)}</span>
                </div>
              </div>
            </div>

            {canTopUp && (
              <div className="space-y-2">
                <p className="text-[11px] font-bold text-muted-foreground">Where should this capital go?</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setTarget('existing')}
                  aria-pressed={target === 'existing'}
                  className={`w-full text-left rounded-xl border p-3 transition-colors ${
                    target === 'existing' ? 'border-primary bg-primary/5' : 'border-border'
                  }`}
                >
                  <p className="flex items-center gap-2 text-sm font-bold">
                    <Plus className="h-4 w-4 text-primary shrink-0" />
                    Add to my house portfolio
                    {activeHouseCommitment?.portfolio_code ? (
                      <Badge variant="secondary" className="text-[10px]">
                        {activeHouseCommitment.portfolio_code}
                      </Badge>
                    ) : null}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Currently holding {formatDynamic(activeHouseCommitment?.committed_amount ?? 0)}. These
                    houses join it and share its monthly payout date.
                  </p>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setTarget('new')}
                  aria-pressed={target === 'new'}
                  className={`w-full text-left rounded-xl border p-3 transition-colors ${
                    target === 'new' ? 'border-primary bg-primary/5' : 'border-border'
                  }`}
                >
                  <p className="flex items-center gap-2 text-sm font-bold">
                    <Home className="h-4 w-4 text-primary shrink-0" />
                    Start a new house portfolio
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Fresh start date with its own monthly payout anniversary.
                  </p>
                </button>
              </div>
            )}
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs space-y-1">

              <div className="flex justify-between">
                <span className="text-muted-foreground">Principal</span>
                <span className="font-black text-foreground">{formatDynamic(total)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Monthly return ({HOUSE_MONTHLY_ROI_RATE}%)</span>
                <span className="font-black text-foreground">
                  {formatDynamic(Math.round((total * HOUSE_MONTHLY_ROI_RATE) / 100))}
                </span>
              </div>
              <div className="flex justify-between border-t border-primary/10 pt-1">
                <span className="text-muted-foreground">Projected 12-month amount</span>
                <span className="font-black text-primary">
                  {formatDynamic(Math.round((total * HOUSE_MONTHLY_ROI_RATE * 12) / 100))}
                </span>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Your money stays in your wallet until approval. You can track this portfolio under your
              Self-Managed Portfolio once it is active.
            </p>
          </div>

          <DialogFooter className="px-4 sm:px-6 py-3 border-t bg-muted/30 flex-row justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void doSubmit()} disabled={busy} className="gap-1.5">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              <span className="ml-2">Yes, fund these houses</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
