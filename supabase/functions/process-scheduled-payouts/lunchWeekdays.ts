// Lunch allowance standing orders pay Monday to Friday only, at 00:00 EAT (21:00 UTC the day before).
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

export function isLunchDaily(p: { category_id?: string; frequency?: string }): boolean {
  return p.category_id === "lunch_allowance" && p.frequency === "daily";
}

/** Day of week (0 Sun .. 6 Sat) in Kampala time. */
export function eatWeekday(t: Date): number {
  return new Date(t.getTime() + EAT_OFFSET_MS).getUTCDay();
}

export function isEatWeekend(t: Date): boolean {
  const d = eatWeekday(t);
  return d === 0 || d === 6;
}

/** The next weekday 00:00 EAT slot strictly after `from`. */
export function nextLunchWeekdaySlot(from: Date): Date {
  const eat = new Date(from.getTime() + EAT_OFFSET_MS);
  let slot = Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate()) - EAT_OFFSET_MS;
  if (slot <= from.getTime()) slot += 86_400_000;
  while (isEatWeekend(new Date(slot))) slot += 86_400_000;
  return new Date(slot);
}
