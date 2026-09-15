import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Check, Copy, Home, ImageIcon, MapPin, MessageCircle, Share2, ShieldCheck, Sparkles, TrendingUp, Users } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { formatDynamic } from '@/lib/currencyFormat';
import { useVerifiedEmptyHouses, houseTitleLine, houseAddressLine, HOUSE_MONTHLY_ROI_RATE, type SupportableHouse } from '@/components/partner/SelfSupportHousesSection';
import { PlanShareButton } from '@/components/partner/PlanShareButton';
import { SHARE_LINK_HOST } from '@/lib/planShareLink';

const money = (v: unknown) => formatDynamic(v);

interface AgentFundablePlan {
  rent_request_id: string;
  funding_amount: number;
  daily_repayment: number | null;
  duration_days: number | null;
  house_category: string | null;
  request_city: string | null;
  tenant_full_name: string | null;
  tenant_location: string | null;
  landlord_name: string | null;
}

const photoOf = (h: SupportableHouse) =>
  (h.image_urls && h.image_urls.length ? h.image_urls[0] : h.image_url) || null;

const monthlyReturn = (rent: number) => Math.round((rent * HOUSE_MONTHLY_ROI_RATE) / 100);

/** Support-framed message: what the partner puts in, what comes back monthly. */
function houseShareMessage(house: SupportableHouse, url: string) {
  const rent = Number(house.monthly_rent || 0);
  return [
    `🏠 *Support this empty house on Welile*`,
    ``,
    `*${houseTitleLine(house)}*`,
    `📍 ${houseAddressLine(house)}`,
    ...(house.number_of_rooms ? [`🚪 ${house.number_of_rooms} room${house.number_of_rooms > 1 ? 's' : ''}`] : []),
    `💰 Pay one month's rent: ${money(rent)}`,
    `📈 Earn ${money(monthlyReturn(rent))} every month for the next 12 months`,
    ``,
    `A family moves in as soon as this house is supported.`,
    `👉 See the house & support it: ${url}`,
  ].join('\n');
}

function useHouseShortCodes(ids: string[]) {
  const key = ids.slice().sort().join(',');
  return useQuery({
    queryKey: ['proxy-house-short-codes', key],
    enabled: ids.length > 0,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('house_listings')
        .select('id, short_code')
        .in('id', ids);
      if (error) throw error;
      const map: Record<string, string> = {};
      for (const row of data ?? []) if (row.short_code) map[row.id] = row.short_code;
      return map;
    },
  });
}

