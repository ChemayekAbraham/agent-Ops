// Phase 0 — control fix.
//
// This function used to do four things through separate PostgREST calls:
//   1. insert agent_advance_ledger
//   2. update agent_advances (balance, status, fee fields)
//   3. rpc create_ledger_transaction
//   4. insert audit_logs
//
// Step 3 was best-effort:
//
//     if (rpcErr) console.error('[cfo-record-advance-payment] RPC error:', rpcErr);
//
// The error was logged and swallowed, so a failed posting still reduced the
// balance and still wrote an audit row claiming a completed payment. Thirteen
// entries failed that way (UGX 6,785,998.18 across six advances) because the
// wallet leg cannot clear `create_ledger_transaction`'s solvency check against
// an empty agent wallet.
//
// All four writes now happen inside public.cfo_record_advance_payment, one
// SECURITY DEFINER transaction. Any failure rolls back all of them and returns
// a non-2xx. The failure is recorded in system_events AFTER the rollback, so
// the diagnostic survives without creating a financial record.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

// Postgres SQLSTATE -> HTTP. Anything unrecognised is a 500.
function statusForPgError(code?: string): number {
  switch (code) {
    case '28000': return 401; // not authenticated
    case '42501': return 403; // wrong role
    case '22023': return 400; // bad argument
    case '0A000': return 422; // unsupported payment method
    case 'P0002': return 404; // advance not found
    default:      return 500;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const adminClient = createClient(supabaseUrl, serviceKey);

  let recordedBy: string | null = null;
  let payload: Record<string, unknown> = {};

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing auth' }, 401);
    const token = authHeader.replace('Bearer ', '');

    const { data: userData, error: userErr } = await adminClient.auth.getUser(token);
    if (userErr || !userData.user) return json({ error: 'Unauthorized' }, 401);
    recordedBy = userData.user.id;

    const body = await req.json();
    const { advance_id, amount, payment_method, notes } = body;
    let reference = body.reference;

    // A wallet offset moves money inside our own ledger, so there is no
    // external TID to type. Generate a unique one rather than rejecting.
    if (
      payment_method === 'wallet_offset' &&
      (!reference || String(reference).trim() === '')
    ) {
      const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17);
      const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
      reference = `WOFF-${stamp}-${rand}`;
    }
    payload = { advance_id, amount, payment_method, reference };

    // Cheap client-side rejects. The RPC re-checks all of these — these exist
    // only to avoid a round trip, never as the control itself.
    if (!advance_id) return json({ error: 'advance_id is required' }, 400);
    if (!amount || Number(amount) <= 0) return json({ error: 'A positive amount is required' }, 400);
    if (!reference || String(reference).trim() === '') {
      return json({ error: 'A payment reference is required' }, 400);
    }
    if (!payment_method || String(payment_method).trim() === '') {
      return json({ error: 'A payment method is required' }, 400);
    }

    // Call as the CALLER, not the service role, so auth.uid() inside the
    // SECURITY DEFINER function resolves and the CFO/Manager gate applies.
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data, error } = await userClient.rpc('cfo_record_advance_payment', {
      p_advance_id:     advance_id,
      p_amount:         Number(amount),
      p_payment_method: String(payment_method),
      p_reference:      String(reference),
      p_notes:          notes ?? null,
    });

    if (error) {
      // The transaction has already rolled back. Nothing was written: no
      // subledger row, no balance change, no audit record. Record the
      // diagnostic separately so the reason is not lost to a console log —
      // this is an event, not a financial entry.
      await adminClient.from('system_events').insert({
        event_type: 'cfo_advance_payment_failed',
        user_id: recordedBy,
        related_entity_type: 'agent_advances',
        related_entity_id: advance_id,
        description: 'CFO advance payment rejected; transaction rolled back, nothing recorded',
        source: 'cfo-record-advance-payment',
        metadata: {
          pg_code: error.code ?? null,
          pg_message: error.message ?? null,
          pg_details: error.details ?? null,
          attempted: payload,
          rolled_back: true,
        },
      }).then(
        () => undefined,
        (e: unknown) => console.error('[cfo-record-advance-payment] failure-log insert failed:', e),
      );

      console.error('[cfo-record-advance-payment] rejected:', error.code, error.message);
      return json(
        { error: error.message, code: error.code ?? null, recorded: false, rolled_back: true },
        statusForPgError(error.code),
      );
    }

    return json({ ...(data as Record<string, unknown>), recorded: true }, 200);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[cfo-record-advance-payment] unhandled:', message);

    await adminClient.from('system_events').insert({
      event_type: 'cfo_advance_payment_failed',
      user_id: recordedBy,
      related_entity_type: 'agent_advances',
      related_entity_id: (payload.advance_id as string) ?? null,
      description: 'CFO advance payment aborted before or during the atomic call',
      source: 'cfo-record-advance-payment',
      metadata: { error: message, attempted: payload, rolled_back: true },
    }).then(
      () => undefined,
      (err: unknown) => console.error('[cfo-record-advance-payment] failure-log insert failed:', err),
    );

    return json({ error: message, recorded: false, rolled_back: true }, 500);
  }
});
