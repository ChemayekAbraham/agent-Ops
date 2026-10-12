import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  foodErrorMessage, isFoodCheckoutDisabled, canStartPreparing, isFoodMockMode, foodToday,
  FULFILMENT_REQUIRES_PAYMENT,
  type FoodPaymentStatus, type FoodPaymentMode, type FoodExceptionKind,
} from '@/lib/foodService';

/**
 * The development fixture, loaded on demand. Every caller guards with the
 * literal `import.meta.env.DEV`, which Vite replaces with `false` in a
 * production build, so the bundler drops this import and the fixture module
 * (its demo identities and seeded orders) never ships.
 */
type FoodMock = typeof import('@/lib/foodService.mock');
let foodMock: Promise<FoodMock> | null = null;
function loadFoodMock(): Promise<FoodMock> {
  foodMock ??= import('@/lib/foodService.mock');
  return foodMock;
}
import type {
  FoodMenuDay, FoodCoordinatorOverview, FoodPreparationRow, FoodOrderDetail,
  FoodAuditEntry, FoodFulfilmentStatus, FoodHandoverMode, FoodOrderEvent, FoodException,
  FoodCategory, FoodServicePeriod, FoodServiceClosure, FoodCoordinatorAssignment, FoodMeal,
} from '@/lib/foodService';

/**
 * Employee Food Ordering — data layer.
 *
 * Every write goes through a SECURITY DEFINER RPC; there is no direct table
 * write path (the migration revokes INSERT/UPDATE/DELETE from `authenticated`,
 * because Supabase's default privileges would otherwise hand them out and a
 * direct edit would leave no row in food_audit).
 *
 * PAYMENT IS DISABLED, ordering is not. `food_place_order` creates an UNPAID
 * order and touches no wallet, balance or ledger entry. `food_pay_order` is the
 * only step that would move money and it refuses with FOOD_CHECKOUT_DISABLED.
 * Gate any pay affordance on `checkout_enabled` from the server payload, never
 * on a client constant, so enabling it later is a backend change only.
 *
 * Every build talks to the real RPCs. The in-memory fixture backend in
 * `@/lib/foodService.mock` answers instead only in a development build with
 * VITE_FOOD_SERVICE_MOCK=true (see isFoodMockMode); a production bundle can
 * never serve fixture data.
 */

