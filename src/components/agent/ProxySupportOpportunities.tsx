import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import {
  Check, Eye, FileText, Home, MapPin, ShoppingCart,
  Sparkles, TrendingUp, Users, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { formatDynamic } from '@/lib/currencyFormat';
import { formatUGX } from '@/lib/rentCalculations';
import { HOUSE_MONTHLY_ROI_RATE } from '@/components/partner/SelfSupportHousesSection';
import { PlanShareButton } from '@/components/partner/PlanShareButton';
import { EmptyHouseShareBrowser } from '@/components/agent/EmptyHouseShareBrowser';
import { PromissoryNoteDialog } from '@/components/agent/PromissoryNoteDialog';
import { hapticTap } from '@/lib/haptics';
import type { HouseOpportunity } from '@/components/agent/EmptyHouseDetailSheet';

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

/* ─── Unified cart item ─── */
type CartEntry =
  | { kind: 'plan'; id: string; label: string; place: string; amount: number; monthly: number }
  | { kind: 'house'; id: string; label: string; place: string; amount: number; monthly: number };

/* ─────────────────────────── PlanCard ─────────────────────────── */

function PlanCard({
  plan,
  selected,
  onToggle,
}: {
  plan: AgentFundablePlan;
  selected: boolean;
  onToggle: () => void;
}) {
  const rent = Number(plan.funding_amount || 0);
  const place = plan.tenant_location || plan.request_city || 'Uganda';
  const category = (plan.house_category || 'Rental home').replace(/[_-]/g, ' ');

  return (
    <div className="group">
      {/* Tappable hero — toggles selection */}
      <button
        type="button"
        onClick={() => { hapticTap(); onToggle(); }}
        className={cn(
          'relative flex aspect-[4/3] w-full flex-col items-center justify-center gap-1.5 rounded-2xl overflow-hidden transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected
            ? 'bg-gradient-to-br from-primary/25 via-primary/10 to-primary/5 ring-2 ring-primary/50'
            : 'bg-gradient-to-br from-primary/15 via-primary/5 to-background',
        )}
      >
        <Users className="h-7 w-7 text-primary/70" />
        <p className="px-6 text-center text-xs font-semibold text-foreground/80">
          Support a tenant's Rent Plan
        </p>

        {/* Rent Plan badge — top left */}
        <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-white/90 dark:bg-black/70 px-2.5 py-1 text-[11px] font-semibold backdrop-blur-sm shadow-sm">
          <Sparkles className="h-3 w-3 text-primary" /> Rent Plan
        </span>

        {/* Selection checkmark — top right */}
        <span
          className={cn(
            'absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-full border-2 transition-all duration-200',
            selected
              ? 'border-primary bg-primary text-primary-foreground scale-100'
              : 'border-muted-foreground/30 bg-white/80 dark:bg-black/50 text-transparent scale-90',
          )}
        >
          <Check className="h-4 w-4" strokeWidth={3} />
        </span>
      </button>

      {/* Content */}
      <div className="mt-2.5 px-0.5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-[15px] font-semibold leading-snug capitalize line-clamp-1">{category}</h3>
          <span className="shrink-0 mt-0.5 text-sm font-semibold tabular-nums">
            {money(rent)}
          </span>
        </div>
        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          <MapPin className="h-3 w-3 shrink-0" /> {place}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Monthly return{' '}
          <span className="font-semibold text-emerald-600 dark:text-emerald-400">{money(monthlyReturn(rent))}</span>
        </p>

        {/* Action row: select toggle + share */}
        <div className="mt-2 flex items-center justify-between">
          <button
            type="button"
            onClick={() => { hapticTap(); onToggle(); }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
              selected
                ? 'bg-primary/10 text-primary'
                : 'bg-muted text-muted-foreground hover:bg-muted/80',
            )}
          >
            {selected ? (
              <><Check className="h-3 w-3" /> Selected</>
            ) : (
              <><ShoppingCart className="h-3 w-3" /> Add to cart</>
            )}
          </button>
          <PlanShareButton
            variant="icon"
            plan={{
              rent_request_id: plan.rent_request_id,
              funding_amount: rent,
              house_category: plan.house_category,
              request_city: plan.request_city,
              tenant_location: plan.tenant_location,
            }}
          />
        </div>
      </div>
    </div>
  );
}

/* ─────────────────── Cart review item (inside sheet) ─────────────────── */

