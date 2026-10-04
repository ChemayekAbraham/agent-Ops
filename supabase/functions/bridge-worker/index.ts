// Deposit Bridge worker — verifies wallet ledger has the credit for each
// queued bridge event. Called on a 30s pg_cron schedule and safe to invoke
// manually via HTTP for immediate drain.
//
// Structured JSON logs per event: transaction_id, event_id, worker_id,
// attempt, status, latency, correlation_id.
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Grace period before we consider a still-uncredited event a failure.
// Normal happy-path credits are already in the ledger within seconds of the
// deposit approval, so 60s is plenty and stops us from racing the primary
// crediting path.
const GRACE_PERIOD_MS = 60_000;

interface BridgeEvent {
  id: string;
  source: 'deposit_request' | 'gmail_transaction';
  source_id: string;
  transaction_id: string | null;
  user_id: string | null;
  amount: number;
  status: string;
  attempt: number;
  correlation_id: string;
  created_at: string;
}

function log(entry: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const results = { claimed: 0, delivered: 0, retried: 0, dead_lettered: 0, skipped: 0 };

  try {
    const { data: claimed, error: claimErr } = await admin.rpc('claim_deposit_bridge_events', {
      p_worker_id: workerId,
      p_batch_size: 50,
    });
    if (claimErr) throw claimErr;

    const events: BridgeEvent[] = (claimed as BridgeEvent[]) ?? [];
    results.claimed = events.length;

    for (const ev of events) {
      const t0 = Date.now();
      try {
        const { data: groupId, error: verifyErr } = await admin.rpc('deposit_bridge_ledger_present', {
          p_source: ev.source,
          p_source_id: ev.source_id,
          p_transaction_id: ev.transaction_id,
          p_user_id: ev.user_id,
          p_amount: ev.amount,
        });
        if (verifyErr) throw verifyErr;

        if (groupId) {
          const latency = Date.now() - new Date(ev.created_at).getTime();
          await admin.rpc('mark_deposit_bridge_delivered', {
            p_event_id: ev.id,
            p_group_id: groupId,
            p_latency_ms: latency,
          });
          results.delivered++;
          log({
            level: 'info', msg: 'delivered',
            event_id: ev.id, transaction_id: ev.transaction_id,
            worker_id: workerId, attempt: ev.attempt,
            correlation_id: ev.correlation_id, latency_ms: latency,
          });
          continue;
        }

        // Not in ledger yet. Respect the grace period so we don't race the
        // primary credit path.
        const ageMs = Date.now() - new Date(ev.created_at).getTime();
        if (ageMs < GRACE_PERIOD_MS) {
          await admin.rpc('mark_deposit_bridge_failed', {
            p_event_id: ev.id,
            p_error: `Within ${GRACE_PERIOD_MS}ms grace period — retrying`,
          });
          results.retried++;
          log({
            level: 'debug', msg: 'grace-period',
            event_id: ev.id, worker_id: workerId, age_ms: ageMs,
            correlation_id: ev.correlation_id,
          });
          continue;
        }

        // Past the grace period and still no ledger credit — this is a real
        // gap. Mark failed; mark_deposit_bridge_failed handles DLQ escalation
        // once max_attempts is exceeded.
        await admin.rpc('mark_deposit_bridge_failed', {
          p_event_id: ev.id,
          p_error: 'No matching wallet ledger credit found after grace period',
        });
        results.retried++;
        log({
          level: 'warn', msg: 'missing-credit',
          event_id: ev.id, transaction_id: ev.transaction_id,
          worker_id: workerId, attempt: ev.attempt,
          correlation_id: ev.correlation_id, age_ms: ageMs,
          latency_ms: Date.now() - t0,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await admin.rpc('mark_deposit_bridge_failed', {
          p_event_id: ev.id,
          p_error: msg.slice(0, 500),
        });
        results.retried++;
        log({
          level: 'error', msg: 'worker-error', error: msg,
          event_id: ev.id, worker_id: workerId, attempt: ev.attempt,
          correlation_id: ev.correlation_id,
        });
      }
    }

    // Count any DEAD_LETTER promotions triggered by this batch.
    const { count: dlq } = await admin
      .from('deposit_bridge_events')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'DEAD_LETTER')
      .gte('dead_lettered_at', new Date(Date.now() - 60_000).toISOString());
    results.dead_lettered = dlq ?? 0;

    return new Response(JSON.stringify({ ok: true, worker_id: workerId, ...results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ level: 'fatal', msg: 'worker-fatal', error: msg, worker_id: workerId });
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});