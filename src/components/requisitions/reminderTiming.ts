export const REQUISITION_REMINDER_MS = 4 * 60 * 60 * 1000;

export function reminderDue(lastChecked: number | null, now: number): boolean {
  return lastChecked === null || now - lastChecked >= REQUISITION_REMINDER_MS;
}

export function reminderDelay(serverUntil: unknown, now: number): number {
  const until = new Date(String(serverUntil)).getTime();
  return Number.isFinite(until)
    ? Math.max(REQUISITION_REMINDER_MS, until - now)
    : REQUISITION_REMINDER_MS;
}