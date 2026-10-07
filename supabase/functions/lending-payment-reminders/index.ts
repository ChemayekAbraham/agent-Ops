// Daily SMS reminders for lending-agent borrowers: the day before and on the
// day a payment is due. Idempotent via lending_payment_reminders (loan, date, kind).
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const kampalaYmd = (offsetDays = 0) =>
  new Date(Date.now() + 3 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
const bare = (p: string) => p.replace(/\D/g, "").replace(/^0/, "256");
const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString("en-US")}`;

async function sendSms(phone: string, message: string): Promise<{ ok: boolean; reason?: string }> {
  const apiKey = Deno.env.get("YOOLA_SMS_API_KEY")?.trim();
  if (!apiKey) return { ok: false, reason: "yoola_not_configured" };
  try {
    const res = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ phone: bare(phone), message, api_key: apiKey, sender: "WELILE" }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({} as any));
    const st = String(data?.status ?? "").toLowerCase();
    if (res.ok && !data?.error && ["", "success", "ok", "sent", "queued"].includes(st)) return { ok: true };
    return { ok: false, reason: `yoola_${res.status}_${st || "rejected"}` };
  } catch (e) {
    return { ok: false, reason: (e as Error)?.name === "TimeoutError" ? "timeout" : "network_error" };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const today = kampalaYmd(0), tomorrow = kampalaYmd(1);
    const { data: loans, error } = await admin.from("lending_agent_loans")
      .select("id, lender_agent_id, borrower_phone, principal_ugx, interest_rate_pct, amount_repaid_ugx, installment_ugx, next_deduction_date, expected_repayment_date, status")
      .in("status", ["active", "partially_repaid"])
      .limit(2000);
    if (error) throw error;

    const due = (loans ?? []).map((l: any) => ({ l, date: l.next_deduction_date || l.expected_repayment_date }))
      .filter((x) => x.l.borrower_phone && (x.date === today || x.date === tomorrow))
      .slice(0, 500);
    const agentIds = [...new Set(due.map((x) => x.l.lender_agent_id))];
    const { data: agents } = agentIds.length
      ? await admin.from("profiles").select("id, full_name").in("id", agentIds)
      : { data: [] as any[] };
    const agentName = new Map((agents ?? []).map((a: any) => [a.id, a.full_name]));

    let sent = 0, skipped = 0, failed = 0;
    for (const { l, date } of due) {
      const p = Number(l.principal_ugx) || 0;
      const owed = Math.max(0, Math.round(p + p * (Number(l.interest_rate_pct) || 0) / 100) - (Number(l.amount_repaid_ugx) || 0));
      if (owed <= 0) continue;
      const amount = Math.min(owed, Math.round(Number(l.installment_ugx) || 0) || owed);
      const kind = date === today ? "due_today" : "day_before";
      // Claim the slot first so a re-run never double-sends.
      const { error: claimErr } = await admin.from("lending_payment_reminders")
        .insert({ loan_id: l.id, due_date: date, kind, phone: l.borrower_phone, amount_ugx: amount });
      if (claimErr) { skipped++; continue; }
      const who = agentName.get(l.lender_agent_id) || "your Welile agent";
      const msg = kind === "due_today"
        ? `Welile: Your payment of ${ugx(amount)} to ${who} is due TODAY. Keep it in your Welile wallet or pay at welileapp.com/repay to stay on time.`
        : `Welile: Reminder - your payment of ${ugx(amount)} to ${who} is due TOMORROW. Keep it in your Welile wallet or pay at welileapp.com/repay.`;
      const r = await sendSms(l.borrower_phone, msg);
      await admin.from("lending_payment_reminders").update({ sent: r.ok, provider_reason: r.reason ?? null })
        .eq("loan_id", l.id).eq("due_date", date).eq("kind", kind);
      if (r.ok) sent++; else failed++;
      await admin.from("system_events").insert({
        event_type: "reminder_sent", user_id: null, related_entity_type: "lending_agent_loan",
        related_entity_id: l.id, metadata: { kind, due_date: date, amount, delivered: r.ok },
      }).then(() => {}, () => {});
    }
    return json({ ok: true, today, candidates: due.length, sent, skipped, failed });
  } catch (e) {
    console.error("[lending-payment-reminders]", e);
    return json({ error: "failed" }, 500);
  }
});
