import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowRight,
  Check,
  Home,
  ImageIcon,
  Loader2,
  MapPin,
  Navigation,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatDynamic } from '@/lib/currencyFormat';
import {
  HOUSE_SHARE_ROI_RATE,
  clearHouseSupportIntent,
  getHouseSupportIntent,
  houseMapsUrl,
  logHouseShareEvent,
  saveHouseSupportIntent,
} from '@/lib/houseSupportShare';

interface SupportOffer {
  found: boolean;
  share_code?: string;
  house_id?: string;
  title?: string;
  house_category?: string | null;
  number_of_rooms?: number | null;
  village?: string | null;
  sub_county?: string | null;
  district?: string | null;
  region?: string | null;
  monthly_rent?: number;
  monthly_return?: number;
  image_urls?: string[];
  latitude?: number | null;
  longitude?: number | null;
  verified?: boolean;
  shared_by?: string;
  availability?: 'available' | 'supported' | 'reserved' | 'unavailable';
}

const prettyCategory = (raw?: string | null) =>
  (raw ?? '').replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Rental home';

/**
 * Public self-support page for a shared empty house.
 *
 * Opened from `welileapp.com/s/<code>`. Shows the opportunity without forcing a
 * sign-in, opens the physical location in Google Maps, and hands an
 * authenticated supporter straight into the existing house support process
 * (`partner_support_houses`). Attribution to the agent who shared the link is
 * held server-side against the share code, never in the URL.
 */
