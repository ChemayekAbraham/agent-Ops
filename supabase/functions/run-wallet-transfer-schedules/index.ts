// Scheduled runner for automatic (recurring) wallet transfers.
//
// It never touches wallets or the ledger itself: every due schedule is sent
// through the existing `wallet-transfer` edge function, so all the normal
// gates (balance, fraud, agent performance, treasury pause) still apply.
//
// Safety properties:
//  - bounded work per run (BATCH_SIZE)
//  - single-flight database lease (wallet_transfer_schedule_locks)
//  - idempotent progress marking (wallet_transfer_schedule_runs.run_key)
//  - a schedule is paused after MAX_FAILURES consecutive failures
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BATCH_SIZE = 100;
const MAX_FAILURES = 3;
const LOCK_NAME = 'run-wallet-transfer-schedules';
const LEASE_MINUTES = 10;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey);

  const json = (bodyObj: unknown, status = 200) =>
    new Response(JSON.stringify(bodyObj), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  // --- single-flight lease ---
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MINUTES * 60_000).toISOString();
  const { data: lease, error: leaseError } = await admin
    .from('wallet_transfer_schedule_locks')
    .upsert({ name: LOCK_NAME, leased_until: leaseUntil }, { onConflict: 'name' })
    .lt('leased_until', now.toISOString())
    .select('name');

  if (leaseError) {
    // A conflicting lease (or a genuine error) means we do not run.
    console.warn('[auto-payout] lease not acquired:', leaseError.message);
    return json({ ok: true, skipped: 'lease_not_acquired' });
  }
  if (!lease || lease.length === 0) {
    // Row existed with a live lease.
    const { data: existing } = await admin
      .from('wallet_transfer_schedule_locks')
      .select('leased_until')
      .eq('name', LOCK_NAME)
      .maybeSingle();
    if (existing && new Date(existing.leased_until).getTime() > now.getTime()) {
      return json({ ok: true, skipped: 'already_running' });
    }
    await admin
      .from('wallet_transfer_schedule_locks')
      .upsert({ name: LOCK_NAME, leased_until: leaseUntil }, { onConflict: 'name' });
  }

  let sent = 0, failed = 0, skipped = 0;

  try {
    const { data: due, error: dueError } = await admin
      .from('wallet_transfer_schedules')
      .select('id, user_id, recipient_id, amount, description, frequency, day_of_week, day_of_month, next_run_at, consecutive_failures, runs_completed')
      .eq('status', 'active')
      .not('next_run_at', 'is', null)
      .lte('next_run_at', now.toISOString())
      .order('next_run_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (dueError) return json({ error: dueError.message }, 500);

    for (const s of due ?? []) {
      const runKey = String(s.next_run_at).slice(0, 10);

      // Idempotency: claim the run BEFORE moving money.
      const { error: claimError } = await admin
        .from('wallet_transfer_schedule_runs')
        .insert({ schedule_id: s.id, run_key: runKey, amount: s.amount, status: 'skipped' });
      if (claimError) {
        skipped++;
        continue; // already processed for this due date
      }

      let ok = false;
      let errorText: string | null = null;

      // Re-check the receiver every run: an account can be closed, frozen or
      // deleted between setup and today, and the saved item must still be a
      // valid Welile item. A failed check counts as a failure (so repeated
      // failures pause the schedule) and no money is attempted.
      let eligible = true;
      try {
        const { data: check, error: checkError } = await admin.rpc(
          'check_transfer_recipient_eligibility',
          {
            p_recipient_id: s.recipient_id,
            p_item: s.description ?? null,
            p_sender_id: s.user_id,
          },
        );
        const row = Array.isArray(check) ? check[0] : check;
        if (checkError) {
          eligible = false;
          errorText = `Receiver check failed: ${checkError.message}`.slice(0, 500);
        } else if (!row?.eligible) {
          eligible = false;
          errorText = String(row?.reason ?? 'This receiver cannot be paid').slice(0, 500);
        }
      } catch (e) {
        eligible = false;
        errorText = String((e as Error).message ?? e).slice(0, 500);
      }

      try {
        if (!eligible) throw new Error(errorText ?? 'Receiver not eligible');
        const res = await fetch(`${supabaseUrl}/functions/v1/wallet-transfer`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            internal_actor_id: s.user_id,
            recipient_id: s.recipient_id,
            amount: Number(s.amount),
            description: s.description || 'Automatic transfer',
          }),
        });
        const payload = await res.json().catch(() => ({}));
        ok = res.ok && !payload?.error;
        if (!ok) errorText = String(payload?.error ?? `HTTP ${res.status}`).slice(0, 500);
      } catch (e) {
        errorText = String((e as Error).message ?? e).slice(0, 500);
      }

      await admin
        .from('wallet_transfer_schedule_runs')
        .update({ status: ok ? 'sent' : 'failed', error_text: errorText })
        .eq('schedule_id', s.id)
        .eq('run_key', runKey);

      const { data: nextRun } = await admin.rpc('wallet_transfer_schedule_next_run', {
        _frequency: s.frequency,
        _day_of_week: s.day_of_week,
        _day_of_month: s.day_of_month,
        _from: now.toISOString(),
      });

      const failures = ok ? 0 : Number(s.consecutive_failures ?? 0) + 1;
      const pause = failures >= MAX_FAILURES;

      await admin
        .from('wallet_transfer_schedules')
        .update({
          last_run_at: now.toISOString(),
          last_error: errorText,
          consecutive_failures: failures,
          runs_completed: Number(s.runs_completed ?? 0) + (ok ? 1 : 0),
          status: pause ? 'paused' : 'active',
          next_run_at: pause ? null : (nextRun as string | null),
          updated_at: now.toISOString(),
        })
        .eq('id', s.id);

      if (ok) sent++; else failed++;
    }
  } finally {
    // Release the lease so the next scheduled run can start immediately.
    await admin
      .from('wallet_transfer_schedule_locks')
      .update({ leased_until: new Date().toISOString() })
      .eq('name', LOCK_NAME);
  }

  return json({ ok: true, sent, failed, skipped });
});
