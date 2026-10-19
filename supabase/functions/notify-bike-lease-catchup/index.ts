import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendSMS } from '../_shared/sendSmsMultiProvider.ts';
import { requireServiceRole } from '../_shared/requireServiceRole.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const fmtUGX = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

/**
 * Bike lease catch-up SMS, called from public.recover_merchandise_from_wallets
 * via pg_net when a collection includes money missed on earlier days. The SQL
 * side guarantees at most one call per plan per Kampala day and never calls
 * overnight; this function only formats and sends.
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const refused = await requireServiceRole(req, corsHeaders);
  if (refused) return refused;
  try {
    const { agent_id, total, today_part, catchup_part, source } = await req.json();
    if (!agent_id || !total || today_part == null || catchup_part == null) {
      return new Response(JSON.stringify({ error: 'agent_id, total, today_part and catchup_part required' }), { status: 400, headers: corsHeaders });
    }
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: prof } = await supabase.from('profiles').select('phone, full_name').eq('id', agent_id).maybeSingle();
    if (!prof?.phone) return new Response(JSON.stringify({ ok: true, skipped: 'no_phone' }), { headers: corsHeaders });

    const firstName = (prof.full_name || 'Rider').trim().split(/\s+/)[0];
    const message = `${firstName}, Welile took ${fmtUGX(total)} from your wallet for your bike lease: ${fmtUGX(today_part)} for today + ${fmtUGX(catchup_part)} missed earlier`;

    const delivered = await sendSMS(prof.phone, message, {
      admin: supabase,
      source: source || 'bike_lease_catchup',
      recipient_user_id: agent_id,
      recipient_name: prof.full_name ?? undefined,
    });
    return new Response(JSON.stringify({ ok: true, delivered }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: corsHeaders });
  }
});
