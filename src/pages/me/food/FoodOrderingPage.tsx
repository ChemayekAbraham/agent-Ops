import { useMemo, useState, useCallback, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertCircle, CalendarOff, ChefHat, ChevronLeft, ClipboardList, Clock, Flame, Heart, Info,
  MapPin, Moon, Search, ShieldAlert, ShieldCheck, ShoppingBag, Sparkles, Star, Sun, Sunrise,
  Utensils, UtensilsCrossed, X,
} from 'lucide-react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import FoodMealCard from '@/components/food/FoodMealCard';
import FoodCartSheet, { type CartLine } from '@/components/food/FoodCartSheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { isFoodAllDayWindow } from '@/lib/foodService';
import { safeUUID } from '@/lib/safeUUID';
import { cn } from '@/lib/utils';
import {
  useFoodMenu, useFoodSession, usePlaceFoodOrder, useMyFoodOrders,
  useFoodCoordinatorStatus, useFoodCanUseCanteen,
  formatUgx, FOOD_MAX_QTY_PER_LINE, FOOD_MAX_INSTRUCTIONS,
  type FoodMenuMeal, type FoodMenuPeriod, type FoodPaymentMode,
} from '@/hooks/useFoodService';

/** 'HH:MM:SS' → '8:00 am' */
function clock(t: string): string {
  const [h, m] = t.split(':');
  const hour = Number(h);
  const suffix = hour >= 12 ? 'pm' : 'am';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${m}${suffix === 'am' ? ' am' : ' pm'}`;
}

/** Decorative icon for a service period, chosen from its name. */
function PeriodIcon({ name }: { name: string }) {
  const n = name.toLowerCase();
  const Icon = n.includes('breakfast') || n.includes('morning') ? Sunrise
    : n.includes('supper') || n.includes('dinner') || n.includes('evening') ? Moon
      : n.includes('lunch') ? Sun
        : Clock;
  return <Icon className="h-4 w-4" aria-hidden="true" />;
}

export default function FoodOrderingPage() {
  useFoodSession();

  const { data: canUseCanteen, isLoading: checkingAccess } = useFoodCanUseCanteen();
  const allowed = canUseCanteen !== false;

  const { data: menu, isLoading, isError, error, refetch } = useFoodMenu(undefined, allowed);
  const { data: myOrders } = useMyFoodOrders(allowed);
  const { data: coordinatorStatus } = useFoodCoordinatorStatus();
  const isFoodCoordinator = coordinatorStatus?.isCoordinator === true;
  const placeOrder = usePlaceFoodOrder();

  const [searchParams, setSearchParams] = useSearchParams();
  const categoryParam = searchParams.get('category')?.toLowerCase();

  // menuItemId -> quantity, scoped to one service period at a time
  const [cart, setCart] = useState<Record<string, number>>({});
  const [activePeriodId, setActivePeriodId] = useState<string | null>(null);
  // which meal category the menu is filtered to; 'all' shows everything
  const [activeCategory, setActiveCategory] = useState<string>(categoryParam ?? 'all');
  const [notes, setNotes] = useState('');
  const [cartOpen, setCartOpen] = useState(false);

  // Glovo-style search and quick filters
  const [searchQuery, setSearchQuery] = useState('');
  const [filterAvailableOnly, setFilterAvailableOnly] = useState(false);
  const [filterUnder10k, setFilterUnder10k] = useState(false);
  const [bannerFavorited, setBannerFavorited] = useState(false);

  useEffect(() => {
    if (categoryParam) {
      setActiveCategory(categoryParam);
    } else {
      setActiveCategory('all');
    }
  }, [categoryParam]);

  const handleCategoryChange = (val: string) => {
    setActiveCategory(val);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (val === 'all') {
        next.delete('category');
      } else {
        next.set('category', val);
      }
      return next;
    }, { replace: true });
  };

  // Chosen by the employee, never defaulted: it is recorded on the order.
  const [paymentMode, setPaymentMode] = useState<FoodPaymentMode | null>('wallet');
  const [idempotencyKey, setIdempotencyKey] = useState(() => safeUUID());
  const renewKey = () => setIdempotencyKey(safeUUID());

  const periods = useMemo(() => menu?.periods ?? [], [menu?.periods]);
  const activePeriod = periods.find((p) => p.period_id === activePeriodId) ?? null;

  /**
   * Meal categories on today's menu, in the order they first appear and each
   * listed once whatever case the coordinator typed them in.
   */
  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of periods) {
      for (const meal of p.meals) {
        const label = meal.category?.trim();
        if (!label) continue;
        const key = label.toLowerCase();
        if (!seen.has(key)) seen.set(key, label);
      }
    }
    return [...seen.entries()].map(([key, label]) => ({ key, label }));
  }, [periods]);

  // a menu refresh can retire the category being viewed; fall back to everything
  const category = categories.some((c) => c.key === activeCategory) ? activeCategory : 'all';
  const inCategory = (meal: FoodMenuMeal) =>
    category === 'all' || (meal.category?.trim().toLowerCase() ?? '') === category;

  const inSearch = (m: FoodMenuMeal) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase().trim();
    return m.name.toLowerCase().includes(q) || (m.description?.toLowerCase().includes(q) ?? false);
  };

  const inChips = (m: FoodMenuMeal, p: FoodMenuPeriod) => {
    if (filterAvailableOnly && (m.sold_out || !p.ordering_open)) return false;
    if (filterUnder10k && m.price_ugx > 10000) return false;
    return true;
  };

  const mealsById = useMemo(() => {
    const m = new Map<string, FoodMenuMeal>();
    for (const p of periods) for (const meal of p.meals) m.set(meal.menu_item_id, meal);
    return m;
  }, [periods]);

  const lines: CartLine[] = useMemo(
    () => Object.entries(cart)
      .filter(([, q]) => q > 0)
      .map(([id, quantity]) => ({ meal: mealsById.get(id)!, quantity }))
      .filter((l) => l.meal),
    [cart, mealsById],
  );

  const cartCount = lines.reduce((t, l) => t + l.quantity, 0);
  const cartTotal = lines.reduce((t, l) => t + l.meal.price_ugx * l.quantity, 0);

  const mealCap = useCallback((period: FoodMenuPeriod, menuItemId: string): number | null => {
    const lineMax = menu?.max_qty_per_line ?? FOOD_MAX_QTY_PER_LINE;
    if (period.max_qty_per_employee === null) return lineMax;
    const held = (myOrders ?? [])
      .filter((o) => o.period_id === period.period_id
        && o.service_date === menu?.service_date
        && o.fulfilment_status !== 'cancelled')
      .reduce((t, o) => t + (o.items ?? []).reduce((s, i) => s + i.quantity, 0), 0);
    const otherLines = period.meals
      .filter((m) => m.menu_item_id !== menuItemId)
      .reduce((t, m) => t + (cart[m.menu_item_id] ?? 0), 0);
    return Math.min(lineMax, Math.max(0, period.max_qty_per_employee - held - otherLines));
  }, [myOrders, menu?.service_date, menu?.max_qty_per_line, cart]);

  const setQuantity = (meal: FoodMenuMeal, periodId: string, quantity: number) => {
    const switching = activePeriodId !== null && activePeriodId !== periodId;
    const next = switching ? {} : { ...cart };
    if (quantity <= 0) delete next[meal.menu_item_id];
    else next[meal.menu_item_id] = quantity;
    setCart(next);
    setActivePeriodId(Object.keys(next).length > 0 ? periodId : null);
    renewKey();
  };

  const submit = () => {
    if (!paymentMode) return;
    placeOrder.mutate(
      {
        items: lines.map((l) => ({ menuItemId: l.meal.menu_item_id, quantity: l.quantity })),
        idempotencyKey,
        paymentMode,
        specialInstructions: notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          setCart({});
          setActivePeriodId(null);
          setNotes('');
          setPaymentMode('wallet');
          setCartOpen(false);
          renewKey();
        },
      },
    );
  };

  if (!checkingAccess && canUseCanteen === false) {
    return (
      <PersonalLayout title="Canteen" backTo="/me" backLabel="Back to My space">
        <div className="mx-auto w-full max-w-md p-6">
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-border/70 bg-card p-10 text-center">
            <ShieldAlert className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
            <p className="text-sm font-medium">The canteen is for Welile staff only</p>
            <p className="mt-1 text-xs text-muted-foreground">
              If you are a staff member, make sure your employee profile is active.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-3">
              <Link to="/me">Back to My space</Link>
            </Button>
          </div>
        </div>
      </PersonalLayout>
    );
  }

  const shownCount = periods.reduce(
    (t, p) => t + p.meals.filter(inCategory).filter(inSearch).filter((m) => inChips(m, p)).length,
    0,
  );

  return (
    <PersonalLayout title="Canteen" backTo="/me" backLabel="Back to My space">
      <div className="mx-auto w-full max-w-5xl space-y-5 p-4 sm:p-6">
        {/* Glovo App Search & Top Action Bar */}
        <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
          <Link
            to="/me"
            aria-label="Back to My space"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted/70 text-foreground transition-colors hover:bg-muted active:scale-95"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>

          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search dishes, drinks, sides..."
              className="h-10 w-full rounded-full border border-border/70 bg-muted/40 pl-10 pr-9 text-sm placeholder:text-muted-foreground/70 transition-all focus:border-amber-400 focus:bg-background focus:outline-none focus:ring-2 focus:ring-amber-400/20"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {isFoodCoordinator && (
              <Button
                asChild
                variant="outline"
                className="h-10 rounded-full border-border/70 font-semibold"
              >
                <Link to="/me/food/manage">
                  <ChefHat className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  <span className="hidden sm:inline">Food Management</span>
                  <span className="sm:hidden">Manage</span>
                </Link>
              </Button>
            )}
            <Button
              asChild
              className="h-10 rounded-full bg-primary px-4 font-bold text-primary-foreground shadow-xs hover:bg-primary/90"
            >
              <Link to="/me/food/orders">
                <ClipboardList className="mr-1.5 h-4 w-4" aria-hidden="true" />
                <span>My orders</span>
              </Link>
            </Button>
          </div>
        </div>

        {/* Section header: Title and date */}
        <header className="flex flex-wrap items-baseline justify-between gap-2 pt-1">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Today&rsquo;s menu</h2>
            <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
              {menu?.service_date
                ? new Date(`${menu.service_date}T00:00:00`).toLocaleDateString('en-GB', {
                    weekday: 'long', day: 'numeric', month: 'long',
                  })
                : 'Loading…'}
            </p>
          </div>
        </header>

        {/* Glovo Featured Restaurant / Canteen Banner Card */}
        {!isLoading && !isError && !menu?.closed && (
          <div className="relative overflow-hidden rounded-3xl border border-amber-300/70 bg-gradient-to-br from-amber-500/10 via-amber-50/50 to-card p-4 shadow-sm dark:border-amber-500/20 dark:from-amber-500/10 dark:via-card dark:to-card sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center rounded-full border border-rose-500/20 bg-rose-500/15 px-2.5 py-0.5 text-[11px] font-bold text-rose-700 dark:text-rose-300">
                  Staff Subsidized
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-bold text-amber-800 dark:text-amber-300">
                  <Star className="h-3 w-3 fill-amber-500 text-amber-500" />
                  98% (500+)
                </span>
              </div>
              <button
                type="button"
                onClick={() => setBannerFavorited(!bannerFavorited)}
                aria-label="Favorite canteen"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-background/80 text-foreground/70 backdrop-blur shadow-xs transition-transform hover:scale-110 active:scale-95"
              >
                <Heart className={cn('h-4 w-4 transition-colors', bannerFavorited ? 'fill-red-500 text-red-500' : 'text-muted-foreground')} />
              </button>
            </div>

            <div className="mt-3">
              <h1 className="text-xl font-extrabold tracking-tight text-foreground sm:text-2xl">
                Welile Staff Canteen
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground sm:text-sm">
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                  {menu?.service_date
                    ? new Date(`${menu.service_date}T00:00:00`).toLocaleDateString('en-GB', {
                        weekday: 'short', day: 'numeric', month: 'short',
                      })
                    : 'Today'}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                  Staff Dining Hall
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  Zero fees &middot; Deducted from payroll
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Glovo Quick Discovery Highlights (Horizontal promo badges) */}
        {!isLoading && !isError && !menu?.closed && category === 'all' && !searchQuery.trim() && (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-amber-500" />
                <h3 className="text-sm font-bold text-foreground sm:text-base">Kitchen Highlights</h3>
              </div>
              <span className="text-xs text-muted-foreground">Fresh daily</span>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-1.5 no-scrollbar">
              <div className="flex w-44 shrink-0 flex-col rounded-3xl border border-amber-300/60 bg-amber-50/50 p-3 shadow-xs dark:border-amber-500/20 dark:bg-amber-500/5">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
                  <Flame className="h-5 w-5" />
                </div>
                <p className="mt-2.5 text-xs font-bold text-foreground">Hot Chef Specials</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Cooked fresh on order</p>
              </div>

              <div className="flex w-44 shrink-0 flex-col rounded-3xl border border-emerald-300/60 bg-emerald-50/50 p-3 shadow-xs dark:border-emerald-500/20 dark:bg-emerald-500/5">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300">
                  <Utensils className="h-5 w-5" />
                </div>
                <p className="mt-2.5 text-xs font-bold text-foreground">Healthy Sides</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Nutritious greens & fruit</p>
              </div>

              <div className="flex w-44 shrink-0 flex-col rounded-3xl border border-blue-300/60 bg-blue-50/50 p-3 shadow-xs dark:border-blue-500/20 dark:bg-blue-500/5">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-300">
                  <Sparkles className="h-5 w-5" />
                </div>
                <p className="mt-2.5 text-xs font-bold text-foreground">Chilled Drinks</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Sodas, teas & juices</p>
              </div>
            </div>
          </div>
        )}

        {/* Glovo Category Navigation Tabs */}
        {!isLoading && !isError && !menu?.closed && categories.length > 0 && (
          <Tabs value={category} onValueChange={handleCategoryChange}>
            <TabsList
              variant="pills"
              aria-label="Filter the menu by meal category"
              className="flex h-auto w-full flex-wrap items-start justify-start gap-1.5 border-b border-border/40 pb-2.5 sm:gap-2"
            >
              <TabsTrigger
                variant="pills"
                value="all"
                className="rounded-full px-3.5 py-1.5 text-xs font-bold sm:px-4 sm:py-2 sm:text-sm"
              >
                All meals
              </TabsTrigger>
              {categories.map((c) => (
                <TabsTrigger
                  key={c.key}
                  variant="pills"
                  value={c.key}
                  className="rounded-full px-3.5 py-1.5 text-xs font-semibold sm:px-4 sm:py-2 sm:text-sm"
                >
                  {c.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}

        {/* Glovo Quick Filter Chips */}
        {!isLoading && !isError && !menu?.closed && (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={() => setFilterAvailableOnly(!filterAvailableOnly)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-all active:scale-95',
                filterAvailableOnly
                  ? 'border-primary bg-primary text-primary-foreground shadow-xs'
                  : 'border-border/70 bg-card text-muted-foreground hover:bg-muted',
              )}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Available now
            </button>
            <button
              type="button"
              onClick={() => setFilterUnder10k(!filterUnder10k)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-all active:scale-95',
                filterUnder10k
                  ? 'border-primary bg-primary text-primary-foreground shadow-xs'
                  : 'border-border/70 bg-card text-muted-foreground hover:bg-muted',
              )}
            >
              Under UGX 10k
            </button>
            {periods.map((p) => (
              <button
                key={p.period_id}
                type="button"
                onClick={() => {
                  const el = document.getElementById(`period-${p.period_id}`);
                  el?.scrollIntoView({ behavior: 'smooth' });
                }}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted active:scale-95"
              >
                <PeriodIcon name={p.name} />
                View {p.name}
              </button>
            ))}
          </div>
        )}

        {isLoading && (
          <div className="grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="overflow-hidden rounded-3xl border border-border/70 bg-card p-3">
                <Skeleton className="aspect-[4/3] w-full rounded-2xl" />
                <div className="space-y-2 p-3">
                  <Skeleton className="h-4 w-3/4 rounded-md" />
                  <Skeleton className="h-3 w-full rounded-md" />
                  <Skeleton className="h-9 w-full rounded-full" />
                </div>
              </div>
            ))}
          </div>
        )}

        {isError && (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-center">
            <AlertCircle className="h-8 w-8 text-destructive" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium">The menu could not be loaded</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {(error as Error)?.message ?? 'Please try again.'}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => refetch()}>Try again</Button>
          </div>
        )}

        {menu?.closed && (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-border/70 bg-card p-10 text-center">
            <CalendarOff className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
            <p className="text-sm font-medium">The canteen is closed today</p>
            <p className="text-xs text-muted-foreground">Please check back tomorrow.</p>
          </div>
        )}

        {!isLoading && !isError && !menu?.closed && periods.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-border/70 bg-card p-10 text-center">
            <UtensilsCrossed className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
            <p className="text-sm font-medium">No menu has been published yet</p>
            <p className="text-xs text-muted-foreground">
              The Food Coordinator publishes the menu each morning.
            </p>
          </div>
        )}

        {!menu?.closed && periods.map((period) => {
          const shown = period.meals
            .filter(inCategory)
            .filter(inSearch)
            .filter((m) => inChips(m, period));

          // while one category is open, a period with nothing in it is left out
          if (category !== 'all' && period.meals.filter(inCategory).length === 0) return null;

          return (
            <section id={`period-${period.period_id}`} key={period.period_id} className="space-y-4">
              {/* Glovo service-period panel: icon, name, status, window and limit, collection note */}
              <div className="rounded-3xl border border-amber-200/70 bg-amber-50/60 p-4 dark:border-amber-500/15 dark:bg-amber-500/5 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                      <PeriodIcon name={period.name} />
                    </span>
                    <h3 className="text-base font-bold text-foreground sm:text-lg">{period.name}</h3>
                    <span
                      className={period.ordering_open
                        ? 'inline-flex items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-xs font-semibold text-success'
                        : 'inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground'}
                    >
                      <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                      {period.ordering_open ? 'Ordering open' : 'Ordering closed'}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground sm:text-sm">
                    {isFoodAllDayWindow(period.ordering_opens_at, period.ordering_closes_at)
                      ? 'Orders open all day'
                      : <>Orders {clock(period.ordering_opens_at)} – {clock(period.ordering_closes_at)}</>}
                    {period.max_qty_per_employee !== null && (
                      <> &middot; up to {period.max_qty_per_employee} per person</>
                    )}
                  </p>
                </div>

                {period.collection_instructions && (
                  <p className="mt-3 flex items-start gap-2 border-t border-amber-200/60 pt-3 text-xs leading-relaxed text-muted-foreground dark:border-amber-500/15 sm:text-sm">
                    <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{period.collection_instructions}</span>
                  </p>
                )}
              </div>

              {shown.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
                  Nothing matching your selection for {period.name.toLowerCase()} today.
                </p>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {shown.map((meal) => (
                    <FoodMealCard
                      key={meal.menu_item_id}
                      meal={meal}
                      quantity={cart[meal.menu_item_id] ?? 0}
                      orderingOpen={period.ordering_open}
                      remainingAllowance={mealCap(period, meal.menu_item_id)}
                      onChange={(q) => setQuantity(meal, period.period_id, q)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}

        {!isLoading && !isError && !menu?.closed && category !== 'all' && shownCount === 0 && (
          <p className="rounded-2xl border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
            Nothing on the menu under {categories.find((c) => c.key === category)?.label ?? category} today.
          </p>
        )}
      </div>

      {/* Glovo Floating Sticky Bottom Cart Bar */}
      {cartCount > 0 && (
        <div className="sticky bottom-4 z-30 mx-auto w-full max-w-5xl px-3 sm:px-6">
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-300/80 bg-card/95 p-3.5 shadow-2xl backdrop-blur-md dark:border-amber-500/30">
            <div className="flex items-center gap-3 min-w-0">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-extrabold text-primary-foreground shadow-xs">
                {cartCount}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-bold text-foreground tabular-nums sm:text-base">
                  {cartCount} item{cartCount === 1 ? '' : 's'} &middot; {formatUgx(cartTotal)}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  Will be recorded as unpaid
                </p>
              </div>
            </div>
            <Button
              className="h-10 rounded-full bg-primary px-5 font-bold text-primary-foreground shadow-md transition-all hover:bg-primary/90 hover:shadow-lg active:scale-95"
              onClick={() => setCartOpen(true)}
            >
              <ShoppingBag className="mr-2 h-4 w-4" aria-hidden="true" />
              Review order
            </Button>
          </div>
        </div>
      )}

      <FoodCartSheet
        open={cartOpen}
        onOpenChange={setCartOpen}
        lines={lines}
        periodName={activePeriod?.name ?? null}
        collectionInstructions={activePeriod?.collection_instructions ?? null}
        specialInstructions={notes}
        onSpecialInstructionsChange={setNotes}
        onChangeQuantity={(id, q) => {
          const next = { ...cart };
          if (q <= 0) delete next[id]; else next[id] = q;
          setCart(next);
          if (Object.keys(next).length === 0) setActivePeriodId(null);
          renewKey();
        }}
        paymentModes={['wallet']}
        paymentMode={paymentMode}
        onPaymentModeChange={setPaymentMode}
        maxInstructions={menu?.max_instructions_length ?? FOOD_MAX_INSTRUCTIONS}
        orderingOpen={activePeriod?.ordering_open ?? false}
        onSubmit={submit}
        submitting={placeOrder.isPending}
      />
    </PersonalLayout>
  );
}
