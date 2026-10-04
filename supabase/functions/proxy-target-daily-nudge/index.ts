import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const APP_URL = "https://welileapp.com/agent/proxy-agents";
const TEMPLATE = "proxy-daily-nudge";

/** Kampala-local date (YYYY-MM-DD) and hour. */
function kampala(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

function slotFor(hour: number): { slot: string; label: string } {
  if (hour < 11) return { slot: "morning", label: "Morning" };
  if (hour < 14) return { slot: "midday", label: "Midday" };
  return { slot: "afternoon", label: "Afternoon" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* cron may send no body */ }

  const k = kampala();
  const requested = typeof body.slot === "string" ? body.slot : null;
  const { slot, label } = requested
    ? { slot: requested, label: requested.charAt(0).toUpperCase() + requested.slice(1) }
    : slotFor(k.hour);
  const monthStart = `${k.date.slice(0, 7)}-01`;

  const summary = { slot, date: k.date, agents: 0, sent: 0, skipped: 0, errors: [] as string[] };

  try {
    // 1. Accepted Target Mode agents only.
    const { data: enrolled, error: enrErr } = await admin
      .from("proxy_target_mode_enrollments")
      .select("agent_id, monthly_note_target")
      .eq("status", "accepted");
    if (enrErr) throw new Error(enrErr.message);

    const agentIds = (enrolled ?? []).map((r) => r.agent_id as string);
    summary.agents = agentIds.length;
    if (!agentIds.length) {
      return new Response(JSON.stringify({ success: true, ...summary }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Contact details.
    const { data: profiles } = await admin
      .from("profiles").select("id, full_name, email").in("id", agentIds);
    const profileById = new Map((profiles ?? []).map((p) => [p.id as string, p]));

    // 3. This month's notes in one pass (no per-agent fan-out).
    const monthCounts = new Map<string, number>();
    const todayCounts = new Map<string, number>();
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data: notes, error: nErr } = await admin
        .from("promissory_notes")
        .select("agent_id, created_at")
        .in("agent_id", agentIds)
        .gte("created_at", `${monthStart}T00:00:00+03:00`)
        .range(from, from + pageSize - 1);
      if (nErr) throw new Error(nErr.message);
      for (const n of notes ?? []) {
        const id = n.agent_id as string;
        monthCounts.set(id, (monthCounts.get(id) ?? 0) + 1);
        const localDate = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date(n.created_at as string));
        if (localDate === k.date) todayCounts.set(id, (todayCounts.get(id) ?? 0) + 1);
      }
      if (!notes || notes.length < pageSize) break;
    }

    // 4. Send, capped concurrency, idempotent per agent/day/slot.
    const queue = [...agentIds];
    const worker = async () => {
      while (queue.length) {
        const agentId = queue.shift()!;
        const profile = profileById.get(agentId);
        const email = (profile?.email as string | null) ?? null;
        if (!email) { summary.skipped++; continue; }

        // Live figures (available income curve lives in the DB function).
        let target = Number((enrolled ?? []).find((e) => e.agent_id === agentId)?.monthly_note_target ?? 1200);
        let available = 0;
        let dailyMin = 10;
        const { data: mode } = await admin.rpc("get_proxy_target_mode", { p_agent_id: agentId });
        if (mode && typeof mode === "object") {
          const m = mode as Record<string, number>;
          target = Number(m.monthly_note_target ?? target);
          available = Number(m.available_income ?? 0);
          dailyMin = Number(m.daily_min ?? 10);
        }

        const { error } = await admin.functions.invoke("send-transactional-email", {
          body: {
            templateName: TEMPLATE,
            recipientEmail: email,
            idempotencyKey: `proxy-nudge-${agentId}-${k.date}-${slot}`,
            templateData: {
              recipient_name: (profile?.full_name as string) || "there",
              slot_label: label,
              notes_today: todayCounts.get(agentId) ?? 0,
              notes_month: monthCounts.get(agentId) ?? 0,
              daily_min: dailyMin,
              monthly_note_target: target,
              available_income: available,
              app_url: APP_URL,
            },
          },
        });
        if (error) summary.errors.push(`${agentId}: ${error.message}`);
        else summary.sent++;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    return new Response(JSON.stringify({ success: true, ...summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false, error: e instanceof Error ? e.message : String(e), ...summary }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