// The food_* RPCs live in migrations 20261009120000 / 20261009130000, which are
// not applied yet, so they are absent from the generated Supabase types. This
// cast keeps the file compiling; regenerate types after the migrations land.
type RpcResult<T> = Promise<{ data: T | null; error: { message: string } | null }>;

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  if (import.meta.env.DEV && isFoodMockMode()) return (await loadFoodMock()).foodMockRpc<T>(fn, args);
  const { data, error } = await (
    supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => RpcResult<T>
  )(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

type SelectOpts = {
  serviceDate?: string; mineOnly?: boolean; entity?: string; entityId?: string;
  includeArchived?: boolean; includeInactive?: boolean;
};

/** Newest-first reads are capped server-side so the newest rows are never the
 *  ones a PostgREST row limit silently drops. */
const FOOD_READ_LIMIT = 200;

/** One place that knows whether a read comes from the fixture store or Postgres. */
async function selectRows<T>(table: string, opts: SelectOpts = {}): Promise<T[]> {
  if (import.meta.env.DEV && isFoodMockMode()) return (await loadFoodMock()).foodMockSelect<T[]>(table, opts);
  // An order's lines are a separate table; embed them so `order.items` exists
  // exactly as FoodOrderDetail promises (RLS on food_order_items applies).
  let q = supabase.from(table as never)
    .select(table === 'food_orders' ? '*, items:food_order_items(*)' : '*');
  if (opts.serviceDate) q = q.eq('service_date', opts.serviceDate);
  if (opts.mineOnly) {
    // RLS lets the Food Coordinator read every order, so "my orders" must be
    // filtered explicitly or the coordinator would see everyone's.
    const me = await resolveFoodUserId();
    if (!me) return [];
    q = q.eq('employee_id', me);
  }
  if (opts.entity) q = q.eq('entity', opts.entity);
  if (opts.entityId) {
    q = q.eq(table === 'food_order_events' ? 'order_id' : 'entity_id', opts.entityId);
  }
  if (table === 'food_categories' && !opts.includeArchived) q = q.is('archived_at', null);
  if (table === 'food_service_periods' && !opts.includeInactive) q = q.eq('active', true);
  if (table === 'food_orders') q = q.order('placed_at', { ascending: false }).limit(FOOD_READ_LIMIT);
  if (table === 'food_audit') q = q.order('created_at', { ascending: false }).limit(FOOD_READ_LIMIT);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as T[];
}

/**
 * Display names for the coordinator screens. Profiles are not readable to the
 * coordinator, so names come from food_people_names, which returns id and name
 * only, and only for food participants. The fixture rows already carry names.
 */
async function attachNames<R extends Record<string, unknown>>(
  rows: R[], idKey: keyof R, nameKey: string,
): Promise<R[]> {
  if (isFoodMockMode() || rows.length === 0) return rows;
  const ids = [...new Set(rows.map((r) => r[idKey]).filter(Boolean) as string[])];
  if (ids.length === 0) return rows;
  const names = await call<{ user_id: string; full_name: string }[]>(
    'food_people_names', { p_ids: ids });
  const byId = new Map((names ?? []).map((n) => [n.user_id, n.full_name]));
  return rows.map((r) => ({ ...r, [nameKey]: byId.get(r[idKey] as string) ?? r[nameKey] }));
}

export * from '@/lib/foodService';
export { isFoodCheckoutDisabled };

const keys = {
  all: ['food'] as const,
  menu: (d?: string) => ['food', 'menu', d ?? 'today'] as const,
  overview: (d?: string) => ['food', 'overview', d ?? 'today'] as const,
  prep: (d?: string, p?: string) => ['food', 'prep', d ?? 'today', p ?? 'all'] as const,
  myOrders: () => ['food', 'my-orders'] as const,
  orders: (d?: string) => ['food', 'orders', d ?? 'today'] as const,
  events: (id?: string) => ['food', 'events', id ?? 'all'] as const,
  audit: (e?: string, id?: string) => ['food', 'audit', e ?? 'all', id ?? 'all'] as const,
  coordinator: () => ['food', 'coordinator-status'] as const,
};

function invalidateFood(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: keys.all });
}

/** Turns a server or fixture error into something worth showing a person. */
function onError(e: Error) { toast.error(foodErrorMessage(e)); }

/**
 * Whether the kitchen must see payment before preparing an order.
 *
 * False everywhere: payment is made after delivery (CFO decision 2026-10-12),
 * and `food_set_fulfilment` no longer reads payment_status. Nothing is marked
 * paid either way — payment and fulfilment stay independent.
 *
 * Prefer `fulfilment_requires_payment` from useFoodCoordinatorOverview where
 * you already have it: that comes from the server. Use this when you do not.
 */
export function foodPaymentRequiredBeforePrep(): boolean {
  return FULFILMENT_REQUIRES_PAYMENT;
}

/**
 * `canStartPreparing` with this environment's rule already applied — the one
 * to bind a "Start preparing" button to.
 */
export function canStartPreparingHere(
  fulfilment: Parameters<typeof canStartPreparing>[0],
  payment: FoodPaymentStatus,
): boolean {
  return canStartPreparing(fulfilment, payment, {
    requirePayment: foodPaymentRequiredBeforePrep(),
  });
}

// ─────────────────────── session wiring ───────────────────────

/**
 * Resolves the signed-in user id and, in fixture mode, points the fixture at
 * them before anything is read.
 *
 * This is awaited inside the queries rather than left to an effect: an effect
 * runs after the first render, so a permission query firing on mount would ask
 * on behalf of the wrong person and then cache that answer. That is exactly how
 * the active Food Coordinator ended up being told she had no access.
 */
