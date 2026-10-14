/**
 * Employee Food Ordering — shared types and the rules the UI is allowed to
 * assume. Deliberately free of any Supabase import so it stays unit-testable
 * and can be pulled into components without dragging in a client.
 *
 * Anything here that mirrors server behaviour is recorded behaviour, verified
 * against the real RPCs in the sandbox on 2026-10-09, not a guess. The server
 * remains authoritative: these rules exist so the UI can disable a control
 * rather than let someone click into a guaranteed error.
 */

export interface FoodMenuMeal {
  menu_item_id: string;
  meal_id: string;
  name: string;
  description: string | null;
  image_path: string | null;
  category: string | null;
  price_ugx: number;
  servings_total: number | null;
  /** null when the meal has no serving cap */
  servings_remaining: number | null;
  sold_out: boolean;
}

export interface FoodMenuPeriod {
  period_id: string;
  name: string;
  ordering_opens_at: string;
  ordering_closes_at: string;
  /** server-evaluated against Africa/Kampala — do not recompute in the browser */
  ordering_open: boolean;
  collection_instructions: string | null;
  max_qty_per_employee: number | null;
  meals: FoodMenuMeal[];
}

export interface FoodMenuDay {
  service_date: string;
  closed: boolean;
  /** false: settlement is disabled; payment is made after delivery */
  checkout_enabled: boolean;
  /** the payment modes the server accepts on food_place_order */
  payment_modes?: FoodPaymentMode[];
  /** server bound: most servings of one meal in one order */
  max_qty_per_line?: number;
  /** server bound: longest accepted special instructions */
  max_instructions_length?: number;
  periods: FoodMenuPeriod[];
}

/**
 * How the employee intends to pay AFTER delivery. Recorded on the order only:
 * choosing one never debits a wallet, moves money or marks the order paid
 * (CFO decision 2026-10-12). Wallet settlement stays disabled until a
 * separately approved design exists.
 */
export type FoodPaymentMode = 'cash' | 'wallet' | 'mobile_money';

export const FOOD_PAYMENT_MODES: readonly FoodPaymentMode[] = ['cash', 'wallet', 'mobile_money'];

export const FOOD_PAYMENT_MODE_LABEL: Record<FoodPaymentMode, string> = {
  cash: 'Cash',
  wallet: 'Welile wallet',
  mobile_money: 'Mobile money',
};

/** Server-enforced bounds (food_place_order). The server remains authoritative. */
export const FOOD_MAX_QTY_PER_LINE = 20;
export const FOOD_MAX_INSTRUCTIONS = 500;

export interface FoodCoordinatorOverview {
  service_date: string;
  checkout_enabled: boolean;
  /**
   * Whether the kitchen must see payment before preparing. False: payment is
   * made after delivery (CFO decision 2026-10-12). Server-sent, so the UI reads
   * the rule rather than inferring it from the build.
   */
  fulfilment_requires_payment: boolean;
  menu_published: number;
  orders_today: number;
  /** live orders still awaiting payment — a count of orders, not a money figure */
  unpaid_orders: number;
  /** orders handed over (collected or delivered) and not yet paid — a count */
  unpaid_handed_over?: number;
  /** live orders per declared payment mode — counts, not money */
  by_payment_mode?: Partial<Record<FoodPaymentMode, number>>;
  awaiting_prep: number;
  preparing: number;
  ready: number;
  completed: number;
  cancelled: number;
  open_exceptions: number;
  /** sum of paid order totals — an operational figure, NOT recognised revenue */
  paid_order_total_ugx: number;
}

export interface FoodPreparationRow {
  meal_name: string;
  total_quantity: number;
  order_count: number;
}

export type FoodFulfilmentStatus =
  | 'confirmed' | 'preparing' | 'ready' | 'collected' | 'delivered' | 'cancelled';

export type FoodPaymentStatus =
  | 'pending_payment' | 'paid' | 'payment_failed' | 'refund_pending' | 'refunded'
  // a paid order whose ledger legs no longer match, or that was reversed
  // (food_verify_payment, 20261013128000): never treated as paid again
  | 'payment_reversed';

