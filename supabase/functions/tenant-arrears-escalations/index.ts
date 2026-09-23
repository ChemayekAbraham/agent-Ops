// Daily arrears chase for Rent Plans, in three steps:
//
//   1. TENANT SMS  - the morning after a daily amount is missed, then every
//      third day while the plan stays behind (days behind 1, 4, 7, 10 ...).
//      One message per tenant per day, covering every plan they hold.
//   2. AGENT ESCALATION (day 3) - the collecting agent is texted and an
//      agent task is raised, then repeated every third day (3, 6, 9 ...).
//   3. CALL TASK (day 7) - the plan's tenant is pushed into the open calling
//      centre tenant cycle as a to_call row, priority = arrears amount.
//
// Authoritative arrears source is v_rent_plan_arrears (Kampala-day pinned,
// clamped at the plan's real outstanding). Plans with an active repayment
// pause are skipped. Nothing about wallets, plans, repayments or collections
// is written - this function only sends reminders and raises follow-up rows,
// and records each one in tenant_arrears_escalations for audit.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSMS, isUgandanPhone } from "../_shared/sendSmsMultiProvider.ts";
import { suppressSignupPrompt } from "../_shared/smsSignupPrompt.ts";

suppressSignupPrompt();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** Agent escalation threshold, in days behind. */
const AGENT_DAY = 3;
/** Calling centre threshold, in days behind. */
const CALL_TASK_DAY = 7;
/** Repeat cadence for both the tenant reminder and the agent escalation. */
const CADENCE = 3;
/** Most call tasks raised in one run, largest arrears first. */
const CALL_TASK_CAP = 60;
const CONCURRENCY = 5;

interface ArrearsRow {
  rent_request_id: string;
  tenant_id: string | null;
  agent_id: string | null;
  days_behind: number;
  arrears_ugx: number;
}