function CartItemRow({
  entry,
  onRemove,
}: {
  entry: CartEntry;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-3 py-3 border-b border-border/40 last:border-0">
      {/* Mini icon */}
      <div className={cn(
        'grid h-10 w-10 shrink-0 place-items-center rounded-xl',
        entry.kind === 'plan' ? 'bg-primary/10' : 'bg-emerald-500/10',
      )}>
        {entry.kind === 'plan'
          ? <Users className="h-4 w-4 text-primary" />
          : <Home className="h-4 w-4 text-emerald-600" />}
      </div>
      {/* Details */}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold capitalize truncate">{entry.label}</p>
        <p className="text-[11px] text-muted-foreground flex items-center gap-1">
          <MapPin className="h-3 w-3 shrink-0" /> {entry.place}
        </p>
      </div>
      {/* Amount + remove */}
      <div className="text-right shrink-0">
        <p className="text-sm font-semibold tabular-nums">{money(entry.amount)}</p>
        <button
          type="button"
          onClick={() => { hapticTap(); onRemove(); }}
          className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] font-medium text-destructive hover:underline"
        >
          <X className="h-3 w-3" /> Remove
        </button>
      </div>
    </div>
  );
}

/* ─────────────────── Main component ─────────────────── */

/**
 * Shareable support opportunities for a proxy agent. Both the empty-houses tab
 * and the Rent Plans tab support a select-to-cart workflow: tap cards to add
 * them to a shared cart, then create a promissory note for the entire cart.
 */
