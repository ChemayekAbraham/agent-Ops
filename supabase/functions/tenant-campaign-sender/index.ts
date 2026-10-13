// Tenant SMS campaign sender.
//  - mode "scheduled" (cron): sends any wave whose time has come, in chunks,
//    re-invoking itself until the wave is done. Switches its schedule off after the last wave.
//  - mode "test" (CRM/CTO): sends the campaign SMS to the campaign's test phones only.
// Campaign messages only — no money, no Rent Plan changes.
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendSMS, formatPhoneInternational, isUgandanPhone } from "../_shared/sendSmsMultiProvider.ts";
import { suppressSignupPrompt } from "../_shared/smsSignupPrompt.ts";

// Recipients are existing tenants: no "sign up" line.
suppressSignupPrompt();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const SLUG = "renewal-survey-oct-2026";
const CRON_JOBS = ["tenant-campaign-renewal-wave1", "tenant-campaign-renewal-waves23"];
const CHUNK = 120;
const CONCURRENCY = 5;
const STAFF = ["crm", "cto", "super_admin"];

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
function firstName(full: string | null): string {
  const f = String(full ?? "").trim().split(/\s+/)[0] ?? "";
  if (!f) return "there";
  return f.charAt(0).toUpperCase() + f.slice(1).toLowerCase();
}
function render(c: any, name: string | null, rent: number | null): string {
  const valid = typeof rent === "number" && Number.isFinite(rent) && rent > 0;
  const tpl: string = valid ? c.message_template : c.fallback_template;
  return tpl
    .replaceAll("{FirstName}", firstName(name))
    .replaceAll("{CurrentRent}", valid ? fmt(rent!) : "")
    .replaceAll("{NewRent}", valid ? fmt(rent! * 2) : "")
    .replaceAll("{shortcode}", c.short_code);
}