export default function SupportHouse() {
  const [params] = useSearchParams();
  const code = params.get('s') || params.get('code') || '';
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const openedRef = useRef(false);
  const resumedRef = useRef(false);

  const offerQ = useQuery({
    queryKey: ['public-house-support-offer', code],
    enabled: !!code,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('public_house_support_offer', { p_code: code });
      if (error) throw error;
      return (data ?? { found: false }) as unknown as SupportOffer;
    },
  });

  const offer = offerQ.data;
  const rent = Number(offer?.monthly_rent || 0);
  const monthlyReturn = Number(offer?.monthly_return || 0);
  const place = useMemo(
    () =>
      [offer?.village, offer?.sub_county, offer?.district, 'Uganda'].filter(Boolean).join(', '),
    [offer],
  );
  const photo = offer?.image_urls?.find(Boolean) ?? null;
  const mapsUrl = houseMapsUrl(offer?.latitude, offer?.longitude);
  const available = offer?.availability === 'available';

  useEffect(() => {
    if (openedRef.current || !offer?.found) return;
    openedRef.current = true;
    logHouseShareEvent(code, 'opened');
  }, [offer?.found, code]);

  const runSupport = useCallback(async () => {
    if (!offer?.house_id) return;
    setBusy(true);
    logHouseShareEvent(code, 'support_started');
    try {
      // The existing support engine: it revalidates availability, the signed
      // agreement and the partner's float under an advisory lock before it
      // creates anything, so two people opening the same link cannot both fund.
      const { data, error } = await supabase.rpc('partner_support_houses', {
        p_house_ids: [offer.house_id],
        p_term_months: 1,
        p_commitment_id: null,
      });
      if (error) throw error;
      const commitmentId = (data as { commitment_id?: string } | null)?.commitment_id ?? null;
      logHouseShareEvent(code, 'support_completed', commitmentId);
      clearHouseSupportIntent();
      setConfirmOpen(false);
      setDone(true);
      toast.success('Support submitted', {
        description:
          'Partner Operations will review it. Your money stays in your wallet until it is approved.',
        duration: 9000,
      });
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'Could not submit your support';
      if (raw.includes('AGREEMENT_REQUIRED')) {
        toast.error('Sign your partner agreement first', {
          description: 'A signed agreement is required before you can support a house.',
          action: { label: 'Open', onClick: () => navigate('/partner-onboarding') },
        });
      } else if (raw.includes('PARTNER_FUNDS_SHORT')) {
        toast.error('Your available balance does not cover this house', {
          description: 'Add funds to your wallet, then come back to this link.',
        });
      } else if (raw.includes('HOUSES_UNAVAILABLE')) {
        toast.error('This house has just been taken by another supporter.');
        void offerQ.refetch();
        setConfirmOpen(false);
      } else if (raw.includes('Minimum funding')) {
        toast.error(raw);
      } else {
        toast.error(raw);
      }
    } finally {
      setBusy(false);
    }
  }, [offer?.house_id, code, navigate, offerQ]);

  const onSupport = useCallback(() => {
    if (!offer?.house_id || !offer.share_code) return;
    logHouseShareEvent(code, 'support_clicked');
    if (!user) {
      // Remember the exact house so authentication, signup, phone verification
      // and onboarding all return here instead of a dashboard.
      saveHouseSupportIntent(offer.share_code, offer.house_id);
      logHouseShareEvent(code, 'auth_started');
      const back = encodeURIComponent(`/support-house?s=${offer.share_code}`);
      navigate(`/auth?redirect=${back}&role=supporter`);
      return;
    }
    setConfirmOpen(true);
  }, [offer, user, code, navigate]);

  // Someone who signed in or signed up from this link lands back here: pick the
  // intent up again and open the support step straight away.
  useEffect(() => {
    if (resumedRef.current || authLoading || !user || !offer?.found || !available) return;
    const intent = getHouseSupportIntent();
    if (intent && intent.share_code === offer.share_code) {
      resumedRef.current = true;
      logHouseShareEvent(code, 'signup_completed');
      setConfirmOpen(true);
    }
  }, [authLoading, user, offer, available, code]);

  const shellTitle = offer?.found ? `Support ${offer.title} | Welile` : 'Support a house | Welile';

  if (!code || (offerQ.isFetched && !offer?.found)) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-5 text-center">
        <Helmet>
          <title>Support opportunity unavailable | Welile</title>
        </Helmet>
        <Home className="h-10 w-10 text-muted-foreground" />
        <h1 className="text-lg font-black">This support opportunity is no longer available.</h1>
        <p className="text-sm text-muted-foreground">
          The link may have expired, or the house has already been taken.
        </p>
        <Button asChild className="w-full rounded-xl">
          <Link to="/houses">See other houses on Welile</Link>
        </Button>
      </main>
    );
  }

  if (offerQ.isLoading || !offer) {
    return (
      <main className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6">
        <Skeleton className="aspect-[16/10] w-full rounded-2xl" />
        <Skeleton className="h-6 w-2/3 rounded-lg" />
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-12 w-full rounded-xl" />
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 pb-28 pt-5 sm:pb-10">
      <Helmet>
        <title>{shellTitle}</title>
        <meta
          name="description"
          content={`Support this available house in ${place} through Welile for ${formatDynamic(rent)}.`}
        />
      </Helmet>

      <Card className="overflow-hidden border-border/70 shadow-sm">
        <div className="relative aspect-[16/10] w-full bg-muted">
          {photo ? (
            <img
              src={photo}
              alt={offer.title}
              loading="eager"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
              <ImageIcon className="h-6 w-6" />
              <span className="text-xs">No photo on file</span>
            </div>
          )}
          <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
            <Badge className="gap-1 bg-background/90 text-[10px] font-bold text-foreground backdrop-blur">
              <Home className="h-3 w-3" /> Empty house
            </Badge>
            {offer.verified && (
              <Badge
                variant="outline"
                className="gap-1 border-emerald-500/40 bg-background/90 text-[10px] font-bold text-emerald-600 backdrop-blur"
              >
                <ShieldCheck className="h-3 w-3" /> Verified
              </Badge>
            )}
          </div>
        </div>

        <CardContent className="space-y-4 p-4 sm:p-6">
          <div>
            <h1 className="text-lg font-black leading-tight sm:text-2xl">{offer.title}</h1>
            <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground sm:text-sm">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{place}</span>
            </p>
            <p className="mt-2 text-[11px] font-semibold text-muted-foreground sm:text-xs">
              {prettyCategory(offer.house_category)}
              {offer.number_of_rooms
                ? ` · ${offer.number_of_rooms} room${offer.number_of_rooms > 1 ? 's' : ''}`
                : ''}
              {offer.shared_by ? ` · Shared by ${offer.shared_by}` : ''}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2.5 sm:gap-3">
            <div className="rounded-2xl border border-border/60 p-3">
              <p className="text-[11px] text-muted-foreground">Monthly rent</p>
              <p className="text-base font-black tabular-nums sm:text-xl">{formatDynamic(rent)}</p>
            </div>
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-3">
              <p className="text-[11px] text-emerald-700 dark:text-emerald-400">Monthly return</p>
              <p className="text-base font-black tabular-nums text-emerald-700 dark:text-emerald-400 sm:text-xl">
                {formatDynamic(monthlyReturn)}
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground sm:text-sm">
            <p className="flex items-center gap-1.5 font-bold text-foreground">
              <TrendingUp className="h-4 w-4 text-primary" /> How supporting this house works
            </p>
            <p className="mt-1.5">
              You cover one month's rent of {formatDynamic(rent)}. Welile places a family in the
              house and pays the landlord. You receive {formatDynamic(monthlyReturn)} every month
              for 12 months, which is {HOUSE_SHARE_ROI_RATE}% a month.
            </p>
          </div>

          {done ? (
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
              <p className="flex items-center gap-2 font-black text-emerald-700 dark:text-emerald-400">
                <Check className="h-4 w-4" /> Your support has been submitted
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Partner Operations will review it shortly. You can follow it in your dashboard.
              </p>
              <Button asChild className="mt-3 w-full rounded-xl">
                <Link to="/dashboard">
                  Go to my dashboard <ArrowRight className="ml-1.5 h-4 w-4" />
                </Link>
              </Button>
            </div>
          ) : offer.availability !== 'available' ? (
            <div className="rounded-2xl border border-border bg-muted/40 p-4 text-sm">
              <p className="font-bold">
                {offer.availability === 'supported'
                  ? 'This house has already received the required support.'
                  : offer.availability === 'reserved'
                    ? 'This house is being held by another supporter right now.'
                    : 'This house is no longer open for support.'}
              </p>
              <Button asChild variant="outline" className="mt-3 w-full rounded-xl">
                <Link to="/houses">See other houses</Link>
              </Button>
            </div>
          ) : (
            <div className="hidden gap-2 sm:flex sm:flex-col">
              <Button className="w-full rounded-xl py-6 text-base font-black" onClick={onSupport}>
                Support This House
              </Button>
              {mapsUrl && (
                <Button
                  variant="outline"
                  className="w-full gap-2 rounded-xl"
                  onClick={() => {
                    logHouseShareEvent(code, 'visit_location_clicked');
                    window.open(mapsUrl, '_blank', 'noopener,noreferrer');
                  }}
                >
                  <Navigation className="h-4 w-4" /> Visit House
                </Button>
              )}
              {offer.house_id && (
                <Button asChild variant="ghost" className="w-full rounded-xl text-xs">
                  <Link to={`/house/${offer.house_id}`}>View House Details</Link>
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Mobile: the primary action stays reachable without scrolling back up. */}
      {!done && available && (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background/95 p-3 backdrop-blur sm:hidden">
          <div className="mx-auto flex max-w-2xl gap-2">
            {mapsUrl && (
              <Button
                variant="outline"
                className="gap-1.5 rounded-xl"
                onClick={() => {
                  logHouseShareEvent(code, 'visit_location_clicked');
                  window.open(mapsUrl, '_blank', 'noopener,noreferrer');
                }}
              >
                <Navigation className="h-4 w-4" /> Visit
              </Button>
            )}
            <Button className="flex-1 rounded-xl py-6 text-base font-black" onClick={onSupport}>
              Support This House
            </Button>
          </div>
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={(o) => !busy && setConfirmOpen(o)}>
        <DialogContent className="w-[95vw] max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4 text-primary" /> Confirm your support
            </DialogTitle>
            <DialogDescription className="text-xs">
              You are committing {formatDynamic(rent)} to {offer.title}. Partner Operations review
              it before anything is deployed, and your money stays in your wallet until then.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1 rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Amount</span>
              <span className="font-black">{formatDynamic(rent)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Monthly return</span>
              <span className="font-black">{formatDynamic(monthlyReturn)}</span>
            </div>
            <div className="flex justify-between border-t border-primary/10 pt-1">
              <span className="text-muted-foreground">Projected over 12 months</span>
              <span className="font-black text-primary">{formatDynamic(monthlyReturn * 12)}</span>
            </div>
          </div>

          <DialogFooter className="flex-row justify-end gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void runSupport()} className="gap-1.5">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Yes, support this house
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