export function ProxySupportOpportunities({ className }: { className?: string }) {
  const [plansShown, setPlansShown] = useState(6);
  const [housesTotal, setHousesTotal] = useState(0);

  // ─── Unified cart state (plans + houses share one cart) ───
  const [selectedPlanIds, setSelectedPlanIds] = useState<Set<string>>(new Set());
  const [selectedHouseIds, setSelectedHouseIds] = useState<Set<string>>(new Set());
  const [selectedHouses, setSelectedHouses] = useState<Map<string, HouseOpportunity>>(new Map());
  const [cartOpen, setCartOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);

  const totalSelected = selectedPlanIds.size + selectedHouseIds.size;

  const togglePlan = useCallback((id: string) => {
    setSelectedPlanIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleHouse = useCallback((house: HouseOpportunity) => {
    const id = house.house_id;
    setSelectedHouseIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelectedHouses((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, house);
      return next;
    });
  }, []);

  const removeFromCart = useCallback((kind: 'plan' | 'house', id: string) => {
    if (kind === 'plan') {
      setSelectedPlanIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    } else {
      setSelectedHouseIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
      setSelectedHouses((prev) => { const n = new Map(prev); n.delete(id); return n; });
    }
  }, []);

  const clearCart = useCallback(() => {
    setSelectedPlanIds(new Set());
    setSelectedHouseIds(new Set());
    setSelectedHouses(new Map());
    setCartOpen(false);
  }, []);

  // ─── Data queries ───
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

  // ─── Cart entries (unified) ───
  const cartEntries = useMemo<CartEntry[]>(() => {
    const entries: CartEntry[] = [];
    for (const p of plans) {
      if (!selectedPlanIds.has(p.rent_request_id)) continue;
      const rent = Number(p.funding_amount || 0);
      entries.push({
        kind: 'plan',
        id: p.rent_request_id,
        label: (p.house_category || 'Rental home').replace(/[_-]/g, ' '),
        place: p.tenant_location || p.request_city || 'Uganda',
        amount: rent,
        monthly: monthlyReturn(rent),
      });
    }
    for (const [, h] of selectedHouses) {
      const rent = Number(h.monthly_rent || 0);
      entries.push({
        kind: 'house',
        id: h.house_id,
        label: h.title || h.house_category?.replace(/[_-]/g, ' ') || 'Empty house',
        place: [h.village, h.sub_county, h.district].filter(Boolean).join(', ') || h.region || 'Uganda',
        amount: rent,
        monthly: monthlyReturn(rent),
      });
    }
    return entries;
  }, [plans, selectedPlanIds, selectedHouses]);

  const cartTotal = useMemo(() => cartEntries.reduce((s, e) => s + e.amount, 0), [cartEntries]);
  const cartMonthlyReturn = useMemo(() => cartEntries.reduce((s, e) => s + e.monthly, 0), [cartEntries]);

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

  const grid = 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4';

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

      {/* Selection hint */}
      {totalSelected === 0 && (
        <p className="text-xs text-muted-foreground text-center py-1">
          Tap houses or plans to add to cart, then create a promissory note for all at once
        </p>
      )}

      <Tabs defaultValue="houses">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="houses">
            Empty houses ({housesTotal})
            {selectedHouseIds.size > 0 && (
              <span className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground px-1">
                {selectedHouseIds.size}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="plans">
            Rent Plans ({plans.length})
            {selectedPlanIds.size > 0 && (
              <span className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground px-1">
                {selectedPlanIds.size}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="houses" className="pt-3 pb-24">
          <EmptyHouseShareBrowser
            onTotalChange={setHousesTotal}
            selectedHouseIds={selectedHouseIds}
            onToggleHouse={toggleHouse}
          />
        </TabsContent>

        <TabsContent value="plans" className="pt-3 pb-24">
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
                {visiblePlans.map((p) => (
                  <PlanCard
                    key={p.rent_request_id}
                    plan={p}
                    selected={selectedPlanIds.has(p.rent_request_id)}
                    onToggle={() => togglePlan(p.rent_request_id)}
                  />
                ))}
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

      {/* ─────────── Floating cart bar ─────────── */}
      {totalSelected > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-background/95 backdrop-blur-md px-4 py-3 pb-safe shadow-[0_-4px_24px_rgba(0,0,0,0.08)]">
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {totalSelected} item{totalSelected !== 1 ? 's' : ''} selected
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">
                Total {money(cartTotal)}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              onClick={() => { hapticTap(); clearCart(); }}
            >
              <X className="h-3.5 w-3.5" /> Clear
            </Button>
            <Button
              className="shrink-0 gap-2 font-semibold"
              onClick={() => { hapticTap(); setCartOpen(true); }}
            >
              <ShoppingCart className="h-4 w-4" />
              View cart
            </Button>
          </div>
        </div>
      )}

      {/* ─────────── Cart review sheet ─────────── */}
      <Sheet open={cartOpen} onOpenChange={setCartOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-2xl pb-safe">
          <SheetHeader className="text-left pb-2">
            <SheetTitle className="flex items-center gap-2 text-base">
              <ShoppingCart className="h-4 w-4 text-primary" />
              Your cart
              <Badge variant="outline" className="ml-auto text-[10px]">
                {cartEntries.length} item{cartEntries.length !== 1 ? 's' : ''}
              </Badge>
            </SheetTitle>
            <SheetDescription className="text-xs">
              Review your selections and create a promissory note
            </SheetDescription>
          </SheetHeader>

          {cartEntries.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Your cart is empty. Tap houses or plans to add them.
            </div>
          ) : (
            <div className="space-y-0 pt-2">
              {/* Group headers */}
              {cartEntries.some((e) => e.kind === 'house') && (
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground pt-1 pb-1">
                  Empty houses ({cartEntries.filter((e) => e.kind === 'house').length})
                </p>
              )}
              {cartEntries.filter((e) => e.kind === 'house').map((e) => (
                <CartItemRow key={e.id} entry={e} onRemove={() => removeFromCart('house', e.id)} />
              ))}

              {cartEntries.some((e) => e.kind === 'plan') && (
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground pt-3 pb-1">
                  Rent Plans ({cartEntries.filter((e) => e.kind === 'plan').length})
                </p>
              )}
              {cartEntries.filter((e) => e.kind === 'plan').map((e) => (
                <CartItemRow key={e.id} entry={e} onRemove={() => removeFromCart('plan', e.id)} />
              ))}

              {/* Totals */}
              <div className="mt-4 rounded-xl bg-muted/40 p-3 space-y-1.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Total support amount</span>
                  <span className="font-bold tabular-nums">{money(cartTotal)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Monthly return</span>
                  <span className="font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {money(cartMonthlyReturn)}/mo
                  </span>
                </div>
              </div>

              {/* CTA */}
              <div className="mt-4 space-y-2">
                <Button
                  className="w-full h-12 gap-2 font-semibold text-sm"
                  onClick={() => {
                    hapticTap();
                    setCartOpen(false);
                    setNoteOpen(true);
                  }}
                >
                  <FileText className="h-4 w-4" />
                  Create Promissory Note · {money(cartTotal)}
                </Button>
                <Button
                  variant="ghost"
                  className="w-full text-xs"
                  onClick={clearCart}
                >
                  Clear cart
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* ─────────── Promissory note dialog ─────────── */}
      <PromissoryNoteDialog
        open={noteOpen}
        onOpenChange={(o) => {
          setNoteOpen(o);
          if (!o) clearCart();
        }}
        supportMode="self"
        initialAmount={cartTotal || undefined}
      />
    </div>
  );
}