function kampalaDate(now = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString("en-US")}`;

function tenantMessage(rows: ArrearsRow[]): string {
  const total = rows.reduce((s, r) => s + Number(r.arrears_ugx || 0), 0);
  const worst = Math.max(...rows.map((r) => Number(r.days_behind || 0)));
  const plans = rows.length > 1 ? `${rows.length} Rent Plans are` : "Your Rent Plan is";
  return `Welile: ${plans} behind by ${ugx(total)} (${worst} day${worst === 1 ? "" : "s"}). ` +
    `Please pay today from your Welile wallet or through your agent. ` +
    `Staying behind lowers your Welile Trust Score and your future rent limit.`;
}

function agentMessage(rows: ArrearsRow[], nameOf: (id: string | null) => string): string {
  const total = rows.reduce((s, r) => s + Number(r.arrears_ugx || 0), 0);
  const worst = rows.reduce((a, b) => (Number(a.days_behind) >= Number(b.days_behind) ? a : b));
  if (rows.length === 1) {
    return `Welile: ${nameOf(worst.tenant_id)} is ${worst.days_behind} days behind on their Rent Plan, ` +
      `${ugx(total)} outstanding. Please collect today and record the payment.`;
  }
  return `Welile: ${rows.length} of your tenants are 3+ days behind, ${ugx(total)} outstanding. ` +
    `Worst is ${nameOf(worst.tenant_id)} at ${worst.days_behind} days. Please collect and record today.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* cron sends no body */ }
  const dryRun = body.dry_run === true;

  const runDate = kampalaDate();
  const summary = {
    date: runDate, dry_run: dryRun,
    plans_behind: 0, plans_paused_skipped: 0,
    tenants_texted: 0, tenants_skipped_no_phone: 0,
    agents_escalated: 0, agents_skipped_no_phone: 0, agent_tasks_raised: 0,
    call_tasks_raised: 0, call_tasks_already_queued: 0,
    errors: [] as string[],
    preview: [] as { kind: string; to: string; message: string }[],
  };

  try {
    const { data: rawArrears, error: arrErr } = await admin
      .from("v_rent_plan_arrears")
      .select("rent_request_id, tenant_id, agent_id, days_behind, arrears_ugx")
      .gte("days_behind", 1)
      .gt("arrears_ugx", 0);
    if (arrErr) throw new Error(arrErr.message);

    let rows = (rawArrears ?? []) as ArrearsRow[];
    summary.plans_behind = rows.length;
    if (!rows.length) {
      return new Response(JSON.stringify({ success: true, ...summary }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Skip plans whose repayment is deliberately paused.
    const { data: pauses } = await admin
      .from("rent_repayment_pauses")
      .select("rent_request_id, status, resume_on")
      .eq("status", "active")
      .in("rent_request_id", rows.map((r) => r.rent_request_id));
    const paused = new Set(
      (pauses ?? [])
        .filter((p) => !p.resume_on || String(p.resume_on) >= runDate)
        .map((p) => p.rent_request_id as string),
    );
    if (paused.size) {
      const before = rows.length;
      rows = rows.filter((r) => !paused.has(r.rent_request_id));
      summary.plans_paused_skipped = before - rows.length;
    }

    // Phones and names for everyone involved. Chunked small: a long `in` list
    // travels in the query string, and one oversized batch failing would leave
    // every recipient looking phoneless and silently skipped.
    const peopleIds = [...new Set(rows.flatMap((r) => [r.tenant_id, r.agent_id]).filter(Boolean))] as string[];
    const person = new Map<string, { name: string | null; phone: string | null }>();
    for (let i = 0; i < peopleIds.length; i += 100) {
      const { data: profiles, error: profErr } = await admin
        .from("profiles")
        .select("id, full_name, phone")
        .in("id", peopleIds.slice(i, i + 100));
      if (profErr) summary.errors.push(`profiles ${i}: ${profErr.message}`);
      for (const p of profiles ?? []) {
        person.set(p.id as string, { name: p.full_name, phone: p.phone });
      }
    }
    if (person.size === 0 && peopleIds.length > 0) {
      throw new Error("contact lookup returned nothing - aborting before any send");
    }
    const nameOf = (id: string | null) => (id ? person.get(id)?.name ?? "A tenant" : "A tenant");

    /** Records the escalation; a duplicate dedupe_key means it already fired. */
    const record = async (row: Record<string, unknown>) => {
      const { data, error } = await admin
        .from("tenant_arrears_escalations")
        .insert({ run_date: runDate, ...row })
        .select("id")
        .maybeSingle();
      if (error) {
        if ((error as { code?: string }).code === "23505") return null; // already done
        summary.errors.push(`record: ${error.message}`);
        return null;
      }
      return data?.id as string | undefined ?? null;
    };

    const markSent = async (id: string | null, ok: boolean, err: string | null) => {
      if (!id) return;
      await admin.from("tenant_arrears_escalations").update({
        sms_status: ok ? "sent" : "failed",
        sent_at: ok ? new Date().toISOString() : null,
        last_error: err,
      }).eq("id", id);
    };

    // ---------- 1. Tenant reminders ----------
    const byTenant = new Map<string, ArrearsRow[]>();
    for (const r of rows) {
      if (!r.tenant_id) continue;
      const list = byTenant.get(r.tenant_id) ?? [];
      list.push(r);
      byTenant.set(r.tenant_id, list);
    }
    const tenantQueue = [...byTenant.entries()].filter(([, list]) => {
      const worst = Math.max(...list.map((r) => Number(r.days_behind || 0)));
      return worst % CADENCE === 1; // days 1, 4, 7, 10 ...
    });

    const tenantWorker = async () => {
      while (tenantQueue.length) {
        const [tenantId, list] = tenantQueue.shift()!;
        const phone = person.get(tenantId)?.phone ?? null;
        const message = tenantMessage(list);
        if (!phone || !isUgandanPhone(phone)) { summary.tenants_skipped_no_phone++; continue; }
        if (dryRun) {
          summary.preview.push({ kind: "tenant", to: nameOf(tenantId), message });
          summary.tenants_texted++;
          continue;
        }
        const id = await record({
          stage: "tenant_sms",
          dedupe_key: `arrears-tenant-${tenantId}-${runDate}`,
          tenant_id: tenantId,
          agent_id: list[0].agent_id,
          rent_request_id: list.length === 1 ? list[0].rent_request_id : null,
          days_behind: Math.max(...list.map((r) => Number(r.days_behind || 0))),
          arrears_ugx: list.reduce((s, r) => s + Number(r.arrears_ugx || 0), 0),
          plans_count: list.length,
          recipient_role: "tenant",
          recipient_user_id: tenantId,
          phone, sms_text: message,
        });
        if (!id) continue; // already reminded today
        let ok = false; let err: string | null = null;
        try {
          ok = await sendSMS(phone, message, {
            admin,
            source: "tenant_arrears_reminder",
            recipient_user_id: tenantId,
            recipient_name: nameOf(tenantId),
            idempotencyKey: `arrears-tenant-${tenantId}-${runDate}`,
          });
        } catch (e) { err = e instanceof Error ? e.message : "send failed"; }
        await markSent(id, ok, ok ? null : err ?? "provider_rejected");
        if (ok) summary.tenants_texted++;
        else summary.errors.push(`tenant ${tenantId}: ${err ?? "send returned false"}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tenantQueue.length) }, tenantWorker));

    // ---------- 2. Agent escalation on day 3 ----------
    const byAgent = new Map<string, ArrearsRow[]>();
    for (const r of rows) {
      if (!r.agent_id) continue;
      if (Number(r.days_behind || 0) < AGENT_DAY) continue;
      const list = byAgent.get(r.agent_id) ?? [];
      list.push(r);
      byAgent.set(r.agent_id, list);
    }
    const agentQueue = [...byAgent.entries()].filter(([, list]) => {
      const worst = Math.max(...list.map((r) => Number(r.days_behind || 0)));
      return worst % CADENCE === 0; // days 3, 6, 9 ...
    });

    const agentWorker = async () => {
      while (agentQueue.length) {
        const [agentId, list] = agentQueue.shift()!;
        const phone = person.get(agentId)?.phone ?? null;
        const message = agentMessage(list, nameOf);
        const total = list.reduce((s, r) => s + Number(r.arrears_ugx || 0), 0);
        const worst = Math.max(...list.map((r) => Number(r.days_behind || 0)));
        if (dryRun) {
          summary.preview.push({ kind: "agent", to: nameOf(agentId), message });
          summary.agents_escalated++;
          continue;
        }
        const id = await record({
          stage: "agent_escalation",
          dedupe_key: `arrears-agent-${agentId}-${runDate}`,
          agent_id: agentId,
          tenant_id: list.length === 1 ? list[0].tenant_id : null,
          rent_request_id: list.length === 1 ? list[0].rent_request_id : null,
          days_behind: worst,
          arrears_ugx: total,
          plans_count: list.length,
          recipient_role: "agent",
          recipient_user_id: agentId,
          phone, sms_text: message,
        });
        if (!id) continue; // already escalated today

        // Follow-up task so the chase is trackable, not just a text.
        const { data: task, error: taskErr } = await admin.from("agent_tasks").insert({
          agent_id: agentId,
          task_type: "arrears_followup",
          title: `Collect arrears from ${list.length} tenant${list.length === 1 ? "" : "s"} (${ugx(total)})`,
          description: `${list.length} Rent Plan${list.length === 1 ? "" : "s"} ${worst} day(s) behind, ${ugx(total)} outstanding as at ${runDate}. Collect and record the payment today.`,
          priority: worst >= CALL_TASK_DAY ? "high" : "medium",
          status: "pending",
          due_date: runDate,
          tenant_id: list.length === 1 ? list[0].tenant_id : null,
          rent_request_id: list.length === 1 ? list[0].rent_request_id : null,
        }).select("id").maybeSingle();
        if (taskErr) summary.errors.push(`agent task ${agentId}: ${taskErr.message}`);
        else if (task?.id) {
          summary.agent_tasks_raised++;
          await admin.from("tenant_arrears_escalations").update({ agent_task_id: task.id }).eq("id", id);
        }

        if (!phone || !isUgandanPhone(phone)) {
          summary.agents_skipped_no_phone++;
          await markSent(id, false, "no_valid_phone");
          continue;
        }
        let ok = false; let err: string | null = null;
        try {
          ok = await sendSMS(phone, message, {
            admin,
            source: "tenant_arrears_agent_escalation",
            recipient_user_id: agentId,
            recipient_name: nameOf(agentId),
            idempotencyKey: `arrears-agent-${agentId}-${runDate}`,
          });
        } catch (e) { err = e instanceof Error ? e.message : "send failed"; }
        await markSent(id, ok, ok ? null : err ?? "provider_rejected");
        if (ok) summary.agents_escalated++;
        else summary.errors.push(`agent ${agentId}: ${err ?? "send returned false"}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, agentQueue.length) }, agentWorker));

    // ---------- 3. Calling centre task on day 7 ----------
    const callRows = rows.filter((r) => Number(r.days_behind || 0) >= CALL_TASK_DAY && r.tenant_id);
    if (callRows.length) {
      const { data: cycle } = await admin
        .from("cc_call_cycles")
        .select("id")
        .eq("subject_type", "tenant")
        .is("closed_at", null)
        .order("cycle_no", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!cycle?.id) {
        summary.errors.push("no open tenant calling cycle - call tasks not raised");
      } else {
        // Worst plan per tenant; the queue calls the person, not the plan.
        const worstByTenant = new Map<string, ArrearsRow>();
        for (const r of callRows) {
          const cur = worstByTenant.get(r.tenant_id!);
          if (!cur || Number(r.days_behind) > Number(cur.days_behind)) worstByTenant.set(r.tenant_id!, r);
        }
        // Largest arrears first, capped per run so the calling queue gets a
        // workable list instead of a few hundred rows in one morning.
        const callTargets = [...worstByTenant.entries()]
          .sort((a, b) => Number(b[1].arrears_ugx || 0) - Number(a[1].arrears_ugx || 0))
          .slice(0, CALL_TASK_CAP);
        for (const [tenantId, r] of callTargets) {
          if (dryRun) {
            summary.preview.push({ kind: "call_task", to: nameOf(tenantId), message: `${r.days_behind} days behind, ${ugx(Number(r.arrears_ugx))}` });
            summary.call_tasks_raised++;
            continue;
          }
          const { data: row, error: rowErr } = await admin.from("cc_cycle_rows").insert({
            cycle_id: cycle.id,
            subject_type: "tenant",
            subject_id: tenantId,
            state: "to_call",
            priority_value: Number(r.arrears_ugx || 0),
          }).select("id").maybeSingle();
          if (rowErr) {
            if ((rowErr as { code?: string }).code === "23505") summary.call_tasks_already_queued++;
            else summary.errors.push(`call task ${tenantId}: ${rowErr.message}`);
            continue;
          }
          summary.call_tasks_raised++;
          await record({
            stage: "call_task",
            dedupe_key: `arrears-call-${tenantId}-${cycle.id}`,
            tenant_id: tenantId,
            agent_id: r.agent_id,
            rent_request_id: r.rent_request_id,
            days_behind: Number(r.days_behind),
            arrears_ugx: Number(r.arrears_ugx),
            plans_count: 1,
            recipient_role: "calling_centre",
            sms_status: "not_applicable",
            cc_cycle_row_id: row?.id ?? null,
          });
        }
      }
    }

    return new Response(JSON.stringify({ success: true, ...summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[tenant-arrears-escalations] failed", e instanceof Error ? e.message : e);
    return new Response(
      JSON.stringify({ success: false, error: e instanceof Error ? e.message : "failed", ...summary }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
