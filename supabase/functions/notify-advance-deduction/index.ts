import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { attemptYoolaPrimary } from '../_shared/yoolaPrimary.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const fmtUGX = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

/**
 * Lightweight SMS notifier called from the auto-recovery sweep (SQL function
 * via pg_net). Sends the agent a single aggregated deduction alert.
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    const { agent_id, amount, source, mode, payments, outstanding: summaryOutstanding } = await req.json();
    if (!agent_id || !amount) {
      return new Response(JSON.stringify({ error: 'agent_id and amount required' }), { status: 400, headers: corsHeaders });
    }
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: prof } = await supabase.from('profiles').select('phone, full_name').eq('id', agent_id).maybeSingle();
    if (!prof?.phone) return new Response(JSON.stringify({ ok: true, skipped: 'no_phone' }), { headers: corsHeaders });

    const { data: adv } = await supabase.from('agent_advances')
      .select('outstanding_balance')
      .eq('agent_id', agent_id)
      .in('status', ['active', 'overdue'])
      .order('issued_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    const outstanding = Number(adv?.outstanding_balance || 0);

    // daily_summary: one SMS covering every credit-time / withdrawal-time
    // deduction in the last 24h (send_daily_advance_deduction_summary).
    const n = Math.max(1, Math.round(Number(payments) || 1));
    const left = Number(summaryOutstanding);
    const message = mode === 'daily_summary'
      ? `WELILE: ${fmtUGX(amount)} was deducted from your wallet in ${n} payment${n === 1 ? '' : 's'} in the last 24 hours toward your Agent Advance. ${left > 0 ? `Remaining balance ${fmtUGX(left)}.` : 'Your advance is now fully repaid.'} See your app for each deduction.`
      : `WELILE: ${fmtUGX(amount)} was auto-recovered from your wallet toward your advance today. Outstanding ${fmtUGX(outstanding)}.`;
    await attemptYoolaPrimary(prof.phone, message, {
      source: source || 'advance_sweep_deduction',
      recipientUserId: agent_id,
      recipientName: prof.full_name ?? undefined,
    });
    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: corsHeaders });
  }
});