export interface FoodOrder {
  id: string;
  order_reference: string;
  employee_id: string;
  service_date: string;
  period_id: string;
  total_ugx: number;
  payment_status: FoodPaymentStatus;
  /** declared at placement; null only on orders that predate payment modes */
  payment_mode: FoodPaymentMode | null;
  fulfilment_status: FoodFulfilmentStatus;
  /**
   * The ledger transaction group of the order's wallet payment (M1:101).
   * Set only by food_pay_order (20261013128000), in the same database
   * transaction as the verified ledger legs, after the employee confirmed
   * receipt. The fixture's simulated-paid rows carry the SIMULATED_PAYMENT_TXN
   * sentinel so they can never be mistaken for settled orders; that is what
   * isSimulatedPayment() reads.
   */
  transaction_group_id: string | null;
  /** When the ordering employee confirmed receiving the order (payment becomes available). */
  received_at?: string | null;
  /** The Food Coordinator snapshotted at receipt confirmation: the payment's recipient. */
  payee_id?: string | null;
  /** That coordinator's Welile wallet id, recorded at receipt; the payment is routed to it. */
  payee_wallet_id?: string | null;
  /** That coordinator's name at receipt, for display ("You are paying …"). */
  payee_name?: string | null;
  /** Last time the payment was re-checked against the ledger. */
  payment_verified_at?: string | null;
  /** Payment attempt the order is on; above 1 only after an authorised retry. */
  payment_attempt?: number;
  /** Set when the payment was reversed or the payee became ineligible. */
  payment_resolution_required?: boolean;
  payment_resolution_reason?: string | null;
  special_instructions: string | null;
  placed_at: string;
  paid_at: string | null;
}

export interface FoodAuditEntry {
  id: string;
  entity: string;
  entity_id: string | null;
  action: string;
  before_val: unknown;
  after_val: unknown;
  reason: string | null;
  actor_id: string;
  created_at: string;
}

export interface FoodCategory {
  id: string;
  name: string;
  sort_order: number;
  archived_at: string | null;
}

export interface FoodServicePeriod {
  id: string;
  name: string;
  ordering_opens_at: string;
  ordering_closes_at: string;
  collection_instructions: string | null;
  max_qty_per_employee: number | null;
  active: boolean;
}

export interface FoodServiceClosure {
  closure_date: string;
  reason: string;
  created_at: string;
}

export type FoodHandoverMode = 'full_transfer' | 'transfer_with_backup';

/**
 * The only transitions `food_set_fulfilment` accepts. Everything else raises
 * 22023. Mirrors the CASE expression in
 * 20261009130001_food_service_operations_rpcs.sql.
 */
export const FOOD_ALLOWED_TRANSITIONS: Record<FoodFulfilmentStatus, FoodFulfilmentStatus[]> = {
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['collected', 'delivered'],
  collected: [],
  delivered: [],
  cancelled: [],
};

/** What this order can move to next; empty for a terminal order. */
export function nextFoodStatuses(from: FoodFulfilmentStatus): FoodFulfilmentStatus[] {
  return FOOD_ALLOWED_TRANSITIONS[from] ?? [];
}

/**
 * Whether the kitchen may start this order.
 *
 * Payment is made after delivery (CFO decision 2026-10-12), so the default does
 * not require payment, matching `food_set_fulfilment` in Postgres. Starting an
 * order never marks it paid. `requirePayment: true` remains available should a
 * future, separately approved policy reinstate payment-first.
 */
export function canStartPreparing(
  fulfilment: FoodFulfilmentStatus,
  payment: FoodPaymentStatus,
  options: { requirePayment?: boolean } = {},
): boolean {
  const requirePayment = options.requirePayment ?? false;
  if (!nextFoodStatuses(fulfilment).includes('preparing')) return false;
  return requirePayment ? payment === 'paid' : true;
}

export interface FoodMeal {
  id: string;
  name: string;
  description: string | null;
  image_path: string | null;
  category_id: string | null;
  price_ugx: number;
  status: 'draft' | 'published' | 'archived';
  archived_at: string | null;
}

export interface FoodOrderLine {
  id: string;
  order_id: string;
  menu_item_id: string;
  meal_id: string;
  /** snapshot taken when the order was placed; a later menu edit never restates it */
  meal_name: string;
  meal_description: string | null;
  unit_price_ugx: number;
  quantity: number;
  line_total_ugx: number;
}

export interface FoodOrderDetail extends FoodOrder {
  /** present on the coordinator's view; employees only ever see their own */
  employee_name?: string;
  items: FoodOrderLine[];
  cancelled_at?: string | null;
}

export interface FoodOrderEvent {
  id: string;
  order_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  actor_id: string;
  created_at: string;
}

export interface FoodException {
  id: string;
  order_id: string | null;
  kind: string;
  /** the original evidence; never rewritten when the exception is resolved */
  detail: Record<string, unknown>;
  resolved_at: string | null;
  resolved_by: string | null;
  /** mandatory once resolved; null only for rows predating resolution support */
  resolution_reason?: string | null;
  /** who logged it; null only for rows predating food_raise_exception */
  raised_by?: string | null;
  /** 'coordinator' or 'employee' (an employee's report about their own order) */
  raised_via?: 'coordinator' | 'employee' | null;
  created_at: string;
}

