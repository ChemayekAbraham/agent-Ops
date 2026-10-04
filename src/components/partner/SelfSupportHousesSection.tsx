import { useEffect, useRef, useState } from 'react';
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
import { Bookmark, Car, Check, Home, Loader2, MapPin, Navigation, Plus, Share2, ShieldCheck, TrendingUp, UserCheck, Wallet } from 'lucide-react';
import { estimateRoute } from '@/lib/houseGeo';
import type { HouseOpportunity } from '@/components/agent/EmptyHouseDetailSheet';
import { FundHouseTooltip } from './FundHouseTooltip';

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


/** One selectable verified empty house — Google Maps hotel-card style. */
export function HouseSupportCard({
  house,
  isSelected,
  remaining,
  busy,
  onToggle,
  onOpenDetail,
  onTopUp,
  flash = false,
  searchQuery,
  origin = null,
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
  /** Point the distance / travel-time labels are measured from (funder's location or the house tapped on the map). */
  origin?: { lat: number; lng: number } | null;
}) {
  const images = (house.image_urls ?? []).filter(Boolean);
  const monthlyRoi = Math.round((Number(house.monthly_rent || 0) * HOUSE_MONTHLY_ROI_RATE) / 100);
  const titleLine = houseTitleLine(house);
  const addressLine = houseAddressLine(house);
  const shortfall = Number(house.monthly_rent || 0) - remaining;
  const unaffordable = shortfall > 0;
  const route = origin ? estimateRoute(house, origin.lat, origin.lng) : null;
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleShare = (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = `${window.location.origin}/houses/${house.house_id}`;
    if (navigator.share) {
      navigator.share({ title: titleLine, url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(url);
      toast.success('Link copied');
    }
  };

  return (
    <div
      data-house-id={house.house_id}
      className={`border-b border-border/60 pb-4 last:border-b-0 last:pb-0 ${
        flash ? 'bg-success/5' : ''
      }`}
    >
      {/* ── Title + subtitle ── */}
      <button
        type="button"
        className="w-full text-left"
        onClick={() => onOpenDetail(house)}
      >
        <p className="text-[15px] font-bold leading-tight text-foreground">
          <HighlightText text={titleLine} query={searchQuery} />
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-muted-foreground">
          <span className="inline-flex items-center gap-0.5 font-semibold text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="h-3 w-3" />
            Verified
          </span>
          <span>·</span>
          <span>{house.district || 'Uganda'}</span>
          {route && (
            <>
              <span>·</span>
              <span>{route.distanceLabel}</span>
            </>
          )}
        </p>
      </button>

      {/* ── Horizontal image carousel ── */}
      <div
        ref={scrollRef}
        className="mt-2.5 flex gap-1.5 overflow-x-auto scroll-smooth pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {images.length > 0 ? (
          images.slice(0, 3).map((src, idx) => (
            <button
              key={`img-${house.house_id}-${idx}`}
              type="button"
              onClick={() => onOpenDetail(house)}
              className="relative flex-none overflow-hidden rounded-xl first:rounded-l-xl last:rounded-r-xl"
            >
              <img
                src={src}
                alt={`${titleLine} photo ${idx + 1}`}
                loading="lazy"
                decoding="async"
                className="h-[120px] w-[160px] object-cover transition-transform hover:scale-[1.03]"
              />
              {/* Price overlay on last visible image */}
              {idx === Math.min(images.length, 3) - 1 && (
                <span className="absolute bottom-1.5 right-1.5 rounded-md bg-foreground/85 px-2 py-1 text-[12px] font-bold text-background shadow-lg backdrop-blur-sm">
                  {formatDynamic(house.monthly_rent)}
                </span>
              )}
            </button>
          ))
        ) : (
          <button
            type="button"
            onClick={() => onOpenDetail(house)}
            className="flex h-[120px] w-full items-center justify-center rounded-xl bg-muted"
          >
            <Home className="h-8 w-8 text-muted-foreground/40" />
          </button>
        )}
      </div>

      {/* ── Returns line ── */}
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Earn <span className="font-bold text-emerald-600 dark:text-emerald-400">{formatDynamic(monthlyRoi)}</span> monthly returns
        <span className="ml-1.5 text-[10px]">({HOUSE_MONTHLY_ROI_RATE}%)</span>
      </p>

      {/* ── Shortfall notice ── */}
      {unaffordable && (
        <p className={`mt-1 text-[10px] font-semibold ${isSelected ? 'text-primary' : 'text-muted-foreground'}`}>
          {isSelected
            ? `Picked — add ${formatDynamic(shortfall)} to fund it.`
            : `Add ${formatDynamic(shortfall)} to include this house.`}
        </p>
      )}

      {/* ── Action buttons (Google Maps style) ── */}
      <div className="mt-2.5 flex items-center gap-1">
        <Button
          size="sm"
          variant={isSelected ? 'secondary' : 'outline'}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(house.house_id);
          }}
          className="h-9 rounded-full px-4 text-xs font-semibold gap-1.5"
        >
          {isSelected ? <Check className="h-3.5 w-3.5" /> : <Home className="h-3.5 w-3.5" />}
          {isSelected ? 'Selected' : 'Fund'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleShare}
          className="h-9 rounded-full px-4 text-xs font-semibold gap-1.5"
        >
          <Share2 className="h-3.5 w-3.5" />
          Share
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={(e) => {
            e.stopPropagation();
            // Save functionality - toggle select as save-for-later
            if (!isSelected) onToggle(house.house_id);
          }}
          className="h-9 rounded-full px-4 text-xs font-semibold gap-1.5"
        >
          <Bookmark className="h-3.5 w-3.5" />
          Save
        </Button>
      </div>

      {/* Top-up CTA when selected but can't afford */}
      {isSelected && unaffordable && onTopUp && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            onTopUp(shortfall);
          }}
          className="mt-2 h-9 w-full rounded-xl border-primary/40 text-[11px] font-bold text-primary"
        >
          <Wallet className="mr-1.5 h-3.5 w-3.5" />
          Top up {formatDynamic(shortfall)}
        </Button>
      )}
    </div>
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
  refreshAvailable,
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
  /**
   * Re-reads the partner's available operational float from the server. The
   * `available` prop comes from a query cached for minutes, so a partner whose
   * float changed since the page loaded could see the Fund button refuse a
   * selection they can actually afford. Called before the confirm dialog opens
   * and before submitting. Returns the fresh figure.
   */
  refreshAvailable?: () => Promise<number>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [target, setTarget] = useState<'existing' | 'new'>('existing');
  // Fresh server figure once re-read; falls back to the cached prop.
  const [freshAvailable, setFreshAvailable] = useState<number | null>(null);
  // Set after a successful submission. The selection is only cleared — and the
  // funded houses only leave the list — when the partner closes this dialog,
  // because clearing it unmounts this bar (and anything rendered inside it).
  const [success, setSuccess] = useState<{
    total: number;
    count: number;
    topup: boolean;
    portfolioCode: string | null;
    houses: SupportableHouse[];
  } | null>(null);
  // The last submission error, shown inside the confirm dialog so it cannot be
  // missed the way a transient toast can.
  const [submitError, setSubmitError] = useState<string | null>(null);

  // An outside request (balance-ready notification) opens the same confirm
  // dialog the "Fund these houses" button opens. Keyed on change so repeated
  // notifications re-open it; the funder still confirms inside the dialog.
  useEffect(() => {
    if (confirmRequestKey) setConfirmOpen(true);
  }, [confirmRequestKey]);
  const effectiveAvailable = freshAvailable ?? available;
  const overBudget = total > effectiveAvailable;
  const canTopUp = !!activeHouseCommitment;
  const useExisting = canTopUp && target === 'existing';

  // Re-read the float from the server; never trust a cached figure to refuse.
  const readFreshAvailable = async (): Promise<number> => {
    if (!refreshAvailable) return effectiveAvailable;
    try {
      const fresh = await refreshAvailable();
      setFreshAvailable(fresh);
      return fresh;
    } catch {
      return effectiveAvailable;
    }
  };

  const openConfirm = async () => {
    setSubmitError(null);
    const fresh = await readFreshAvailable();
    if (total > fresh) {
      toast.error('Your operational float is not enough for this selection.', {
        description: `Available: ${formatDynamic(fresh)} · Selected: ${formatDynamic(total)}.`,
      });
      return;
    }
    setConfirmOpen(true);
  };

  const describeError = (raw: string): string => {
    if (raw.includes('AGREEMENT_REQUIRED')) {
      return 'Sign your partner agreement first. A signed partnership agreement is required before you can create a portfolio.';
    }
    if (raw.includes('HOUSES_UNAVAILABLE')) return 'Some houses are no longer available. Refresh and reselect.';
    if (raw.includes('PARTNER_FUNDS_SHORT')) return 'Your operational float does not cover this selection.';
    if (raw.includes('PORTFOLIO_KIND_MISMATCH')) return 'That portfolio funds rent plans. Houses start their own portfolio.';
    if (raw.includes('PSM_TOPUP_WINDOW_CLOSED')) return raw.replace(/^.*PSM_TOPUP_WINDOW_CLOSED:\s*/, '');
    return raw;
  };

  const doSubmit = async () => {
    setSubmitError(null);
    if (total < HOUSE_MIN_FUNDING) {
      const msg = `Minimum funding is ${formatDynamic(HOUSE_MIN_FUNDING)}.`;
      setSubmitError(msg);
      toast.error(msg);
      return;
    }
    setBusy(true);
    try {
      const fresh = await readFreshAvailable();
      if (total > fresh) {
        throw new Error('PARTNER_FUNDS_SHORT');
      }
      const { data, error } = await supabase.rpc('partner_support_houses', {
        p_house_ids: selectedIds,
        p_term_months: 1,
        p_commitment_id: useExisting ? activeHouseCommitment!.id : null,
      });
      if (error) throw error;
      const result = (data ?? {}) as { portfolio_code?: string | null };
      setConfirmOpen(false);
      setSuccess({
        total,
        count: selectedCount,
        topup: useExisting,
        portfolioCode: result.portfolio_code ?? activeHouseCommitment?.portfolio_code ?? null,
        houses: selectedHouses ?? [],
      });
    } catch (e) {
      const raw = e instanceof Error ? e.message : (e as { message?: string })?.message ?? 'Submission failed';
      // Leave a trace for support: a failed submit used to leave nothing behind.
      console.error('[house-support] submit failed', { raw, selectedIds, total });
      const msg = describeError(raw);
      setSubmitError(msg);
      toast.error(msg);
      if (raw.includes('PORTFOLIO_KIND_MISMATCH') || raw.includes('PSM_TOPUP_WINDOW_CLOSED')) {
        setTarget('new');
      }
      if (raw.includes('HOUSES_UNAVAILABLE')) {
        setConfirmOpen(false);
        onSubmitted('stale');
      }
    } finally {
      setBusy(false);
    }
  };

  // Closing the success dialog is what clears the selection and removes the
  // funded houses from the list (the parent refetches; the server no longer
  // offers a house once it is pending or active).
  const closeSuccess = () => {
    setSuccess(null);
    setFreshAvailable(null);
    onSubmitted('submitted');
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
          <FundHouseTooltip>
            <Button
              onClick={() => void openConfirm()}
              disabled={busy || total < HOUSE_MIN_FUNDING}
              className="shrink-0 w-full sm:w-auto"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              <span className="ml-2">Fund these houses</span>
            </Button>
          </FundHouseTooltip>
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
            Add {formatDynamic(total - effectiveAvailable)} to your balance to fund this selection. Your{' '}
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
            {submitError && (
              <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive">
                {submitError}
              </p>
            )}
          </div>

          <DialogFooter className="px-4 sm:px-6 py-3 border-t bg-muted/30 flex-row justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <FundHouseTooltip side="top">
              <Button size="sm" onClick={() => void doSubmit()} disabled={busy} className="gap-1.5">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                <span className="ml-2">Yes, fund these houses</span>
              </Button>
            </FundHouseTooltip>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Success — closing it clears the selection and removes the funded houses from the list. */}
      <Dialog open={!!success} onOpenChange={(open) => { if (!open) closeSuccess(); }}>
        <DialogContent className="w-[95vw] max-w-md p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-4 sm:px-6 py-4 border-b">
            <DialogTitle className="text-base sm:text-lg flex items-center gap-2">
              <Check className="h-4 w-4 text-primary" /> Submitted for approval
            </DialogTitle>
            <DialogDescription className="text-xs sm:text-sm">
              {success?.topup
                ? `You added ${formatDynamic(success?.total ?? 0)} to your house portfolio${success?.portfolioCode ? ` ${success.portfolioCode}` : ''}.`
                : `Your ${formatDynamic(success?.total ?? 0)} house portfolio has been created.`}{' '}
              Partner Operations will review it now.
            </DialogDescription>
          </DialogHeader>
          <div className="px-4 sm:px-6 py-4 space-y-3 text-xs">
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Houses supported</span>
                <span className="font-black text-foreground">{success?.count ?? 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-black text-foreground">{formatDynamic(success?.total ?? 0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <span className="font-black text-primary">Pending Partner Operations approval</span>
              </div>
            </div>
            <p className="text-muted-foreground leading-relaxed">
              {formatDynamic(success?.total ?? 0)} of your operational float is now held for this portfolio, so
              your available float is lower. It leaves your wallet only when Partner Operations approve.
            </p>
          </div>
          <DialogFooter className="px-4 sm:px-6 py-3 border-t bg-muted/30 flex-row justify-end">
            <Button size="sm" onClick={closeSuccess}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
