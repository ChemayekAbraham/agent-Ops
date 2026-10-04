// Background worker for bulk agent capability changes.
// - Pulls one batch at a time via claim_next_agent_capability_batch
// - Calls existing ops_bulk_set_agent_capability for the chunk
// - Reports outcome via complete_agent_capability_batch
// - Loops up to MAX_BATCHES_PER_INVOCATION or until time budget exhausted
// Triggered by pg_cron every 30s and on-demand from the dashboard.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_BATCHES_PER_INVOCATION = 25;
const TIME_BUDGET_MS = 50_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Optional jobId scoping — when invoked from the dashboard right after enqueue
  let jobId: string | null = null;
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body && typeof body.job_id === "string") jobId = body.job_id;
    }
  } catch (_) { /* no-op */ }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  const started = Date.now();
  let processed = 0;
  let failed = 0;

  while (
    processed < MAX_BATCHES_PER_INVOCATION &&
    Date.now() - started < TIME_BUDGET_MS
  ) {
    const { data: batch, error: claimErr } = await admin.rpc(
      "claim_next_agent_capability_batch",
      { _job_id: jobId },
    );
    if (claimErr) {
      console.error("claim error", claimErr.message);
      break;
    }
    if (!batch) break; // no more pending batches

    const { batch_id, capability, action, reason, agent_ids } = batch as {
      batch_id: number;
      capability: string;
      action: "enable" | "disable";
      reason: string;
      agent_ids: string[];
    };

    let affected = 0;
    let errMsg: string | null = null;

    try {
      const { data, error } = await admin.rpc("ops_bulk_set_agent_capability", {
        _agent_ids: agent_ids,
        _capability: capability,
        _action: action,
        _reason: reason,
      });
      if (error) throw error;
      affected = Number((data as { affected?: number } | null)?.affected ?? 0);
    } catch (e) {
      errMsg = (e as Error).message ?? String(e);
      failed++;
    }

    const { error: completeErr } = await admin.rpc(
      "complete_agent_capability_batch",
      { _batch_id: batch_id, _affected: affected, _error: errMsg },
    );
    if (completeErr) console.error("complete error", completeErr.message);

    processed++;
  }

  return new Response(
    JSON.stringify({
      processed,
      failed,
      duration_ms: Date.now() - started,
      job_id: jobId,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
  );
});