async function resolveFoodUserId(): Promise<string | null> {
  let id: string | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    id = data.user?.id ?? null;
  } catch {
    id = null;
  }
  if (import.meta.env.DEV && isFoodMockMode()) (await loadFoodMock()).setFoodMockUser(id);
  return id;
}

/**
 * Drops every cached Food answer when the signed-in user changes (FM-24).
 * The permission and order queries are keyed without the user id, so without
 * this a second account signing in on the same tab was briefly shown the
 * first account's coordinator status and orders.
 */
function useFoodCacheFollowsAuth() {
  const qc = useQueryClient();
  useEffect(() => {
    const onChange = supabase.auth.onAuthStateChange?.((event) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        // reset (not just remove): mounted queries refetch for the new user
        void qc.resetQueries({ queryKey: keys.all });
      }
    });
    return () => onChange?.data?.subscription?.unsubscribe();
  }, [qc]);
}

/** Whether the signed-in user may use the canteen at all (staff or coordinator). */
export function useFoodCanUseCanteen() {
  useFoodCacheFollowsAuth();
  return useQuery({
    queryKey: ['food', 'can-use-canteen'] as const,
    staleTime: 60_000,
    queryFn: async () => {
      const userId = await resolveFoodUserId();
      if (!userId && !isFoodMockMode()) return false;
      return !!(await call<boolean>('food_can_use_canteen'));
    },
  });
}

/**
 * Keeps the fixture backend pointed at the signed-in user. Mount once, high in
 * the food section. The queries no longer depend on it having run, but it makes
 * the attribution correct as early as possible.
 */
export function useFoodSession() {
  useEffect(() => {
    let cancelled = false;
    void resolveFoodUserId().then(() => { if (cancelled) return; });
    return () => { cancelled = true; };
  }, []);
}

// ─────────────────────────── reads ───────────────────────────

/** The employee-facing menu for a day. Pass nothing for today (Kampala). */
export function useFoodMenu(serviceDate?: string) {
  return useQuery({
    queryKey: keys.menu(serviceDate),
    queryFn: () => call<FoodMenuDay>('food_menu_for_day', { p_service_date: serviceDate ?? null }),
    // the ordering window closes on a clock, so do not serve a stale "open"
    refetchInterval: 60_000,
  });
}

/** Coordinator dashboard counters. Errors with 42501 for anyone else. */
export function useFoodCoordinatorOverview(serviceDate?: string, enabled = true) {
  return useQuery({
    queryKey: keys.overview(serviceDate),
    enabled,
    queryFn: () => call<FoodCoordinatorOverview>('food_coordinator_overview', {
      p_service_date: serviceDate ?? null,
    }),
  });
}

/** Consolidated kitchen list: paid, non-cancelled orders only. */
export function useFoodPreparationList(serviceDate?: string, periodId?: string, enabled = true) {
  return useQuery({
    queryKey: keys.prep(serviceDate, periodId),
    enabled,
    queryFn: () => call<FoodPreparationRow[]>('food_preparation_list', {
      p_service_date: serviceDate ?? null,
      p_period_id: periodId ?? null,
    }),
  });
}

/**
 * Whether the signed-in user holds Food Coordinator access, and whether it is
 * the active assignment (a backup holder reads but cannot author the menu).
 * Drives navigation visibility — Food Management is separate from CFO Controls.
 */
export function useFoodCoordinatorStatus() {
  useFoodCacheFollowsAuth();
  return useQuery({
    queryKey: keys.coordinator(),
    staleTime: 30_000,
    queryFn: async () => {
      const userId = await resolveFoodUserId();
      // Signed out is a definite "no" against the real service. The fixture has
      // its own demo identity, so it answers for that instead.
      if (!userId && !isFoodMockMode()) {
        return { isCoordinator: false, isActive: false, userId: null };
      }
      const [isCoordinator, isActive] = await Promise.all([
        call<boolean>('is_food_coordinator', { _user_id: userId }),
        call<boolean>('is_active_food_coordinator', { _user_id: userId }),
      ]);
      return { isCoordinator: !!isCoordinator, isActive: !!isActive, userId };
    },
  });
}

