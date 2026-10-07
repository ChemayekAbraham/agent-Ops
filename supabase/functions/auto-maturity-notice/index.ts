// Daily: emails the partner the "partnership maturity notice" once their active
// portfolio is within 3 months of its maturity date. Each portfolio + maturity
// date is notified once at 3 months and once more under 30 days; each only once (portfolio_maturity_notices), so renewals get a
// fresh notice for their new maturity date and manual sends are not repeated.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function kampalaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala" }).format(new Date());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, key);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* cron */ }
  const dryRun = body.dry_run === true;

  try {
    const today = kampalaToday();
    const horizon = new Date(`${today}T00:00:00Z`);
    horizon.setUTCMonth(horizon.getUTCMonth() + 3);
    const horizonDay = horizon.toISOString().slice(0, 10);

    const { data: portfolios, error } = await admin
      .from("investor_portfolios")
      .select("id, portfolio_code, investment_amount, created_at, maturity_date, display_currency, investor_id, agent_id")
      .eq("status", "active")
      .gte("maturity_date", today)
      .lte("maturity_date", horizonDay);
    if (error) throw new Error(error.message);

    const rows = portfolios ?? [];
    const ids = rows.map((p) => p.id);
    const done = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await admin.from("portfolio_maturity_notices")
        .select("portfolio_id, maturity_date").in("portfolio_id", ids.slice(i, i + 200));
      for (const n of data ?? []) done.add(`${n.portfolio_id}|${n.maturity_date}`);
    }
    // Second notice: once a portfolio is under 30 days from maturity, remind the partner again.
    const d30 = new Date(`${today}T00:00:00Z`);
    d30.setUTCDate(d30.getUTCDate() + 30);
    const day30 = d30.toISOString().slice(0, 10);
    const finalDone = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await admin.from("portfolio_maturity_notices")
        .select("portfolio_id, maturity_date").in("portfolio_id", ids.slice(i, i + 200)).not("final_outcome", "is", null);
      for (const n of data ?? []) finalDone.add(`${n.portfolio_id}|${n.maturity_date}`);
    }
    type Stage = "initial" | "final";
    const stageOf = new Map<string, Stage>();
    const due = rows.filter((p) => {
      const k = `${p.id}|${p.maturity_date}`;
      const within30 = String(p.maturity_date) < day30;
      if (!done.has(k)) { stageOf.set(p.id, "initial"); return true; }
      if (within30 && !finalDone.has(k)) { stageOf.set(p.id, "final"); return true; }
      return false;
    });

    const recipientIds = [...new Set(due.map((p) => p.investor_id || p.agent_id).filter(Boolean))] as string[];
    const profiles = new Map<string, { email: string | null; full_name: string | null }>();
    for (let i = 0; i < recipientIds.length; i += 100) {
      const { data } = await admin.from("profiles").select("id, email, full_name").in("id", recipientIds.slice(i, i + 100));
      for (const p of data ?? []) profiles.set(p.id, p);
    }

    const summary = { today, horizon: horizonDay, dry_run: dryRun, in_window: rows.length, due: due.length, sent: 0, no_email: 0, suppressed: 0, failed: 0 };
    if (dryRun) return json({ ...summary, preview: due.slice(0, 50).map((p) => ({ code: p.portfolio_code, maturity: p.maturity_date })) });

    for (const p of due) {
      const prof = profiles.get((p.investor_id || p.agent_id) as string);
      const email = prof?.email?.trim();
      const stage = stageOf.get(p.id) as Stage;
      const within30 = String(p.maturity_date) < day30;
      const record = async (outcome: string) => {
        if (stage === "initial") {
          const extra = within30 ? { final_outcome: outcome, final_sent_at: new Date().toISOString() } : {};
          return admin.from("portfolio_maturity_notices").upsert(
            { portfolio_id: p.id, maturity_date: p.maturity_date, recipient_email: email ?? null, source: "auto", outcome, ...extra },
            { onConflict: "portfolio_id,maturity_date", ignoreDuplicates: true },
          );
        }
        return admin.from("portfolio_maturity_notices")
          .update({ final_outcome: outcome, final_sent_at: new Date().toISOString() })
          .eq("portfolio_id", p.id).eq("maturity_date", p.maturity_date);
      };
      if (!email) { summary.no_email++; await record("no_email"); continue; }

      const ref = p.portfolio_code || `PF-${String(p.id).replace(/-/g, "").slice(0, 8).toUpperCase()}`;
      const res = await fetch(`${url}/functions/v1/send-transactional-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          templateName: "partnership-maturity-notice",
          recipientEmail: email,
          idempotencyKey: stage === "final" ? `partnership-maturity-notice-30d-${p.id}-${p.maturity_date}` : `partnership-maturity-notice-${p.id}-${p.maturity_date}`,
          templateData: {
            partner_name: prof?.full_name || "Partner",
            partnership_reference: ref,
            portfolio_id: ref,
            partnership_amount: Number(p.investment_amount) || 0,
            start_date: fmtDate(p.created_at),
            maturity_date: fmtDate(p.maturity_date),
            currency: p.display_currency || "UGX",
            company_name: "Welile",
            logo_url: "https://welileapp.com/welile-logo.png",
            dashboard_url: "https://welileapp.com/auth",
            renew_url: `https://welileapp.com/portfolios/${p.id}/renew`,
            redeem_url: `https://welileapp.com/portfolios/${p.id}/redeem`,
            terms_url: "https://welileapp.com/partners-terms",
            privacy_url: "https://welileapp.com/privacy",
          },
        }),
      });
      const txt = await res.text().catch(() => "");
      let parsed: { success?: boolean; reason?: string } | null = null;
      try { parsed = JSON.parse(txt); } catch { /* ignore */ }
      if (res.ok && parsed?.success !== false) { summary.sent++; await record("sent"); }
      else if (res.ok && /suppress/i.test(String(parsed?.reason))) { summary.suppressed++; await record("suppressed"); }
      else { summary.failed++; console.warn("[auto-maturity-notice] failed", p.id, res.status, txt); } // retried tomorrow
      await sleep(150);
    }
    return json(summary);
  } catch (e) {
    console.error("[auto-maturity-notice]", e);
    return json({ error: (e as Error).message }, 500);
  }
});
