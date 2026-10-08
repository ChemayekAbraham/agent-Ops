import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Warns before the SMS provider balance runs out. Run on a schedule (hourly).
// warning  : runway under 48h or balance under 6,000 credits
// critical : runway under 18h or balance under 2,000 credits
// Re-sends only when the level worsens or 6h have passed since the last alert.
const DEFAULT_RECIPIENTS = ["joshwanda17@gmail.com"];
const WARN_HOURS = 48, CRIT_HOURS = 18, WARN_CREDITS = 6000, CRIT_CREDITS = 2000;
const RESEND_AFTER_MS = 6 * 3_600_000;

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const recipients: string[] = Array.isArray(body?.recipients) && body.recipients.length
      ? body.recipients.filter((r: unknown) => typeof r === "string" && (r as string).includes("@"))
      : DEFAULT_RECIPIENTS;

    const { data, error } = await supabase.rpc("get_sms_balance_runway");
    if (error) return json({ error: error.message }, 500);
    const r = (data || {}) as Record<string, any>;
    const balance = r.balance_credits == null ? null : Number(r.balance_credits);
    const burn = Number(r.credits_24h ?? 0);
    const runway = r.runway_hours == null ? null : Number(r.runway_hours);
    if (balance === null) return json({ ok: true, level: "unknown", reason: "no balance in the last 24h of send responses" });

    const level: "critical" | "warning" | "ok" =
      balance < CRIT_CREDITS || (runway !== null && runway < CRIT_HOURS) ? "critical"
        : balance < WARN_CREDITS || (runway !== null && runway < WARN_HOURS) ? "warning" : "ok";
    if (level === "ok") return json({ ok: true, level, balance, runway_hours: runway });

    const { data: last } = await supabase.from("sms_balance_alerts")
      .select("level, created_at").order("created_at", { ascending: false }).limit(1).maybeSingle();
    const worsened = last?.level === "warning" && level === "critical";
    const stale = !last || Date.now() - new Date(last.created_at).getTime() > RESEND_AFTER_MS;
    if (!worsened && !stale) return json({ ok: true, level, suppressed: true, balance, runway_hours: runway });

    const mgKey = Deno.env.get("MAILGUN_API_KEY"), mgDomain = Deno.env.get("MAILGUN_DOMAIN");
    const mgBase = Deno.env.get("MAILGUN_API_BASE") || "https://api.mailgun.net";
    let emailed = false;
    if (mgKey && mgDomain) {
      const runwayText = runway === null ? "unknown" : `${runway} hours`;
      const form = new FormData();
      form.append("from", `Welile Alerts <alerts@${mgDomain}>`);
      for (const to of recipients) form.append("to", to);
      form.append("subject", `${level === "critical" ? "URGENT: " : ""}SMS credit low — about ${runwayText} left`);
      form.append("text",
        `The SMS provider balance is ${balance.toLocaleString("en-US")} credits. ` +
        `The last 24 hours used ${burn.toLocaleString("en-US")} credits, which leaves about ${runwayText}. ` +
        `When the balance reaches zero, customer messages, OTP codes and payment notices are refused. Top up the SMS provider account now.`);
      const res = await fetch(`${mgBase}/v3/${mgDomain}/messages`, {
        method: "POST", headers: { Authorization: `Basic ${btoa(`api:${mgKey}`)}` }, body: form,
      });
      emailed = res.ok;
      if (!res.ok) console.error("[sms-balance-watch] mailgun", res.status, await res.text());
    }
    await supabase.from("sms_balance_alerts").insert({
      level, balance_credits: balance, credits_24h: burn, runway_hours: runway, emailed,
    });
    return json({ ok: true, level, balance, runway_hours: runway, emailed });
  } catch (e) {
    console.error("[sms-balance-watch]", e);
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
