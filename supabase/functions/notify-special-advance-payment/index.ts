import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendSMS } from '../_shared/sendSmsMultiProvider.ts';
import { requireServiceRole } from '../_shared/requireServiceRole.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const fmtUGX = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SMS to the borrower after a Special Advance repayment from their wallet (migration 20261117150000).
 * Called only by the database (trigger on special_advance_repayments via pg_net, which posts after the payment has
 * committed), never by a browser. It takes just the repayment id and reads every figure from the database, so it can
 * only ever describe a payment that really happened.
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const refused = await requireServiceRole(req, corsHeaders);
  if (refused) return refused;
  try {
    const { repayment_id } = await req.json().catch(() => ({}));
    if (!UUID_RE.test(String(repayment_id ?? ''))) return json({ error: 'repayment_id required' }, 400);
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: rep } = await admin.from('special_advance_repayments')
      .select('id, advance_id, amount, method, reference, recorded_by, reversed_by_correction')
      .eq('id', repayment_id).maybeSingle();
    if (!rep || rep.method !== 'wallet') return json({ ok: true, skipped: 'not_a_wallet_repayment' });
    if (rep.reversed_by_correction) return json({ ok: true, skipped: 'reversed' });

    const { data: adv } = await admin.from('special_advances')
      .select('id, reference, borrower_user_id').eq('id', rep.advance_id).maybeSingle();
    if (!adv?.borrower_user_id) return json({ ok: true, skipped: 'no_borrower' });

    const { data: prof } = await admin.from('profiles').select('phone, full_name').eq('id', adv.borrower_user_id).maybeSingle();
    if (!prof?.phone) return json({ ok: true, skipped: 'no_phone' });

    const { data: pos } = await admin.rpc('_special_advance_position', { p_id: adv.id });
    const left = Number((pos as { outstanding?: number } | null)?.outstanding ?? 0);

    const message = `WELILE: ${fmtUGX(rep.amount)} paid from your wallet to Special Advance ${adv.reference}, receipt ${rep.reference}. `
      + (left > 0 ? `Balance ${fmtUGX(left)}.` : 'Your Special Advance is fully repaid.');
    const delivered = await sendSMS(prof.phone, message, {
      admin,
      source: 'special_advance_wallet_repayment',
      reference_id: rep.reference,
      // one text per repayment, even if the call is retried
      idempotencyKey: `special_advance_wallet_repayment:${rep.id}`,
      recipient_user_id: adv.borrower_user_id,
      recipient_name: prof.full_name ?? undefined,
    });
    return json({ ok: true, delivered });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
