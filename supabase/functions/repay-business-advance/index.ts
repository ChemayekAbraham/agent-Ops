// Tenant pays down their business advance from their wallet.
// 1% daily compounding has already been applied to outstanding_balance by the cron.
// On every repayment, the originating agent earns 4% as a platform expense.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkTreasuryGuard } from '../_shared/treasuryGuard.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const COMMISSION_RATE = 0.04; // 4%

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing authorization');

    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await anonClient.auth.getUser();
    if (authErr || !user) throw new Error('Unauthorized');

    const service = createClient(supabaseUrl, serviceKey);

    const guard = await checkTreasuryGuard(service, 'any', req.headers.get("Authorization"));
    if (guard) return guard;

    const body = await req.json();
    const advance_id: string = body.advance_id;
    const amount: number = Math.floor(Number(body.amount) || 0);
    const notes: string | null = body.notes || null;

    if (!advance_id) throw new Error('advance_id required');
    if (amount <= 0) throw new Error('Amount must be positive');

    // Fetch advance — must belong to caller (tenant_id)
    const { data: adv, error: advErr } = await service
      .from('business_advances').select('*').eq('id', advance_id).single();
    if (advErr || !adv) throw new Error('Advance not found');
    if (adv.tenant_id !== user.id) throw new Error('You can only pay your own business advance');
    if (!['active', 'cfo_disbursed'].includes(adv.status)) {
      throw new Error(`Cannot repay an advance in status: ${adv.status}`);
    }

    // Check wallet balance (withdrawable bucket)
    const { data: wallet } = await service
      .from('wallets').select('balance, withdrawable_balance').eq('user_id', user.id).maybeSingle();
    const available = Number(wallet?.withdrawable_balance ?? wallet?.balance ?? 0);
    if (available < amount) {
      throw new Error(`Insufficient wallet balance. Available: UGX ${available.toLocaleString()}`);
    }

    const outstandingBefore = Number(adv.outstanding_balance);
    const applied = Math.min(amount, outstandingBefore);
    const outstandingAfter = Math.max(0, outstandingBefore - applied);
    const commission = Math.round(applied * COMMISSION_RATE);
    const nowIso = new Date().toISOString();

    // 1) Record repayment row (drives realtime celebration to the agent)
    const { error: repErr } = await service.from('business_advance_repayments').insert({
      advance_id,
      tenant_id: user.id,
      agent_id: adv.agent_id,
      amount: applied,
      outstanding_before: outstandingBefore,
      outstanding_after: outstandingAfter,
      agent_commission: commission,
      payment_method: 'wallet',
      notes,
    });
    if (repErr) throw repErr;

    // 2) Update advance balance & status
    const newStatus = outstandingAfter <= 0 ? 'completed' : adv.status;
    const { error: updErr } = await service
      .from('business_advances')
      .update({
        outstanding_balance: outstandingAfter,
        total_repaid: Number(adv.total_repaid || 0) + applied,
        status: newStatus,
        completed_at: outstandingAfter <= 0 ? nowIso : adv.completed_at,
        updated_at: nowIso,
      })
      .eq('id', advance_id);
    if (updErr) throw updErr;

    // 3) Ledger: tenant wallet -> platform (tenant_repayment, allowlisted)
    const { error: rpcErr } = await service.rpc('create_ledger_transaction', {
      entries: [
        {
          user_id: user.id,
          ledger_scope: 'wallet',
          direction: 'cash_out',
          amount: applied,
          category: 'tenant_repayment',
          source_table: 'business_advance_repayments',
          source_id: advance_id,
          description: `Business advance repayment: ${adv.business_name}`,
          currency: 'UGX',
          transaction_date: nowIso,
        },
        {
          user_id: user.id,
          ledger_scope: 'platform',
          direction: 'cash_in',
          amount: applied,
          category: 'tenant_repayment',
          source_table: 'business_advance_repayments',
          source_id: advance_id,
          description: `Business advance repayment received from ${adv.business_name}`,
          currency: 'UGX',
          transaction_date: nowIso,
        },
      ],
    });
    if (rpcErr) throw rpcErr;

    // 4) Pay 4% commission to the originating agent (platform expense)
    if (commission > 0 && adv.agent_id) {
      const { error: comErr } = await service.rpc('create_ledger_transaction', {
        entries: [
          {
            user_id: adv.agent_id,
            ledger_scope: 'wallet',
            direction: 'cash_in',
            amount: commission,
            category: 'agent_commission_earned',
            source_table: 'business_advance_repayments',
            source_id: advance_id,
            description: `4% commission on business advance repayment (${adv.business_name})`,
            currency: 'UGX',
            transaction_date: nowIso,
          },
          {
            user_id: adv.agent_id,
            ledger_scope: 'platform',
            direction: 'cash_out',
            amount: commission,
            category: 'general_admin_expense',
            source_table: 'business_advance_repayments',
            source_id: advance_id,
            description: `Agent commission expense — business advance repayment`,
            currency: 'UGX',
            transaction_date: nowIso,
          },
        ],
      });
      if (comErr) console.error('[repay-business-advance] commission ledger failed', comErr);
    }

    return new Response(JSON.stringify({
      ok: true,
      applied,
      outstanding_after: outstandingAfter,
      commission,
      completed: outstandingAfter <= 0,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('[repay-business-advance] error', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