async function runPool<T>(items: T[], fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: any = {};
  try { body = await req.json(); } catch { /* cron may send a tiny body */ }
  const mode = body?.mode === "test" ? "test" : "scheduled";

  const { data: c } = await admin.from("tenant_campaigns").select("*").eq("slug", SLUG).maybeSingle();
  if (!c) return json({ error: "Campaign not found" }, 404);

  // ── Test send ─────────────────────────────────────────────────────────────
  if (mode === "test") {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: "Sign in required" }, 401);
    const { data: roles } = await admin.from("user_roles").select("role, enabled").eq("user_id", u.user.id);
    if (!(roles ?? []).some((r: any) => STAFF.includes(r.role) && r.enabled !== false)) {
      return json({ error: "Only CRM, CTO or Super Admin can send tests" }, 403);
    }
    const { data: audience } = await admin.rpc("tenant_campaign_audience");
    const results: any[] = [];
    for (const raw of c.test_phones as string[]) {
      const phone = formatPhoneInternational(raw);
      const digits = phone.replace(/\D/g, "").slice(-9);
      const { data: prof } = await admin.from("profiles").select("id, full_name, phone")
        .ilike("phone", `%${digits}`).limit(1).maybeSingle();
      const aud = (audience ?? []).find((a: any) => a.tenant_id === prof?.id);
      // Test numbers that are not tenants get a sample amount so the full message can be checked.
      const rent = aud?.rent_amount ? Number(aud.rent_amount) : 300000;
      const message = render(c, prof?.full_name ?? "Test", rent);
      const ok = await sendSMS(phone, message, {
        admin, source: "tenant_campaign_test", reference_id: c.id,
        recipient_user_id: prof?.id ?? null, recipient_name: prof?.full_name ?? null,
      });
      await admin.from("tenant_campaign_sends").insert({
        campaign_id: c.id, tenant_id: prof?.id ?? null, recipient_name: prof?.full_name ?? null, phone,
        rent_amount: rent, is_test: true, message, status: ok ? "sent" : "failed",
        error: ok ? null : "Provider did not accept", sent_at: ok ? new Date().toISOString() : null,
      });
      results.push({ phone, ok });
    }
    return json({ ok: true, results });
  }

  // ── Scheduled waves ───────────────────────────────────────────────────────
  if (c.status !== "active") return json({ ok: true, skipped: "campaign not active" });
  const now = new Date().toISOString();
  const { data: waves } = await admin.from("tenant_campaign_waves").select("*")
    .eq("campaign_id", c.id).in("status", ["scheduled", "sending"]).lte("scheduled_at", now).order("wave_no");

  let remaining = 0;
  const report: any[] = [];
  for (const w of waves ?? []) {
    if (w.status === "scheduled") {
      // Build this wave's recipient list once; the unique index stops anyone getting it twice.
      const { data: audience } = await admin.rpc("tenant_campaign_audience");
      const rows = (audience ?? []).filter((a: any) => a.segment === w.segment).map((a: any) => {
        const phone = formatPhoneInternational(a.phone ?? "");
        const okPhone = isUgandanPhone(phone);
        return {
          campaign_id: c.id, wave_id: w.id, tenant_id: a.tenant_id, dedupe_key: a.tenant_id, recipient_name: a.full_name, phone: phone || "unknown",
          segment: a.segment, rent_amount: a.rent_amount, message: render(c, a.full_name, a.rent_amount ? Number(a.rent_amount) : null),
          status: okPhone ? "queued" : "skipped", error: okPhone ? null : "Not a valid Ugandan phone",
        };
      });
      for (let i = 0; i < rows.length; i += 500) {
        await admin.from("tenant_campaign_sends").upsert(rows.slice(i, i + 500), {
          onConflict: "campaign_id,dedupe_key", ignoreDuplicates: true,
        });
      }
      await admin.from("tenant_campaign_waves").update({ status: "sending", started_at: now }).eq("id", w.id).eq("status", "scheduled");
      await admin.from("system_events").insert({ event_type: "tenant_campaign.wave_started", metadata: { wave_id: w.id, segment: w.segment, recipients: rows.length } });
    }

    const { data: batch } = await admin.from("tenant_campaign_sends").select("id, tenant_id, phone, message, recipient_name")
      .eq("wave_id", w.id).eq("status", "queued").limit(CHUNK);
    await runPool(batch ?? [], async (s: any) => {
      const ok = await sendSMS(s.phone, s.message, {
        admin, source: "tenant_campaign", reference_id: w.id,
        recipient_user_id: s.tenant_id, recipient_name: s.recipient_name,
        idempotencyKey: `tenant-campaign:${c.id}:${s.tenant_id}`,
      });
      await admin.from("tenant_campaign_sends").update({
        status: ok ? "sent" : "failed", error: ok ? null : "Provider did not accept",
        sent_at: ok ? new Date().toISOString() : null,
      }).eq("id", s.id);
    });

    const { count: sent } = await admin.from("tenant_campaign_sends").select("id", { count: "exact", head: true }).eq("wave_id", w.id).eq("status", "sent");
    const { count: failed } = await admin.from("tenant_campaign_sends").select("id", { count: "exact", head: true }).eq("wave_id", w.id).eq("status", "failed");
    const { count: queued } = await admin.from("tenant_campaign_sends").select("id", { count: "exact", head: true }).eq("wave_id", w.id).eq("status", "queued");
    const attempted = (sent ?? 0) + (failed ?? 0);
    const { data: fresh } = await admin.from("tenant_campaign_waves").select("status").eq("id", w.id).single();

    if (attempted >= 20 && (failed ?? 0) / attempted > 0.2) {
      await admin.from("tenant_campaign_waves").update({ status: "stopped", note: `Stopped: ${failed} of ${attempted} failed (over 20%)` }).eq("id", w.id);
      await admin.from("system_events").insert({ event_type: "tenant_campaign.wave_stopped", metadata: { wave_id: w.id, sent, failed } });
    } else if ((queued ?? 0) === 0) {
      await admin.from("tenant_campaign_waves").update({ status: "sent", finished_at: new Date().toISOString() }).eq("id", w.id);
      await admin.from("system_events").insert({ event_type: "tenant_campaign.wave_sent", metadata: { wave_id: w.id, segment: w.segment, sent, failed } });
    } else if (fresh?.status === "sending") {
      remaining += queued ?? 0;
    }
    report.push({ wave: w.wave_no, sent, failed, queued });
  }

  // More to send: hand over to a fresh run so no single run times out.
  if (remaining > 0) {
    const next = fetch(`${url}/functions/v1/tenant-campaign-sender`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
      body: JSON.stringify({ mode: "scheduled", continued: true }),
    }).catch(() => null);
    // @ts-ignore EdgeRuntime exists in the Supabase runtime
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(next); else await next;
  }

  // Every wave done: switch the schedule off.
  const { count: open } = await admin.from("tenant_campaign_waves").select("id", { count: "exact", head: true })
    .eq("campaign_id", c.id).in("status", ["scheduled", "sending", "paused"]);
  if ((open ?? 0) === 0) {
    await admin.from("tenant_campaigns").update({ status: "completed" }).eq("id", c.id);
    await admin.rpc("tenant_campaign_unschedule", { p_job_names: CRON_JOBS });
  }
  return json({ ok: true, report, remaining });
});
