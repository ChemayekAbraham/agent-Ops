import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Idempotency: check if we already ran in the last 4 minutes
    const { data: recentRun } = await supabase
      .from('system_events')
      .select('id')
      .eq('event_type', 'batch_financial_run')
      .gte('created_at', new Date(Date.now() - 4 * 60 * 1000).toISOString())
      .limit(1);

    if (recentRun && recentRun.length > 0) {
      return new Response(JSON.stringify({ skipped: true, reason: 'Already ran recently' }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: Record<string, unknown> = {};

    // 1. Batch auto-approve deposits with TID matching
    const { data: approveResult, error: approveErr } = await supabase.rpc("batch_auto_approve_deposits", { p_batch_size: 500 });
    results.auto_approve = approveErr ? { error: approveErr.message } : approveResult;

    // 2. Auto-dispatch withdrawals to agents
    const { data: dispatchResult, error: dispatchErr } = await supabase.rpc("auto_dispatch_withdrawals", { p_batch_size: 200 });
    results.auto_dispatch = dispatchErr ? { error: dispatchErr.message } : dispatchResult;

    // 3. Anomaly detection: velocity abuse via server-side RPC
    const { data: velocityAbusers, error: velocityErr } = await supabase.rpc("detect_velocity_abuse", {
      p_window_minutes: 60,
      p_threshold: 5,
    });

    if (!velocityErr && velocityAbusers?.length) {
      const flagOps = velocityAbusers.map((row: { user_id: string; deposit_count: number }) =>
        supabase.from("financial_anomalies").insert({
          anomaly_type: "velocity_abuse",
          severity: "high",
          title: `Velocity alert: ${row.deposit_count} deposits in 1 hour`,
          description: `User submitted ${row.deposit_count} deposit requests in the last hour`,
          related_user_id: row.user_id,
          metadata: { count: row.deposit_count, window: "1h" },
        })
      );
      await Promise.allSettled(flagOps);
    }
    results.velocity_check = velocityErr ? { error: velocityErr.message } : { flagged: velocityAbusers?.length ?? 0 };

    // 4. Reset agent daily queue counts at midnight
    const now = new Date();
    if (now.getUTCHours() === 0 && now.getUTCMinutes() < 5) {
      await supabase.from("cashout_agents").update({ current_queue_count: 0 }).gt("current_queue_count", 0);
      results.queue_reset = true;
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
