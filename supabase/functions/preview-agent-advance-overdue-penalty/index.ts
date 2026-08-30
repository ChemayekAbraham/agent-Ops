import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Manual CORS headers (project standard — do not import corsHeaders).
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const fmtUGX = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

// Matches the rate already in production use for overdue penalties (apply-rent-overdue-penalty).
const PENALTY_RATE = 0.33;

const ALLOWED_ROLES = ['coo', 'ceo', 'cfo', 'cto', 'super_admin', 'manager', 'agent_ops', 'financial_ops'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const { data: roles } = await admin
      .from('user_roles')
      .select('role')
      .eq('user_id', userData.user.id);
    const hasRole = (roles || []).some((r) => ALLOWED_ROLES.includes(r.role));
    if (!hasRole) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json().catch(() => ({}));
    const agentIds: string[] | undefined = Array.isArray(body?.agent_ids) && body.agent_ids.length
      ? body.agent_ids.filter(Boolean)
      : undefined;

    let query = admin
      .from('agent_advances')
      .select('agent_id, outstanding_balance, arrears_balance, status, recovery_source')
      .eq('status', 'overdue')
      // ROI advances carry no daily repayment obligation, so no agent-side penalty applies to them.
      .or('recovery_source.is.null,recovery_source.neq.roi');
    if (agentIds) query = query.in('agent_id', agentIds);

    const { data: advances, error: advErr } = await query;
    if (advErr) throw new Error(advErr.message);

    const ids = (advances || []).map((a) => a.agent_id);
    const { data: profs } = ids.length
      ? await admin.from('profiles').select('id, phone, full_name').in('id', ids)
      : { data: [] as { id: string; phone: string | null; full_name: string | null }[] };
    const profMap = new Map((profs || []).map((p) => [p.id, p]));

    const preview = (advances || []).map((adv) => {
      const outstanding = Number(adv.outstanding_balance || 0);
      const penalty = Math.ceil(outstanding * PENALTY_RATE);
      const prof = profMap.get(adv.agent_id);
      const message = [
        `WELILE: Your agent advance is overdue with ${fmtUGX(outstanding)} outstanding.`,
        `If it remains unpaid, a ${Math.round(PENALTY_RATE * 100)}% penalty of ${fmtUGX(penalty)} will be added to your balance.`,
        `Please clear it to avoid the penalty.`,
      ].join(' ');
      return {
        agent_id: adv.agent_id,
        full_name: prof?.full_name ?? null,
        phone: prof?.phone ?? null,
        outstanding_balance: outstanding,
        arrears_balance: Number(adv.arrears_balance || 0),
        penalty_rate: PENALTY_RATE,
        would_be_penalty: penalty,
        message,
      };
    });

    return new Response(JSON.stringify({
      dry_run: true,
      count: preview.length,
      total_would_be_penalty: preview.reduce((s, p) => s + p.would_be_penalty, 0),
      agents: preview,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
