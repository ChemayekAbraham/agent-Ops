import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Eye, MapPin, Sparkles, TrendingUp, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { formatDynamic } from '@/lib/currencyFormat';
import { HOUSE_MONTHLY_ROI_RATE } from '@/components/partner/SelfSupportHousesSection';
import { PlanShareButton } from '@/components/partner/PlanShareButton';
import { EmptyHouseShareBrowser } from '@/components/agent/EmptyHouseShareBrowser';

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

const monthlyReturn = (rent: number) => Math.round((rent * HOUSE_MONTHLY_ROI_RATE) / 100);

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
 * Shareable support opportunities for a proxy agent. The empty-houses tab is
 * the full browsing experience (search, filters, landlord contact, GPS,
 * progress badges, details) with one-tap support share links on every card;
 * the Rent Plans tab lists approved plans waiting for support.
 */
export function ProxySupportOpportunities({ className }: { className?: string }) {
  const [plansShown, setPlansShown] = useState(6);
  const [housesTotal, setHousesTotal] = useState(0);

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

  const plans = plansQ.data?.plans ?? [];
  const visiblePlans = plans.slice(0, plansShown);
  const perfQ = useQuery({
    queryKey: ['house-share-performance'],
    staleTime: 2 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('house_share_performance');
      if (error) throw error;
      return (data ?? {}) as { opened?: number; support_clicked?: number; support_completed?: number; links?: number };
    },
  });
  const perf = perfQ.data;

  const grid = 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4';

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-black">Share these to bring in support</h2>
        <Badge variant="outline" className="ml-auto text-[10px]">
          {housesTotal} houses · {plans.length} plans
        </Badge>
      </div>

      {perf && (Number(perf.links) > 0 || Number(perf.opened) > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-[11px] font-semibold text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Eye className="h-3.5 w-3.5 text-primary" /> {Number(perf.opened || 0)} link opens
          </span>
          <span>{Number(perf.support_clicked || 0)} started support</span>
          <span>{Number(perf.support_completed || 0)} supported</span>
          <span className="ml-auto">{Number(perf.links || 0)} links shared</span>
        </div>
      )}



      <Tabs defaultValue="houses">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="houses">Empty houses ({housesTotal})</TabsTrigger>
          <TabsTrigger value="plans">Rent Plans ({plans.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="houses" className="pt-3">
          <EmptyHouseShareBrowser onTotalChange={setHousesTotal} />
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
