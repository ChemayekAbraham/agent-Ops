// deno test supabase/functions/_shared/reminderSmsControls_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ReminderSmsGuard, reminderCopyViolation } from "./reminderSmsControls.ts";

/** Minimal stand-in for the supabase client: system_config rows + a sent-count per tenant. */
function fakeAdmin(config: Record<string, unknown>, sentToday: Record<string, number> = {}) {
  return {
    config,
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const q: any = {
        select: () => q,
        in: (col: string, vals: unknown[]) => { filters[`in:${col}`] = vals; return q; },
        eq: (col: string, v: unknown) => { filters[col] = v; return q; },
        gte: () => q,
        maybeSingle: async () => ({ data: key(filters.key as string), error: null }),
        then: (res: (v: unknown) => void) => {
          if (table === "system_config") {
            const keys = filters["in:key"] as string[];
            res({ data: keys.filter((k) => k in config).map((k) => ({ key: k, value: config[k] })), error: null });
          } else {
            res({ count: sentToday[filters.recipient_user_id as string] ?? 0, error: null });
          }
        },
      };
      const key = (k: string) => (k in config ? { value: config[k] } : null);
      return q;
    },
  };
}

Deno.test("copy guard blocks promo / top-up / 70% and passes the real templates", () => {
  assertEquals(reminderCopyViolation("Repay up to 70% and get a top-up"), "Repay up to");
  assertEquals(reminderCopyViolation("Not on Welile yet? Sign up: welileapp.com/wjoin") !== null, true);
  assertEquals(reminderCopyViolation("Welile: Your Rent Plan is behind by UGX 12,000 (1 day). Please pay today from your Welile wallet or through your agent. Staying behind lowers your Welile Trust Score and your future rent limit."), null);
  assertEquals(reminderCopyViolation("Welile: Today's UGX 5,000 rent payment was not received. It remains due and carries forward. Pay directly via MTN 090777 or Airtel 4380664."), null);
});

Deno.test("missing kill switch row = OFF", async () => {
  const g = new ReminderSmsGuard(fakeAdmin({}));
  const snap = await g.load();
  assertEquals(snap.enabled, false);
  assertEquals((await g.beforeSend("t1")).ok, false);
});

Deno.test("dry run may preview while the switch is off", async () => {
  const g = new ReminderSmsGuard(fakeAdmin({}), { enforceKillSwitch: false });
  await g.load();
  assertEquals((await g.beforeSend("t1")).ok, true);
});

Deno.test("per-tenant daily cap and per-run cap", async () => {
  const admin = fakeAdmin(
    { reminder_sms_enabled: true, reminder_sms_max_per_tenant_per_day: 1, reminder_sms_max_per_run: 2 },
    { already: 1 },
  );
  const g = new ReminderSmsGuard(admin);
  await g.load();
  const capped = await g.beforeSend("already");
  assertEquals(capped.ok ? "" : capped.reason, "tenant_daily_cap_reached");
  assertEquals((await g.beforeSend("a")).ok, true);
  assertEquals((await g.beforeSend(null)).ok, true); // agent SMS counts toward run cap
  const d = await g.beforeSend("b");
  assertEquals(d.ok ? "" : d.reason, "run_cap_reached");
});

Deno.test("flipping the kill switch stops a run in progress", async () => {
  const admin = fakeAdmin({ reminder_sms_enabled: true });
  const g = new ReminderSmsGuard(admin);
  await g.load();
  assertEquals((await g.beforeSend("a")).ok, true);
  admin.config.reminder_sms_enabled = false;
  (g as any).checkedAt = 0; // skip the 5s cache
  const d = await g.beforeSend("b");
  assertEquals(d.ok ? "" : d.reason, "reminder_sms_disabled");
});