/**
 * Route guard for Food Management. `allowed` is only meaningful once `checked`
 * is true — render a skeleton until then rather than a denial.
 */
export function useRequireFoodCoordinator(requireActive = false) {
  const q = useFoodCoordinatorStatus();
  const s = q.data;
  return {
    checked: !q.isLoading,
    allowed: requireActive ? !!s?.isActive : !!s?.isCoordinator,
    isActive: !!s?.isActive,
    /** holds access but not the active assignment: read-only */
    isBackupOnly: !!s?.isCoordinator && !s?.isActive,
    userId: s?.userId ?? null,
  };
}

/** The signed-in employee's own orders, newest first. */
export function useMyFoodOrders() {
  return useQuery({
    queryKey: keys.myOrders(),
    queryFn: async () => {
      const rows = await selectRows<FoodOrderDetail>('food_orders', { mineOnly: true });
      return [...rows].sort((a, b) => String(b.placed_at).localeCompare(String(a.placed_at)));
    },
  });
}

/** All orders for a service date. RLS returns rows only to the coordinator. */
export function useFoodOrders(serviceDate?: string, enabled = true) {
  return useQuery({
    queryKey: keys.orders(serviceDate),
    enabled,
    queryFn: async () => {
      const rows = await selectRows<FoodOrderDetail>('food_orders', {
        serviceDate: serviceDate ?? foodToday(),
      });
      const named = await attachNames(
        rows as unknown as Record<string, unknown>[], 'employee_id', 'employee_name',
      ) as unknown as FoodOrderDetail[];
      return [...named].sort((a, b) => String(b.placed_at).localeCompare(String(a.placed_at)));
    },
  });
}

/** The status trail for one order. */
export function useFoodOrderEvents(orderId?: string) {
  return useQuery({
    queryKey: keys.events(orderId),
    enabled: !!orderId,
    queryFn: async () => {
      const rows = await selectRows<FoodOrderEvent>('food_order_events', { entityId: orderId });
      return [...rows].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    },
  });
}

/** Immutable audit history. Coordinator-only. */
export function useFoodAuditHistory(entity?: string, entityId?: string, enabled = true) {
  return useQuery({
    queryKey: keys.audit(entity, entityId),
    enabled,
    queryFn: async () => {
      const rows = await selectRows<FoodAuditEntry>('food_audit', { entity, entityId });
      return [...rows]
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 200);
    },
  });
}

export function useFoodExceptions(enabled = true) {
  return useQuery({
    queryKey: ['food', 'exceptions'] as const,
    enabled,
    queryFn: () => selectRows<FoodException>('food_exceptions'),
  });
}

export function useFoodCoordinatorAssignments(enabled = true) {
  return useQuery({
    queryKey: ['food', 'assignments'] as const,
    enabled,
    queryFn: async () => {
      const rows = await selectRows<FoodCoordinatorAssignment>('food_coordinator_assignments');
      const named = await attachNames(
        rows as unknown as Record<string, unknown>[], 'coordinator_id', 'coordinator_name',
      ) as unknown as FoodCoordinatorAssignment[];
      return [...named].sort((a, b) => String(b.assigned_at).localeCompare(String(a.assigned_at)));
    },
  });
}

/** Every meal on the books. Employees see published ones only. */
export function useFoodMeals(enabled = true) {
  return useQuery({
    queryKey: ['food', 'meals'] as const,
    enabled,
    queryFn: () => selectRows<FoodMeal>('food_meals'),
  });
}

export function useFoodCategories(includeArchived = false) {
  return useQuery({
    queryKey: ['food', 'categories', includeArchived] as const,
    queryFn: async () => {
      const rows = await selectRows<FoodCategory>('food_categories', { includeArchived });
      return [...rows].sort((a, b) => a.sort_order - b.sort_order);
    },
  });
}