/** The nine approved exception kinds, enforced server-side (CHECK + RPC). */
export type FoodExceptionKind =
  | 'MISSING_ITEM' | 'WRONG_ITEM' | 'QUALITY_ISSUE' | 'LATE_DELIVERY' | 'NOT_DELIVERED'
  | 'DAMAGED_ORDER' | 'STOCK_UNAVAILABLE' | 'ORDER_ERROR' | 'OTHER';

export const FOOD_EXCEPTION_KINDS: readonly FoodExceptionKind[] = [
  'MISSING_ITEM', 'WRONG_ITEM', 'QUALITY_ISSUE', 'LATE_DELIVERY', 'NOT_DELIVERED',
  'DAMAGED_ORDER', 'STOCK_UNAVAILABLE', 'ORDER_ERROR', 'OTHER',
];

export const FOOD_EXCEPTION_KIND_LABEL: Record<FoodExceptionKind, string> = {
  MISSING_ITEM: 'Missing item',
  WRONG_ITEM: 'Wrong item',
  QUALITY_ISSUE: 'Quality issue',
  LATE_DELIVERY: 'Late delivery',
  NOT_DELIVERED: 'Not delivered',
  DAMAGED_ORDER: 'Damaged order',
  STOCK_UNAVAILABLE: 'Stock unavailable',
  ORDER_ERROR: 'Order error',
  OTHER: 'Other',
};

/** Server bound on an exception description. */
export const FOOD_MAX_EXCEPTION_NOTE = 500;

export interface FoodCoordinatorAssignment {
  id: string;
  coordinator_id: string;
  coordinator_name?: string;
  access_level: 'active' | 'backup';
  assigned_by: string | null;
  assigned_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  handover_mode: FoodHandoverMode | null;
  reason: string | null;
}

