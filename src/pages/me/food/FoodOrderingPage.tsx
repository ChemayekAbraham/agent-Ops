import { useMemo, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle, CalendarOff, ClipboardList, Clock, Info, Moon, ShoppingBag, Sun, Sunrise,
  UtensilsCrossed,
} from 'lucide-react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import FoodMealCard from '@/components/food/FoodMealCard';
import FoodCartSheet, { type CartLine } from '@/components/food/FoodCartSheet';
import { isFoodAllDayWindow } from '@/lib/foodService';
import { safeUUID } from '@/lib/safeUUID';
import {
  useFoodMenu, useFoodSession, usePlaceFoodOrder, useMyFoodOrders,
  formatUgx, FOOD_PAYMENT_MODES, FOOD_MAX_QTY_PER_LINE, FOOD_MAX_INSTRUCTIONS,
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
  return <Icon className="h-5 w-5" aria-hidden="true" />;
}

export default function FoodOrderingPage() {
  useFoodSession();

  const { data: menu, isLoading, isError, error, refetch } = useFoodMenu();
  const { data: myOrders } = useMyFoodOrders();
  const placeOrder = usePlaceFoodOrder();

  // menuItemId -> quantity, scoped to one service period at a time
  const [cart, setCart] = useState<Record<string, number>>({});
  const [activePeriodId, setActivePeriodId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [cartOpen, setCartOpen] = useState(false);
  // Chosen by the employee, never defaulted: it is recorded on the order.
  const [paymentMode, setPaymentMode] = useState<FoodPaymentMode | null>(null);
  // One key per cart CONTENTS. Reused on every retry of an unchanged cart so a
  // double submit cannot create two orders; replaced after the order is
  // accepted and whenever the cart changes, so an edited cart is never answered
  // with a replay of an earlier one.
  const [idempotencyKey, setIdempotencyKey] = useState(() => safeUUID());
  const renewKey = () => setIdempotencyKey(safeUUID());

  const periods = useMemo(() => menu?.periods ?? [], [menu?.periods]);
  const activePeriod = periods.find((p) => p.period_id === activePeriodId) ?? null;

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

  /**
   * The most of ONE meal this card may hold: the per-period allowance left
   * after orders already held and the OTHER meals in the cart, and never more
   * than the server's per-line limit. The card compares its own quantity to
   * this, so its own quantity must not be subtracted here as well. The server
   * counts what the employee already holds and is the real authority.
   */
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
    // an order cannot mix service periods, so switching period clears the cart
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
          setPaymentMode(null);
          setCartOpen(false);
          renewKey();
        },
      },
    );
  };

  return (
    <PersonalLayout title="Canteen">
      <div className="mx-auto w-full max-w-5xl space-y-5 p-4 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Today&rsquo;s menu</h2>
            <p className="mt-0.5 text-sm text-muted-foreground sm:text-base">
              {menu?.service_date
                ? new Date(`${menu.service_date}T00:00:00`).toLocaleDateString('en-GB', {
                    weekday: 'long', day: 'numeric', month: 'long',
                  })
                : 'Loading…'}
            </p>
          </div>
          <Button
            asChild
            className="h-11 rounded-xl bg-primary px-4 font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
          >
            <Link to="/me/food/orders">
              <ClipboardList className="mr-2 h-4 w-4" aria-hidden="true" />
              My orders
            </Link>
          </Button>
        </header>

        {isLoading && (
          <div className="grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="overflow-hidden rounded-xl border border-border/70">
                <Skeleton className="aspect-[4/3] w-full rounded-none" />
                <div className="space-y-2 p-4">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              </div>
            ))}
          </div>
        )}

        {isError && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center">
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
          <div className="flex flex-col items-center gap-2 rounded-xl border border-border/70 bg-card p-10 text-center">
            <CalendarOff className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
            <p className="text-sm font-medium">The canteen is closed today</p>
            <p className="text-xs text-muted-foreground">Please check back tomorrow.</p>
          </div>
        )}

        {!isLoading && !isError && !menu?.closed && periods.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-border/70 bg-card p-10 text-center">
            <UtensilsCrossed className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
            <p className="text-sm font-medium">No menu has been published yet</p>
            <p className="text-xs text-muted-foreground">
              The Food Coordinator publishes the menu each morning.
            </p>
          </div>
        )}

        {!menu?.closed && periods.map((period) => {
          return (
            <section key={period.period_id} className="space-y-4">
              {/* service-period panel: icon, name, status, window and limit, collection note */}
              <div className="rounded-2xl border border-amber-200/60 bg-amber-50/60 px-4 py-3 dark:border-amber-500/15 dark:bg-amber-500/5 sm:px-5">
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

              {period.meals.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
                  Nothing on the menu for {period.name.toLowerCase()} today.
                </p>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {period.meals.map((meal) => (
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
      </div>

      {cartCount > 0 && (
        <div className="sticky bottom-0 z-10 border-t border-border/70 bg-background/95 p-3 backdrop-blur">
          <div className="mx-auto flex w-full max-w-5xl items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {cartCount} item{cartCount === 1 ? '' : 's'} &middot; {formatUgx(cartTotal)}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                Will be recorded as unpaid
              </p>
            </div>
            <Button onClick={() => setCartOpen(true)}>
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
        paymentModes={menu?.payment_modes ?? FOOD_PAYMENT_MODES}
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
