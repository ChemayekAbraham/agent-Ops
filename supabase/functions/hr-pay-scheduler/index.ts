// HR payroll scheduler — daily invocation.
//
// This function PREPARES payroll only. It creates the pay period and opens the
// run so a human can calculate and later release it. It NEVER releases payment,
// never calls hr-pay-release, and never writes a 'paid' or 'locked' event.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** YYYY-MM-DD for a UTC date, avoiding timezone drift from toISOString slicing. */
function isoDate(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const steps: string[] = [];
  let scheduleId: string | null = null;

  /** Record the outcome on the schedule row so nothing fails silently. */
  const recordNote = async (note: string) => {
    if (!scheduleId) return;
    try {
      await admin
        .from("hr_pay_schedule")
        .update({ last_run_at: new Date().toISOString(), last_run_note: note.slice(0, 1000) })
        .eq("id", scheduleId);
    } catch (e) {
      console.error("could not write last_run_note", e);
    }
  };

  try {
    // 1. Read the single schedule row.
    const { data: schedule, error: schedErr } = await admin
      .from("hr_pay_schedule")
      .select("id, day_of_month, auto_prepare, auto_calculate, auto_notify, enabled")
      .limit(1)
      .maybeSingle();

    if (schedErr) {
      return json({ ok: false, result: "schedule read failed", error: schedErr.message }, 500);
    }
    if (!schedule) {
      return json({ ok: false, result: "no schedule row configured" }, 200);
    }
    scheduleId = schedule.id as string;

    if (!schedule.enabled) {
      return json({ ok: true, result: "scheduler disabled" });
    }

    // 2. Only act on the configured day of month.
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const today = now.getUTCDate();
    if (today !== Number(schedule.day_of_month)) {
      return json({
        ok: true,
        result: "not scheduled today",
        today,
        day_of_month: Number(schedule.day_of_month),
      });
    }

    const periodCode = `${year}-${pad2(month)}`;
    const periodMonth = isoDate(year, month, 1);
    const lastDay = lastDayOfMonth(year, month);
    const monthEnd = isoDate(year, month, lastDay);

    // 3. Period: reuse when one already exists for this month.
    let periodId: string | null = null;
    let periodCreated = false;
    try {
      const { data: existingPeriod, error: pErr } = await admin
        .from("hr_pay_periods")
        .select("id")
        .eq("code", periodCode)
        .limit(1)
        .maybeSingle();
      if (pErr) throw pErr;

      if (existingPeriod) {
        periodId = existingPeriod.id as string;
        steps.push(`period ${periodCode} already existed`);
      } else if (schedule.auto_prepare) {
        const { data: created, error: cErr } = await admin
          .from("hr_pay_periods")
          .insert({
            code: periodCode,
            period_month: periodMonth,
            cut_off_date: monthEnd,
            pay_date: monthEnd,
          })
          .select("id")
          .single();
        if (cErr) throw cErr;
        periodId = created.id as string;
        periodCreated = true;
        steps.push(`period ${periodCode} created`);
      } else {
        steps.push("auto_prepare is off; no period created");
      }
    } catch (e) {
      const note = `period step failed: ${(e as Error).message}`;
      steps.push(note);
      await recordNote(steps.join("; "));
      return json({ ok: false, result: note, steps }, 200);
    }

    if (!periodId) {
      const note = steps.join("; ");
      await recordNote(note);
      return json({ ok: true, result: "no period available; nothing prepared", steps });
    }

    // 4. Run: reuse when one already exists for this period.
    let runId: string | null = null;
    let runCreated = false;
    try {
      const { data: existingRun, error: rErr } = await admin
        .from("hr_pay_runs")
        .select("id")
        .eq("period_id", periodId)
        .limit(1)
        .maybeSingle();
      if (rErr) throw rErr;

      if (existingRun) {
        runId = existingRun.id as string;
        steps.push("run already existed for this period");
      } else {
        const { data: rule, error: ruleErr } = await admin
          .from("hr_pay_rule_versions")
          .select("id")
          .order("effective_from", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (ruleErr) throw ruleErr;
        if (!rule) throw new Error("no hr_pay_rule_versions row to attach the run to");

        // status is intentionally left to its table default ('draft').
        const { data: createdRun, error: crErr } = await admin
          .from("hr_pay_runs")
          .insert({ period_id: periodId, rule_version_id: rule.id })
          .select("id")
          .single();
        if (crErr) throw crErr;
        runId = createdRun.id as string;
        runCreated = true;
        steps.push("run created");

        const { error: evErr } = await admin.from("hr_pay_run_events").insert({
          run_id: runId,
          event_type: "created",
          note: `Opened automatically by the payroll scheduler for ${periodCode}.`,
        });
        if (evErr) throw evErr;
        steps.push("run event 'created' written");
      }
    } catch (e) {
      const note = `run step failed: ${(e as Error).message}`;
      steps.push(note);
      await recordNote(steps.join("; "));
      return json({ ok: false, result: note, steps }, 200);
    }

    // 5. Calculation is never performed here — the calculator lives in the browser.
    if (schedule.auto_calculate) {
      steps.push(
        runCreated
          ? "run awaits calculation in the browser (calculation is not performed by the scheduler)"
          : "existing run awaits calculation in the browser",
      );
    } else {
      steps.push("auto_calculate is off");
    }

    if (schedule.auto_notify) {
      steps.push("auto_notify is on");
    }

    // 6/7. Persist the note and summarise.
    const summary = steps.join("; ");
    await recordNote(summary);

    return json({
      ok: true,
      result: summary,
      period_code: periodCode,
      period_id: periodId,
      period_created: periodCreated,
      run_id: runId,
      run_created: runCreated,
      released: false,
      steps,
    });
  } catch (e) {
    const note = `scheduler failed: ${(e as Error).message}`;
    console.error(note);
    await recordNote(note);
    return json({ ok: false, result: note }, 200);
  }
});
