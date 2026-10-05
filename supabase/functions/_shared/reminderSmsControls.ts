// Config-driven controls for templated reminder SMS to our own tenants and
// agents (Benjamin's standing reminder clear, 2026-09-28).
//
// Every value lives in public.system_config (key text, value jsonb) and is
// changed with a one-row UPDATE, no deploy:
//
//   reminder_sms_enabled                 true  Kill switch. Sends happen ONLY
//                                              when this is JSON true. Missing
//                                              row / unreadable = OFF. Re-read
//                                              at most every KILL_SWITCH_TTL_MS
//                                              and always before the next send,
//                                              so flipping it to false stops a
//                                              run that is already going.
//   reminder_sms_max_per_tenant_per_day  1     Reminder SMS one tenant may get
//                                              per Kampala day, counted across
//                                              TENANT_REMINDER_SOURCES in
//                                              sms_delivery_log (sent/queued).
//   reminder_sms_max_per_run             400   Reminder SMS (tenant + agent)
//                                              one function run may attempt.
//                                              Queues are sorted largest
//                                              arrears first, so the cap drops
//                                              the smallest balances.
//
// Scope: tenant-arrears-escalations (tenant SMS + agent SMS) and
// tenant-payment-notices mode=missed (PAYMENT_MISSED). It does NOT touch
// sendSMS itself, OTPs, receipts or any other SMS path.

/** sms_delivery_log.source values that count toward the per-tenant daily cap. */
export const TENANT_REMINDER_SOURCES = [
  "tenant_arrears_reminder",
  "tenant_notify:PAYMENT_MISSED",
] as const;

export const REMINDER_CONFIG_KEYS = {
  enabled: "reminder_sms_enabled",
  perTenantPerDay: "reminder_sms_max_per_tenant_per_day",
  perRun: "reminder_sms_max_per_run",
} as const;

/** Used only when the numeric rows are missing; the kill switch has no default-on. */
export const DEFAULT_MAX_PER_TENANT_PER_DAY = 1;
export const DEFAULT_MAX_PER_RUN = 400;
const KILL_SWITCH_TTL_MS = 5_000;

/**
 * Reminder copy must stay a plain debt reminder: no promo, no sign-up pitch,
 * no "repay up to 70%" / top-up / rent-access upsell. Checked on the rendered
 * text before any send; a hit aborts that send (and the run, for templates).
 */
const BANNED_REMINDER_COPY =
  /(\b70\s*%|seventy\s+per\s*cent|repay\s+up\s+to|top[\s-]?up|qualif(y|ied)\s+for|rent\s+access\s+(of|up)|sign\s*-?\s*up|not\s+on\s+welile|welileapp\.com\/wjoin|become\s+a\s+welile\s+agent|promo(tion)?\b|discount)/i;

export function reminderCopyViolation(message: string): string | null {
  const m = String(message ?? "").match(BANNED_REMINDER_COPY);
  return m ? m[0] : null;
}

function kampalaMidnightUtcIso(now = new Date()): string {
  // Kampala is UTC+3 with no DST.
  const shifted = new Date(now.getTime() + 3 * 3600_000);
  const day = shifted.toISOString().slice(0, 10);
  return new Date(`${day}T00:00:00+03:00`).toISOString();
}

function asPositiveInt(v: unknown, fallback: number): number {
  const n = Number(typeof v === "string" ? v : (v as number));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export interface ReminderControlsSnapshot {
  enabled: boolean;
  max_per_tenant_per_day: number;
  max_per_run: number;
  config_rows_found: string[];
}

export type ReminderDecision =
  | { ok: true }
  | { ok: false; stopRun: boolean; reason: "reminder_sms_disabled" | "run_cap_reached" | "tenant_daily_cap_reached" | "cap_check_failed" };

export class ReminderSmsGuard {
  private enabled = false;
  private checkedAt = 0;
  private attempts = 0;
  snapshot: ReminderControlsSnapshot = {
    enabled: false,
    max_per_tenant_per_day: DEFAULT_MAX_PER_TENANT_PER_DAY,
    max_per_run: DEFAULT_MAX_PER_RUN,
    config_rows_found: [],
  };

  /**
   * enforceKillSwitch=false is for dry runs only: they send nothing, so they
   * may preview what WOULD go out while the switch is still off.
   */
  constructor(private admin: any, private opts: { enforceKillSwitch?: boolean } = {}) {}

  /** Loads all three keys. Call once at the start of a run. */
  async load(): Promise<ReminderControlsSnapshot> {
    const keys = Object.values(REMINDER_CONFIG_KEYS);
    const { data, error } = await this.admin
      .from("system_config")
      .select("key, value")
      .in("key", keys);
    const rows = new Map<string, unknown>();
    if (!error) for (const r of data ?? []) rows.set(r.key as string, r.value);
    this.enabled = rows.get(REMINDER_CONFIG_KEYS.enabled) === true;
    this.checkedAt = Date.now();
    this.snapshot = {
      enabled: this.enabled,
      max_per_tenant_per_day: asPositiveInt(rows.get(REMINDER_CONFIG_KEYS.perTenantPerDay), DEFAULT_MAX_PER_TENANT_PER_DAY),
      max_per_run: asPositiveInt(rows.get(REMINDER_CONFIG_KEYS.perRun), DEFAULT_MAX_PER_RUN),
      config_rows_found: [...rows.keys()],
    };
    return this.snapshot;
  }

  /** Re-reads only the kill switch, at most every KILL_SWITCH_TTL_MS. */
  private async refreshKillSwitch(): Promise<boolean> {
    if (Date.now() - this.checkedAt < KILL_SWITCH_TTL_MS) return this.enabled;
    const { data, error } = await this.admin
      .from("system_config")
      .select("value")
      .eq("key", REMINDER_CONFIG_KEYS.enabled)
      .maybeSingle();
    // Fail closed: an unreadable kill switch means stop.
    this.enabled = !error && data?.value === true;
    this.checkedAt = Date.now();
    this.snapshot.enabled = this.enabled;
    return this.enabled;
  }

  /**
   * Call immediately before each reminder SMS. `tenantId` is set for tenant
   * reminders (applies the per-tenant daily cap); omit it for agent SMS.
   * On ok:true the attempt is counted against the run cap.
   */
  async beforeSend(tenantId?: string | null): Promise<ReminderDecision> {
    const enforce = this.opts.enforceKillSwitch !== false;
    if (enforce && !(await this.refreshKillSwitch())) return { ok: false, stopRun: true, reason: "reminder_sms_disabled" };
    // Reserve the slot synchronously so concurrent workers cannot overshoot.
    if (this.attempts >= this.snapshot.max_per_run) return { ok: false, stopRun: true, reason: "run_cap_reached" };
    this.attempts++;
    if (tenantId) {
      const { count, error } = await this.admin
        .from("sms_delivery_log")
        .select("id", { count: "exact", head: true })
        .eq("recipient_user_id", tenantId)
        .in("source", TENANT_REMINDER_SOURCES as unknown as string[])
        .in("status", ["sent", "queued"])
        .gte("created_at", kampalaMidnightUtcIso());
      // Fail closed on the cap too: never risk a second reminder the same day.
      if (error) { this.attempts--; return { ok: false, stopRun: false, reason: "cap_check_failed" }; }
      if ((count ?? 0) >= this.snapshot.max_per_tenant_per_day) {
        this.attempts--;
        return { ok: false, stopRun: false, reason: "tenant_daily_cap_reached" };
      }
    }
    return { ok: true };
  }

  get attemptsThisRun(): number {
    return this.attempts;
  }
}