export function useFoodServicePeriods(includeInactive = false) {
  return useQuery({
    queryKey: ['food', 'periods', includeInactive] as const,
    queryFn: async () => {
      const rows = await selectRows<FoodServicePeriod>('food_service_periods', { includeInactive });
      return [...rows].sort((a, b) => a.ordering_opens_at.localeCompare(b.ordering_opens_at));
    },
  });
}

export function useFoodClosures() {
  return useQuery({
    queryKey: ['food', 'closures'] as const,
    queryFn: async () => {
      const rows = await selectRows<FoodServiceClosure>('food_service_closures');
      return [...rows].sort((a, b) => a.closure_date.localeCompare(b.closure_date));
    },
  });
}

// ───────────────────────── menu management ─────────────────────────

export interface UpsertMealInput {
  mealId?: string | null;
  name: string;
  description?: string | null;
  categoryId?: string | null;
  priceUgx: number;
  imagePath?: string | null;
  reason?: string | null;
}

export function useUpsertFoodMeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertMealInput) => call<string>('food_upsert_meal', {
      p_meal_id: input.mealId ?? null,
      p_name: input.name,
      p_description: input.description ?? null,
      p_category_id: input.categoryId ?? null,
      p_price_ugx: input.priceUgx,
      p_image_path: input.imagePath ?? null,
      p_reason: input.reason ?? null,
    }),
    onSuccess: (_d, v) => {
      invalidateFood(qc);
      toast.success(v.mealId ? 'Meal updated' : 'Meal added as a draft');
    },
    onError,
  });
}

export function useSetFoodMealStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { mealId: string; status: 'draft' | 'published' | 'archived'; reason?: string }) =>
      call<void>('food_set_meal_status', {
        p_meal_id: v.mealId, p_status: v.status, p_reason: v.reason ?? null,
      }),
    onSuccess: (_d, v) => {
      invalidateFood(qc);
      toast.success(
        v.status === 'published' ? 'Meal published'
        : v.status === 'archived' ? 'Meal archived — past orders keep their original details'
        : 'Meal moved to draft',
      );
    },
    onError,
  });
}

export interface ScheduleMealInput {
  serviceDate: string;
  periodId: string;
  mealId: string;
  /** omit to use the meal's standard price */
  priceUgx?: number | null;
  /** omit for unlimited servings */
  servingsTotal?: number | null;
  publish?: boolean;
}

export function useScheduleFoodMeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: ScheduleMealInput) => call<string>('food_schedule_meal', {
      p_service_date: v.serviceDate,
      p_period_id: v.periodId,
      p_meal_id: v.mealId,
      p_price_ugx: v.priceUgx ?? null,
      p_servings_total: v.servingsTotal ?? null,
      p_publish: v.publish ?? false,
    }),
    onSuccess: (_d, v) => {
      invalidateFood(qc);
      toast.success(v.publish ? 'Added to the menu' : 'Saved as a draft menu item');
    },
    onError,
  });
}

export function useSetFoodSoldOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { menuItemId: string; soldOut: boolean; reason?: string }) =>
      call<void>('food_set_sold_out', {
        p_menu_item_id: v.menuItemId, p_sold_out: v.soldOut, p_reason: v.reason ?? null,
      }),
    onSuccess: (_d, v) => {
      invalidateFood(qc);
      toast.success(v.soldOut ? 'Marked sold out' : 'Marked available');
    },
    onError,
  });
}

// ───────────────────────── fulfilment ─────────────────────────

export function useSetFoodFulfilment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { orderId: string; toStatus: FoodFulfilmentStatus; note?: string }) =>
      call<{ order_id: string; from: string; to: string }>('food_set_fulfilment', {
        p_order_id: v.orderId, p_to_status: v.toStatus, p_note: v.note ?? null,
      }),
    onSuccess: (_d, v) => {
      invalidateFood(qc);
      toast.success(`Order marked ${v.toStatus}`);
    },
    onError,
  });
}

