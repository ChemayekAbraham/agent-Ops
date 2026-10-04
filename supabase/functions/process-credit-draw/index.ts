import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MONTHLY_RATE = 0.33;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // NOTE: No treasury guard here anymore — submitting a draw moves NO money.
    // Money only moves when the CFO manually approves + disburses the draw.
    const authHeader = req.headers.get('Authorization');
    const anonClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!);
    const { data: { user }, error: authError } = await anonClient.auth.getUser(
      authHeader?.replace('Bearer ', '') ?? ''
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { amount, duration_months, agent_id } = await req.json();

    if (!amount || amount < 10000 || !duration_months || duration_months < 1 || duration_months > 12) {
      return new Response(JSON.stringify({ error: 'Invalid amount or duration (1-12 months)' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: limitData } = await supabase
      .from('credit_access_limits')
      .select('total_limit')
      .eq('user_id', user.id)
      .maybeSingle();

    const creditLimit = Number(limitData?.total_limit) || 30000;
    if (amount > creditLimit) {
      return new Response(JSON.stringify({ error: 'Amount exceeds credit limit' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: existingDraw } = await supabase
      .from('credit_access_draws')
      .select('id, status')
      .eq('user_id', user.id)
      .in('status', ['active', 'overdue', 'pending_cfo'])
      .maybeSingle();

    if (existingDraw) {
      const msg = existingDraw.status === 'pending_cfo'
        ? 'You already have a credit request awaiting CFO approval.'
        : 'You already have an active credit draw. Repay first.';
      return new Response(JSON.stringify({ error: msg }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const durationDays = duration_months * 30;
    const accessFee = Math.round(amount * (Math.pow(1 + MONTHLY_RATE, duration_months) - 1));
    const totalPayable = amount + accessFee;
    const dailyCharge = Math.ceil(totalPayable / durationDays);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + durationDays);

    // Create the draw as PENDING CFO REVIEW. No money moves and no ledger
    // entry is posted until the CFO edits + manually approves the draw.
    const nowIso = new Date().toISOString();
    const { data: draw, error: drawError } = await supabase
      .from('credit_access_draws')
      .insert({
        user_id: user.id,
        agent_id: agent_id || null,
        amount,
        requested_amount: amount,
        duration_months,
        monthly_rate: MONTHLY_RATE,
        access_fee: accessFee,
        total_payable: totalPayable,
        daily_charge: dailyCharge,
        outstanding_balance: totalPayable,
        status: 'pending_cfo',
        submitted_at: nowIso,
        expires_at: expiresAt.toISOString(),
      })
      .select('id')
      .single();

    if (drawError) throw drawError;

    // Notify CFO/managers that a credit request needs approval (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({ title: "📋 Credit Request → CFO", body: `New credit request UGX ${amount.toLocaleString()} awaiting CFO approval`, url: "/dashboard/cfo" }),
    }).catch(() => {});

    fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({
        userIds: [user.id],
        payload: { title: "⏳ Credit Request Submitted", body: `Your UGX ${amount.toLocaleString()} request was sent to the CFO for approval`, url: "/dashboard/tenant", type: "info" },
      }),
    }).catch(() => {});

    return new Response(JSON.stringify({
      success: true,
      pending_cfo: true,
      draw_id: draw.id,
      amount,
      access_fee: accessFee,
      total_payable: totalPayable,
      daily_charge: dailyCharge,
      duration_months,
      expires_at: expiresAt.toISOString(),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