/** Presentation labels. The server never sends these; it sends the raw status. */
export const FOOD_FULFILMENT_LABEL: Record<FoodFulfilmentStatus, string> = {
  confirmed: 'Order received',
  preparing: 'Being prepared',
  ready: 'Ready for collection',
  collected: 'Collected',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export const FOOD_PAYMENT_LABEL: Record<FoodPaymentStatus, string> = {
  pending_payment: 'Not paid yet',
  paid: 'Paid',
  payment_failed: 'Payment failed',
  refund_pending: 'Refund pending',
  refunded: 'Refunded',
  payment_reversed: 'Payment reversed',
};

/** Formats a UGX amount the way the rest of the product does. */
export function formatUgx(amount: number | string | null | undefined): string {
  const n = Number(amount ?? 0);
  return 'UGX ' + (Number.isFinite(n) ? n : 0).toLocaleString('en-UG', {
    maximumFractionDigits: 0,
  });
}

/**
 * Turns a raw Postgres or fixture error into something worth putting in front
 * of a person. The server messages are already written for humans, so this
 * mostly strips the plumbing and special-cases the one error the UI has a
 * considered answer for.
 */
export function foodErrorMessage(e: unknown): string {
  if (!(e instanceof Error)) return 'Something went wrong. Please try again.';
  const raw = e.message ?? '';

  if (isFoodCheckoutDisabled(e)) {
    return 'Paying for meals is not switched on yet. Your order is saved as unpaid.';
  }
  if (/Only the active Food Coordinator/i.test(raw)) {
    return 'Only the active Food Coordinator can do that.';
  }
  if (/Not authorised/i.test(raw)) return 'You do not have access to Food Management.';
  if (/Authentication required/i.test(raw)) return 'Please sign in again.';

  // strip "ERROR: ", SQLSTATE prefixes and any trailing context the driver adds
  const cleaned = raw
    .replace(/^.*?(?:ERROR|error):\s*/i, '')
    .replace(/\s*\(SQLSTATE\s*\w+\)\s*$/i, '')
    .trim();
  return cleaned.length ? cleaned : 'Something went wrong. Please try again.';
}

/** Error marker raised by food_pay_order while payment is switched off. */
export const FOOD_CHECKOUT_DISABLED = 'FOOD_CHECKOUT_DISABLED';

export function isFoodCheckoutDisabled(e: unknown): boolean {
  return e instanceof Error && e.message.includes(FOOD_CHECKOUT_DISABLED);
}

// ─────────── environment and fixture markers (pure; safe in production) ───────────

/** Payment is made after delivery (CFO 2026-10-12): the kitchen never waits for it. */
export const FULFILMENT_REQUIRES_PAYMENT = false;

/**
 * Fixture-only payment evidence. An order carrying this transaction id was
 * NEVER paid: it exists only in the development fixture so the "paid" badge can
 * be seen. Real orders never carry it.
 */
export const SIMULATED_PAYMENT_TXN = '00000000-5111-4000-8000-000000000000';
export const SIMULATED_ORDER_PREFIX = 'FO-SIM-';

/** True when an order's "payment" is fixture evidence rather than a real one. */
export function isSimulatedPayment(o: { order_reference?: string; transaction_group_id?: unknown }) {
  return String(o.order_reference ?? '').startsWith(SIMULATED_ORDER_PREFIX)
    || o.transaction_group_id === SIMULATED_PAYMENT_TXN;
}

/**
 * Whether reads and writes go to the in-memory development fixture instead of
 * the real RPCs. Opt-in, development builds only. Written as literal
 * import.meta.env reads so Vite replaces them at build time: in a production
 * bundle this is the constant false.
 */
export function isFoodMockMode(): boolean {
  return import.meta.env.DEV === true && import.meta.env.VITE_FOOD_SERVICE_MOCK === 'true';
}

const KAMPALA = 'Africa/Kampala';
/** Wall-clock date and time in Africa/Kampala, the canteen's business zone. */
export function foodKampalaNow(): { date: string; time: string } {
  const s = new Date().toLocaleString('en-GB', { timeZone: KAMPALA, hour12: false });
  const [d, t] = s.split(', ');
  const [dd, mm, yyyy] = d.split('/');
  return { date: `${yyyy}-${mm}-${dd}`, time: t };
}
/** Today's business date (Africa/Kampala), as the server computes it. */
export function foodToday(): string { return foodKampalaNow().date; }

// ─────────── all-day ordering ───────────
// The server takes an order while Kampala time is BETWEEN the period's opening
// and closing times (inclusive), and requires closing > opening. So the whole
// day is 00:00:00 – 23:59:59; no schema or RPC change is needed for it.
export const FOOD_ALL_DAY_OPENS = '00:00:00';
export const FOOD_ALL_DAY_CLOSES = '23:59:59';

/** True when a period's window covers the whole day (minute precision). */
export function isFoodAllDayWindow(opensAt: string, closesAt: string): boolean {
  return opensAt.slice(0, 5) === '00:00' && closesAt.slice(0, 5) === '23:59';
}

// ─────────── meal photos (20261013120001) ───────────

/**
 * Storage bucket for meal photos. PRIVATE: photos are shown through short-lived
 * signed URLs, which Storage issues only to the active coordinator and, for a
 * published meal's photo, to canteen users. Upload: active coordinator only.
 */
export const FOOD_MEAL_IMAGE_BUCKET = 'food-meal-images';
/** The only stored value the server accepts for a meal photo (food_meals CHECK). */
export const FOOD_MEAL_IMAGE_NAME = /^meals\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$/;
/** Lifetime of a signed photo URL, and how long before expiry it is replaced. */
export const FOOD_MEAL_PHOTO_URL_TTL_SECONDS = 60 * 60;
export const FOOD_MEAL_PHOTO_URL_REFRESH_MARGIN_MS = 10 * 60 * 1000;
/** The bucket accepts exactly these types, and at most this size. */
export const FOOD_MEAL_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
export const FOOD_MEAL_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Why a file cannot be used as a meal photo, or null when it can. */
export function foodMealImageProblem(file: { type: string; size: number }): string | null {
  if (!FOOD_MEAL_IMAGE_TYPES[file.type]) return 'Use a JPEG, PNG or WebP image.';
  if (file.size > FOOD_MEAL_IMAGE_MAX_BYTES) return 'The photo must be 2 MB or smaller.';
  if (file.size === 0) return 'That file is empty.';
  return null;
}

/** The server-shaped object name for a new upload: meals/<uuid>.<ext>. */
export function foodMealImagePath(type: string, id: string = crypto.randomUUID()): string {
  const ext = FOOD_MEAL_IMAGE_TYPES[type];
  if (!ext) throw new Error('Use a JPEG, PNG or WebP image.');
  return `meals/${id}.${ext}`;
}

/**
 * Checks the file's actual first bytes, not just its declared type: JPEG
 * (FF D8 FF), PNG (89 50 4E 47 0D 0A 1A 0A) or WebP (RIFF....WEBP), and that
 * they match the declared type. Browser-side only: it stops honest mistakes and
 * renamed files, but a determined caller with storage access can bypass it.
 */
export function foodMealImageSignatureType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'image/png';
  if (b.length >= 12 && String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF'
      && String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP') return 'image/webp';
  return null;
}

/** Why the file's content is not the image it claims to be, or null when it is. */
export async function foodMealImageContentProblem(file: Blob & { type: string }): Promise<string | null> {
  const part = file.slice(0, 12);
  const buf: ArrayBuffer = typeof part.arrayBuffer === 'function'
    ? await part.arrayBuffer()
    : await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as ArrayBuffer);
        r.onerror = () => reject(r.error);
        r.readAsArrayBuffer(part);
      });
  const head = new Uint8Array(buf);
  const actual = foodMealImageSignatureType(head);
  if (!actual) return 'That file is not a JPEG, PNG or WebP image.';
  if (actual !== file.type) return 'The file content does not match its image type.';
  return null;
}