// ───────────────────────── ordering ─────────────────────────

export interface PlaceOrderItem {
  menuItemId: string;
  quantity: number;
}

export interface PlaceOrderResult {
  order_id: string;
  order_reference: string;
  total_ugx: number;
  payment_status: string;
  payment_mode: FoodPaymentMode | null;
  replayed: boolean;
}

/**
 * Places an UNPAID order with the employee's chosen payment mode. The mode is
 * recorded only: no wallet is read or debited, no money moves, no ledger entry
 * is written and the order is not marked paid. Payment is after delivery.
 *
 * `idempotencyKey` must be generated once per cart and reused for every retry
 * of that same cart, so a double submit cannot create two orders. Generate a
 * fresh one after a successful submit AND whenever the cart's contents change.
 */
export function usePlaceFoodOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      items: PlaceOrderItem[]; idempotencyKey: string; paymentMode: FoodPaymentMode;
      specialInstructions?: string;
    }) => call<PlaceOrderResult>('food_place_order', {
      p_items: v.items.map((i) => ({ menu_item_id: i.menuItemId, quantity: i.quantity })),
      p_idempotency_key: v.idempotencyKey,
      p_payment_mode: v.paymentMode,
      p_special_instructions: v.specialInstructions ?? null,
    }),
    onSuccess: (d) => {
      invalidateFood(qc);
      toast.success(
        d?.replayed
          ? `Order ${d.order_reference} was already placed`
          : `Order ${d?.order_reference} placed — you pay after delivery`,
      );
    },
    onError,
  });
}

/**
 * Settlement. The server refuses every call with FOOD_CHECKOUT_DISABLED. Wired
 * so the screen exists, but no pay affordance should be enabled: bind it to
 * `checkout_enabled` from useFoodMenu, which is false.
 */
export function usePayFoodOrder() {
  return useMutation({
    mutationFn: (v: { orderId: string }) =>
      call<unknown>('food_pay_order', { p_order_id: v.orderId }),
    onError,
  });
}

/** An employee withdraws their own unpaid order before the kitchen starts it. */
export function useCancelMyFoodOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { orderId: string; reason?: string }) =>
      call<{ order_id: string; status: string }>('food_cancel_my_order', {
        p_order_id: v.orderId, p_reason: v.reason ?? null,
      }),
    onSuccess: () => {
      invalidateFood(qc);
      toast.success('Order withdrawn');
    },
    onError,
  });
}

/**
 * Close a food exception. The active Food Coordinator only — the server decides
 * that from the session, so hiding the control is presentation, not security.
 * The reason is mandatory and lands in the append-only audit history.
 */
export function useResolveFoodException() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { exceptionId: string; reason: string }) =>
      call<{ exception_id: string; resolved_at: string; reason: string }>(
        'food_resolve_exception',
        { p_exception_id: v.exceptionId, p_reason: v.reason },
      ),
    onSuccess: () => {
      invalidateFood(qc);
      toast.success('Exception resolved');
    },
    onError,
  });
}

/**
 * Log a food exception (FM-21). The active Food Coordinator may log one with or
 * without an order; an employee may report a problem with their OWN order only,
 * one open report per order. Operational only: it changes no order status, no
 * payment status and moves no money. The server decides who may do what.
 */
export function useRaiseFoodException() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { kind: FoodExceptionKind; note: string; orderId?: string | null }) =>
      call<{ exception_id: string; kind: string; raised_via: string }>('food_raise_exception', {
        p_kind: v.kind, p_note: v.note, p_order_id: v.orderId ?? null,
      }),
    onSuccess: (d) => {
      invalidateFood(qc);
      toast.success(d?.raised_via === 'employee'
        ? 'Problem reported to the Food Coordinator'
        : 'Exception logged');
    },
    onError,
  });
}

// ──────────── categories, service periods and closures ────────────
// These supporting records have no direct write path either; the migration
// revokes it, so the RPCs below are the only way to maintain them.

