import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { attemptYoolaPrimary } from '../_shared/yoolaPrimary.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const fmtUGX = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Pay now" on an agent's advance. The agent pays at any time, including after the day's deduction was taken. All the work happens in ONE database
 * transaction (advance_pay_now): it locks the advance, works the day from the Kampala date, refuses a stale view, never takes more than is owed or
 * than the agent can withdraw, and posts once per idempotency key.
 *
 * Body for a payment: { advance_id, idempotency_key (uuid, made once per payment intent), amount?, expected_paid_today? }
 *   - amount omitted: pays what is due today.
 *   - expected_paid_today: what the app showed as already paid today; if it has changed the payment is refused so nothing is paid on stale figures.
 * Body for the figures the dialog shows: { advance_id, action: 'preview' }
 * Requests without an idempotency_key are refused: the old pay-ahead call could be charged twice.
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(supabaseUrl, serviceKey);

    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Not authenticated' }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'Not authenticated' }, 401);
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const advanceId = String(body?.advance_id ?? '');
    if (!UUID_RE.test(advanceId)) return json({ error: 'advance_id required' }, 400);

    if (body?.action === 'preview') {
      const { data, error } = await admin.rpc('advance_pay_now_preview', { p_advance_id: advanceId, p_agent_id: userId });
      if (error) return fail(error.message);
      return json({ ok: true, ...data });
    }

    const key = String(body?.idempotency_key ?? '');
    if (!UUID_RE.test(key)) {
      return json({ error: 'Please refresh the app and try again (this version of the app cannot take a payment safely).', code: 'ADVANCE_BAD_REQUEST' }, 400);
    }
    let amount: number | null = null;
    if (body?.amount !== undefined && body?.amount !== null && body?.amount !== '') {
      amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'Enter an amount greater than zero.', code: 'ADVANCE_BAD_REQUEST' }, 400);
    }
    let expectedPaidToday: number | null = null;
    if (body?.expected_paid_today !== undefined && body?.expected_paid_today !== null) {
      expectedPaidToday = Number(body.expected_paid_today);
      if (!Number.isFinite(expectedPaidToday) || expectedPaidToday < 0) return json({ error: 'Bad request', code: 'ADVANCE_BAD_REQUEST' }, 400);
    }

    // The key is scoped to this agent and advance, so one agent's key can never replay another's payment.
    const { data: res, error: payErr } = await admin.rpc('advance_pay_now', {
      p_advance_id: advanceId,
      p_agent_id: userId,
      p_amount: amount,
      p_idempotency_key: `${userId}:${advanceId}:${key}`,
      p_expected_paid_today: expectedPaidToday,
    });
    if (payErr) return fail(payErr.message);

    // SMS only for a payment that was actually made now, never for a repeat of the same key.
    if (!res?.duplicate) {
      const { data: prof } = await admin.from('profiles').select('phone, full_name').eq('id', userId).maybeSingle();
      if (prof?.phone) {
        const msg = `You paid ${fmtUGX(res.amount_paid)} toward your advance. Outstanding ${fmtUGX(res.closing_balance)}.`;
        try {
          await attemptYoolaPrimary(prof.phone, msg, {
            source: 'advance_voluntary_repayment',
            recipientUserId: userId,
            recipientName: prof.full_name ?? undefined,
          });
        } catch (_e) { /* SMS failure is non-blocking */ }
      }
    }
    return json(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, 500);
  }
});

/** The database raises 'CODE: words'. Turn that into a clear message with the right status. */
function fail(message: string): Response {
  const m = /^(ADVANCE_[A-Z_]+):\s*(.*)$/s.exec(message || '');
  if (m) {
    const code = m[1];
    const status = code === 'ADVANCE_NOT_FOUND' ? 404 : code === 'ADVANCE_STATE_CHANGED' ? 409 : 400;
    return json({ error: m[2], code }, status);
  }
  return json({ error: 'The payment could not be made. Nothing was taken. Please try again.' }, 500);
}