function HouseShareActions({ house, shortCode }: { house: SupportableHouse; shortCode?: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${SHARE_LINK_HOST}/house/${shortCode || house.house_id}`;
  const message = houseShareMessage(house, url);

  const share = async () => {
    const payload: ShareData = { title: houseTitleLine(house), text: message, url };
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share(payload);
        return;
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      toast.success('Support message copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy the message');
    }
  };

  return (
    <div className="flex gap-2">
      <Button className="flex-1 gap-2 rounded-xl font-semibold" onClick={share}>
        <Share2 className="h-4 w-4" /> Share to support
      </Button>
      <Button
        variant="outline"
        className="gap-2 rounded-xl"
        onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer')}
        aria-label="Share on WhatsApp"
      >
        <MessageCircle className="h-4 w-4" />
      </Button>
      <Button variant="outline" className="rounded-xl" onClick={copy} aria-label="Copy support message">
        {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}

function HouseCard({ house, shortCode }: { house: SupportableHouse; shortCode?: string }) {
  const photo = photoOf(house);
  const rent = Number(house.monthly_rent || 0);
  return (
    <Card className="overflow-hidden border-border/70">
      {/* This is the same photo social apps show as the link preview image. */}
      <div className="relative aspect-[16/9] w-full bg-muted">
        {photo ? (
          <img src={photo} alt={houseTitleLine(house)} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
            <ImageIcon className="h-5 w-5" />
            <span className="text-[11px]">No photo on file</span>
          </div>
        )}
        <div className="absolute left-2 top-2 flex gap-1.5">
          <Badge className="gap-1 bg-background/90 text-[10px] font-bold text-foreground backdrop-blur">
            <Home className="h-3 w-3" /> Empty house
          </Badge>
          {house.verified && (
            <Badge variant="outline" className="gap-1 border-emerald-500/40 bg-background/90 text-[10px] font-bold text-emerald-600 backdrop-blur">
              <ShieldCheck className="h-3 w-3" /> Verified
            </Badge>
          )}
        </div>
      </div>

      <CardContent className="space-y-3 p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-black">{houseTitleLine(house)}</p>
          <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
            <MapPin className="h-3 w-3 shrink-0" /> {houseAddressLine(house)}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="rounded-xl border border-border/60 p-2">
            <p className="text-muted-foreground">One month's rent</p>
            <p className="font-black tabular-nums">{money(rent)}</p>
          </div>
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-2">
            <p className="text-emerald-700 dark:text-emerald-400">Monthly return</p>
            <p className="font-black tabular-nums text-emerald-700 dark:text-emerald-400">{money(monthlyReturn(rent))}</p>
          </div>
        </div>

        <HouseShareActions house={house} shortCode={shortCode} />
      </CardContent>
    </Card>
  );
}

function PlanCard({ plan }: { plan: AgentFundablePlan }) {
  const rent = Number(plan.funding_amount || 0);
  const place = plan.tenant_location || plan.request_city || 'Uganda';
  const category = (plan.house_category || 'Rental home').replace(/[_-]/g, ' ');
  return (
    <Card className="overflow-hidden border-border/70">
      <div className="relative flex aspect-[16/9] w-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-primary/15 via-primary/5 to-background">
        <Users className="h-6 w-6 text-primary" />
        <p className="px-4 text-center text-xs font-bold">Support a tenant's Rent Plan</p>
        <Badge className="absolute left-2 top-2 gap-1 bg-background/90 text-[10px] font-bold text-foreground backdrop-blur">
          <Sparkles className="h-3 w-3" /> Rent Plan
        </Badge>
      </div>

      <CardContent className="space-y-3 p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-black capitalize">{category}</p>
          <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
            <MapPin className="h-3 w-3 shrink-0" /> {place}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="rounded-xl border border-border/60 p-2">
            <p className="text-muted-foreground">Support amount</p>
            <p className="font-black tabular-nums">{money(rent)}</p>
          </div>
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-2">
            <p className="text-emerald-700 dark:text-emerald-400">Monthly return</p>
            <p className="font-black tabular-nums text-emerald-700 dark:text-emerald-400">{money(monthlyReturn(rent))}</p>
          </div>
        </div>

        <PlanShareButton
          variant="block"
          plan={{
            rent_request_id: plan.rent_request_id,
            funding_amount: rent,
            house_category: plan.house_category,
            request_city: plan.request_city,
            tenant_location: plan.tenant_location,
          }}
        />
      </CardContent>
    </Card>
  );
}

/**
 * Shareable support opportunities for a proxy agent: verified EMPTY houses
 * first, then approved Rent Plans. Every card carries the photo social apps
 * use as the link preview image and a support-framed message the agent can
 * send straight to a partner.
 */
export function ProxySupportOpportunities({ className }: { className?: string }) {
  const [housesShown, setHousesShown] = useState(6);
  const [plansShown, setPlansShown] = useState(6);

  const housesQ = useVerifiedEmptyHouses();
  const plansQ = useQuery({
    queryKey: ['proxy-support-fundable-plans'],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_list_promissory_fundable_plans', {
        p_limit: 60,
        p_offset: 0,
        p_search: null,
        p_max_amount: null,
      });
      if (error) throw error;
      const payload = (data ?? {}) as unknown as { plans?: AgentFundablePlan[]; total?: number };
      return { plans: Array.isArray(payload.plans) ? payload.plans : [], total: Number(payload.total || 0) };
    },
  });

  const houses = housesQ.data?.houses ?? [];
  const plans = plansQ.data?.plans ?? [];
  const visibleHouses = houses.slice(0, housesShown);
  const visiblePlans = plans.slice(0, plansShown);
  const codesQ = useHouseShortCodes(useMemo(() => visibleHouses.map((h) => h.house_id), [visibleHouses]));
  const codes = codesQ.data ?? {};

  const grid = 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4';

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-black">Share these to bring in support</h2>
        <Badge variant="outline" className="ml-auto text-[10px]">
          {houses.length} houses · {plans.length} plans
        </Badge>
      </div>

      <Tabs defaultValue="houses">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="houses">Empty houses ({houses.length})</TabsTrigger>
          <TabsTrigger value="plans">Rent Plans ({plans.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="houses" className="pt-3">
          {housesQ.isLoading ? (
            <div className={grid}>
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-72 rounded-2xl" />)}
            </div>
          ) : housesQ.error ? (
            <Card><CardContent className="p-4 text-sm text-destructive">{(housesQ.error as Error).message}</CardContent></Card>
          ) : houses.length === 0 ? (
            <Card><CardContent className="p-4 text-sm text-muted-foreground">No verified empty houses waiting for support right now.</CardContent></Card>
          ) : (
            <>
              <div className={grid}>
                {visibleHouses.map((h) => <HouseCard key={h.house_id} house={h} shortCode={codes[h.house_id]} />)}
              </div>
              {housesShown < houses.length && (
                <Button variant="outline" className="mt-3 w-full font-semibold" onClick={() => setHousesShown((n) => n + 6)}>
                  Show more houses ({houses.length - housesShown} left)
                </Button>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="plans" className="pt-3">
          {plansQ.isLoading ? (
            <div className={grid}>
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-64 rounded-2xl" />)}
            </div>
          ) : plansQ.error ? (
            <Card><CardContent className="p-4 text-sm text-destructive">{(plansQ.error as Error).message}</CardContent></Card>
          ) : plans.length === 0 ? (
            <Card><CardContent className="p-4 text-sm text-muted-foreground">No Rent Plans are waiting for support right now.</CardContent></Card>
          ) : (
            <>
              <div className={grid}>
                {visiblePlans.map((p) => <PlanCard key={p.rent_request_id} plan={p} />)}
              </div>
              {plansShown < plans.length && (
                <Button variant="outline" className="mt-3 w-full font-semibold" onClick={() => setPlansShown((n) => n + 6)}>
                  Show more Rent Plans ({plans.length - plansShown} left)
                </Button>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