export function useUpsertFoodCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      categoryId?: string | null; name: string; sortOrder?: number; reason?: string;
    }) => call<string>('food_upsert_category', {
      p_category_id: v.categoryId ?? null,
      p_name: v.name,
      p_sort_order: v.sortOrder ?? 100,
      p_reason: v.reason ?? null,
    }),
    onSuccess: (_d, v) => {
      invalidateFood(qc);
      toast.success(v.categoryId ? 'Category updated' : 'Category added');
    },
    onError,
  });
}

/** Refused while the category still holds meals that are not archived. */
export function useArchiveFoodCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { categoryId: string; reason?: string }) =>
      call<void>('food_archive_category', {
        p_category_id: v.categoryId, p_reason: v.reason ?? null,
      }),
    onSuccess: () => {
      invalidateFood(qc);
      toast.success('Category archived');
    },
    onError,
  });
}

export interface UpsertServicePeriodInput {
  periodId?: string | null;
  name: string;
  /** 'HH:MM' in Africa/Kampala */
  opensAt: string;
  closesAt: string;
  collectionInstructions?: string | null;
  maxQtyPerEmployee?: number | null;
  active?: boolean;
  reason?: string;
}

export function useUpsertFoodServicePeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: UpsertServicePeriodInput) => call<string>('food_upsert_service_period', {
      p_period_id: v.periodId ?? null,
      p_name: v.name,
      p_opens_at: v.opensAt,
      p_closes_at: v.closesAt,
      p_collection_instructions: v.collectionInstructions ?? null,
      p_max_qty_per_employee: v.maxQtyPerEmployee ?? null,
      p_active: v.active ?? true,
      p_reason: v.reason ?? null,
    }),
    onSuccess: (_d, v) => {
      invalidateFood(qc);
      toast.success(v.periodId ? 'Service period updated' : 'Service period added');
    },
    onError,
  });
}

/**
 * Close or reopen a service day. Closing needs a reason and is refused while
 * paid orders for that day are still outstanding.
 */
export function useSetFoodClosure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { closureDate: string; closed: boolean; reason?: string }) =>
      call<void>('food_set_closure', {
        p_closure_date: v.closureDate, p_closed: v.closed, p_reason: v.reason ?? null,
      }),
    onSuccess: (_d, v) => {
      invalidateFood(qc);
      toast.success(v.closed ? 'Service day closed' : 'Service day reopened');
    },
    onError,
  });
}

export interface FoodCoordinatorCandidate {
  user_id: string;
  full_name: string;
}

/**
 * Who the role can be handed to. Served by `food_coordinator_candidates()`,
 * which is restricted to the active Food Coordinator and returns id and name
 * only — no other employee detail is exposed to this feature.
 *
 * Disabled for anyone who cannot hand over, so a backup holder or an ordinary
 * employee never triggers the lookup at all.
 */
export function useFoodCoordinatorCandidates(enabled = true) {
  return useQuery({
    queryKey: ['food', 'coordinator-candidates'] as const,
    enabled,
    staleTime: 60_000,
    queryFn: () => call<FoodCoordinatorCandidate[]>('food_coordinator_candidates'),
  });
}

// ───────────────────────── coordinator handover ─────────────────────────

/**
 * Hand the Food Coordinator role to another verified account. The outgoing
 * assignment is revoked and retained (never deleted) and the handover writes an
 * immutable audit row. `transfer_with_backup` leaves the outgoing holder
 * read-only access; `full_transfer` removes their access entirely.
 */
export function useTransferFoodCoordinator() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { toUserId: string; mode: FoodHandoverMode; reason: string }) =>
      call<{ status: string; to_name: string; mode: FoodHandoverMode }>(
        'food_transfer_coordinator',
        { p_to_user_id: v.toUserId, p_mode: v.mode, p_reason: v.reason },
      ),
    onSuccess: (d) => {
      invalidateFood(qc);
      toast.success(`Food Coordinator transferred to ${d?.to_name ?? 'the new holder'}`);
    },
    onError,
  });
}
