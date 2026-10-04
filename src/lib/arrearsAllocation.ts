/**
 * Where an incoming payment lands — the client-side mirror of the server's
 * FIFO allocator (`rent_apply_collections_to_days`).
 *
 * The server is the authority: it writes `rent_day_settlements` and decides
 * what actually settled. This module exists only so the collect dialog can
 * TELL THE AGENT, before they confirm, what their payment is about to do.
 * It never writes anything and never computes what is owed — every figure it
 * consumes comes from `agent_collect_context()`.
 *
 * The rule it mirrors, in the same order the SQL applies it:
 *   1. the oldest unpaid days first, until the money runs out
 *   2. then today's own obligation
 *   3. anything left over waits as unapplied money and pre-pays future days
 *
 * Because both sides read the same totals from the same function, the preview
 * and the outcome agree. No arrears arithmetic is duplicated here: the split is
 * a partition of the amount the agent typed across totals the server supplied.
 */

/** One unpaid day, as returned by `agent_collect_context().behind_days`. */
export interface BehindDay {
  day: string;
  expected: number;
  settled: number;
  remaining: number;
}

/** The payload of `agent_collect_context(p_rent_request_id)`. */
export interface CollectContext {
  rent_request_id: string;
  today: string;
  go_live: string;
  /** Today's scheduled instalment — the only figure the collect screen offers. */
  expected_today: number;
  /** Whole days before today still carrying a balance. */
  days_behind: number;
  /** Total still unpaid on those earlier days. Never includes today. */
  arrears_ugx: number;
  oldest_open_day: string | null;
  /** Today's obligation less whatever has already been settled today. */
  due_today_ugx: number;
  settled_today_ugx: number;
  /** Money already collected that no day has claimed yet — it pre-pays ahead. */
  unapplied_ugx: number;
  behind_days: BehindDay[];
  behind_days_truncated: boolean;
}

export interface PaymentSplit {
  /** Goes to the unpaid earlier days, oldest first. */
  toArrears: number;
  /** Goes to today's obligation, after the earlier days are covered. */
  toToday: number;
  /** Left over — waits as unapplied money and pre-pays future days. */
  toFuture: number;
  /** How many of the behind days this payment closes completely. */
  daysCleared: number;
  /** How many days are behind in total. */
  daysBehind: number;
  /** True when the payment clears every behind day. */
  clearsAllArrears: boolean;
  /** True when the earlier days absorb the whole payment. */
  nothingLandsOnToday: boolean;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Does this plan have anything to explain? Before the arrears go-live floor the
 * server returns zeros for every field here, so this is false everywhere and the
 * dialog stays exactly as it was — no date check needed in the UI.
 */
export function hasArrears(ctx: CollectContext | null | undefined): boolean {
  return num(ctx?.arrears_ugx) > 0 || num(ctx?.days_behind) > 0;
}

/**
 * Everything the tenant owes right now — the unpaid earlier days plus what is
 * still open on today. This, not `expected_today`, is what a payment is judged
 * against.
 *
 * Mirrors `rent_plan_amount_due_now()` on the server, which stamps the same
 * figure onto the receipt as `total_due_amount`. Callers should cap the result
 * at the plan's outstanding balance, which the server also does and which is
 * not carried in this context payload.
 */
export function totalDueNow(ctx: CollectContext | null | undefined): number {
  return num(ctx?.arrears_ugx) + num(ctx?.due_today_ugx);
}

/**
 * How far short of everything owed this payment falls.
 *
 * Measuring against today alone was defect D1: an agent collecting one full
 * day's instalment from a tenant five days behind got a receipt stamped
 * "no shortfall, not partial" while 19,068 was still owed.
 */
export function paymentShortfall(
  ctx: CollectContext | null | undefined,
  amount: number,
  cap?: number,
): number {
  const due = cap === undefined ? totalDueNow(ctx) : Math.min(totalDueNow(ctx), num(cap));
  return Math.max(0, due - num(amount));
}

/** True when the payment does not clear everything owed. See `paymentShortfall`. */
export function isPartialPayment(
  ctx: CollectContext | null | undefined,
  amount: number,
  cap?: number,
): boolean {
  const due = cap === undefined ? totalDueNow(ctx) : Math.min(totalDueNow(ctx), num(cap));
  return due > 0 && num(amount) > 0 && num(amount) < due;
}

/**
 * Split the amount the agent typed the way the server will apply it.
 *
 * `arrears_ugx` and `due_today_ugx` are already net of everything settled, so
 * this is a partition of `amount` — the three parts always sum back to it.
 */
export function splitPayment(
  ctx: CollectContext | null | undefined,
  amount: number,
): PaymentSplit {
  const total = num(amount);
  const arrears = num(ctx?.arrears_ugx);
  const dueToday = num(ctx?.due_today_ugx);
  const daysBehind = Math.trunc(num(ctx?.days_behind));

  const toArrears = Math.min(total, arrears);
  const toToday = Math.min(total - toArrears, dueToday);
  const toFuture = total - toArrears - toToday;

  // Walk the itemised days in the same order the SQL does, to say how many the
  // payment actually closes. The list is capped for display, so a payment that
  // covers everything itemised is reported against the true day count instead.
  let left = toArrears;
  let daysCleared = 0;
  for (const d of ctx?.behind_days ?? []) {
    const need = num(d.remaining);
    if (need <= 0) continue;
    if (left >= need) {
      left -= need;
      daysCleared += 1;
    } else {
      break;
    }
  }
  const clearsAllArrears = arrears > 0 && toArrears >= arrears;
  if (clearsAllArrears) daysCleared = daysBehind;

  return {
    toArrears,
    toToday,
    toFuture,
    daysCleared,
    daysBehind,
    clearsAllArrears,
    nothingLandsOnToday: toArrears > 0 && toToday <= 0,
  };
}

/**
 * The one-line summary of how far behind this tenant is, or null when they are
 * not. Copy lives here rather than in the component so the wording stays
 * consistent wherever it is shown.
 */
export function arrearsHeadline(
  ctx: CollectContext | null | undefined,
  formatAmount: (n: number) => string,
): string | null {
  if (!hasArrears(ctx)) return null;
  const days = Math.trunc(num(ctx?.days_behind));
  const amount = formatAmount(num(ctx?.arrears_ugx));
  return `Behind ${days} ${days === 1 ? 'day' : 'days'} · ${amount} unpaid`;
}

/**
 * Plain-English explanation of what this specific payment will do, for the
 * confirmation step. Returns null when there are no arrears to explain.
 */
export function splitExplanation(
  ctx: CollectContext | null | undefined,
  amount: number,
  formatAmount: (n: number) => string,
): string | null {
  if (!hasArrears(ctx)) return null;
  const split = splitPayment(ctx, amount);
  if (split.toArrears <= 0) return null;

  const parts: string[] = [
    `${formatAmount(split.toArrears)} of this payment goes to the older unpaid days first.`,
  ];
  if (split.toToday > 0) {
    parts.push(`${formatAmount(split.toToday)} then covers today.`);
  } else {
    parts.push('Nothing is left for today, so today stays open.');
  }
  if (split.toFuture > 0) {
    parts.push(`${formatAmount(split.toFuture)} goes ahead onto the coming days.`);
  }
  return parts.join(' ');
}
