import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Monthly 33% → daily equivalent for compounding on arrears
const MONTHLY_RATE = 0.33;
const DAILY_COMPOUND_RATE = Math.pow(1 + MONTHLY_RATE, 1 / 30) - 1;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Treasury guard: daily charges debit user wallets
    const guardBlock = await checkTreasuryGuard(supabase, "any");
    if (guardBlock) return guardBlock;

    const { data: draws, error: fetchError } = await supabase
      .from('credit_access_draws')
      .select('*')
      .in('status', ['active', 'overdue']);

    if (fetchError) throw fetchError;
    if (!draws || draws.length === 0) {
      return new Response(JSON.stringify({ message: 'No active credit draws' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const today = new Date().toISOString().split('T')[0];
    const results = [];

    for (const draw of draws) {
      const openingBalance = Number(draw.outstanding_balance);
      if (openingBalance <= 0) continue;

      const isOverdue = new Date() > new Date(draw.expires_at);
      let dailyCharge = Number(draw.daily_charge);

      if (isOverdue) {
        const compoundInterest = Math.round(openingBalance * DAILY_COMPOUND_RATE);
        dailyCharge = dailyCharge + compoundInterest;
      }

      const { data: userWallet } = await supabase
        .from('wallets')
        .select('balance')
        .eq('user_id', draw.user_id)
        .single();

      const userBalance = Math.max(Number(userWallet?.balance ?? 0), 0);
      let userDeducted = Math.min(userBalance, dailyCharge);
      let remaining = dailyCharge - userDeducted;
      let agentDeducted = 0;

      if (remaining > 0 && draw.agent_id) {
        const { data: agentWallet } = await supabase
          .from('wallets')
          .select('balance')
          .eq('user_id', draw.agent_id)
          .single();

        const agentBalance = Math.max(Number(agentWallet?.balance ?? 0), 0);
        agentDeducted = Math.min(agentBalance, remaining);
        remaining -= agentDeducted;
      }

      const totalDeducted = userDeducted + agentDeducted;
      const closingBalance = openingBalance - totalDeducted;

      const compoundedClosing = isOverdue && remaining > 0
        ? closingBalance + Math.round(remaining * DAILY_COMPOUND_RATE)
        : closingBalance;

      const deductionStatus = totalDeducted >= dailyCharge ? 'full' :
        totalDeducted > 0 ? 'partial' : 'none';

      // Record in draw ledger FIRST, and stop if it fails. The unique index on
      // (draw_id, date) makes a second run on the same day fail here, so this draw
      // is skipped before any money moves. Any other insert failure also skips the
      // draw: an uncharged day is recoverable, a double charge is a money mistake.
      const { error: drawLedgerErr } = await supabase.from('credit_draw_ledger').insert({
        draw_id: draw.id,
        date: today,
        opening_balance: openingBalance,
        daily_charge: dailyCharge,
        amount_deducted: userDeducted,
        agent_deducted: agentDeducted,
        closing_balance: Math.max(0, compoundedClosing),
        deduction_status: deductionStatus,
      });
      if (drawLedgerErr) {
        const alreadyCharged = drawLedgerErr.code === '23505';
        console.warn(`[process-credit-daily-charges] draw ${draw.id} skipped: ${alreadyCharged ? 'already charged today' : drawLedgerErr.message}`);
        results.push({
          draw_id: draw.id,
          user_id: draw.user_id,
          skipped: true,
          reason: alreadyCharged ? 'already_charged_today' : 'draw_ledger_insert_failed',
        });
        continue;
      }

      // Debit user wallet via RPC (balanced: wallet cash_out + platform cash_in)
      if (userDeducted > 0) {
        const { error: userRpcErr } = await supabase.rpc('create_ledger_transaction', {
          entries: [
            {
              user_id: draw.user_id,
              ledger_scope: 'wallet',
              direction: 'cash_out',
              amount: userDeducted,
              category: 'agent_repayment',
              source_table: 'credit_access_draws',
              source_id: draw.id,
              description: `Credit daily charge - Day ${Math.ceil((Date.now() - new Date(draw.started_at).getTime()) / 86400000)}`,
              currency: 'UGX',
              transaction_date: today,
            },
            {
              ledger_scope: 'platform',
              direction: 'cash_in',
              amount: userDeducted,
              category: 'agent_repayment',
              source_table: 'credit_access_draws',
              source_id: draw.id,
              description: `Credit daily charge received from user`,
              currency: 'UGX',
              transaction_date: today,
            },
          ],
        });
        if (userRpcErr) console.error(`[process-credit-daily-charges] User RPC error for draw ${draw.id}:`, userRpcErr);
      }

      // Debit agent wallet via RPC (balanced: wallet cash_out + platform cash_in)
      if (agentDeducted > 0 && draw.agent_id) {
        const { error: agentRpcErr } = await supabase.rpc('create_ledger_transaction', {
          entries: [
            {
              user_id: draw.agent_id,
              ledger_scope: 'wallet',
              direction: 'cash_out',
              amount: agentDeducted,
              category: 'agent_repayment',
              source_table: 'credit_access_draws',
              source_id: draw.id,
              description: `Agent fallback for credit charge - user shortfall`,
              currency: 'UGX',
              transaction_date: today,
            },
            {
              ledger_scope: 'platform',
              direction: 'cash_in',
              amount: agentDeducted,
              category: 'agent_repayment',
              source_table: 'credit_access_draws',
              source_id: draw.id,
              description: `Agent fallback credit charge received`,
              currency: 'UGX',
              transaction_date: today,
            },
          ],
        });
        if (agentRpcErr) console.error(`[process-credit-daily-charges] Agent RPC error for draw ${draw.id}:`, agentRpcErr);
      }

      // Update draw status
      const newStatus = compoundedClosing <= 0 ? 'completed' : (isOverdue ? 'overdue' : 'active');
      await supabase.from('credit_access_draws').update({
        outstanding_balance: Math.max(0, compoundedClosing),
        amount_repaid: Number(draw.amount_repaid) + totalDeducted,
        status: newStatus,
        ...(newStatus === 'completed' ? { completed_at: new Date().toISOString() } : {}),
      }).eq('id', draw.id);

      results.push({
        draw_id: draw.id,
        user_id: draw.user_id,
        daily_charge: dailyCharge,
        user_deducted: userDeducted,
        agent_deducted: agentDeducted,
        closing: compoundedClosing,
        status: newStatus,
      });
    }

    return new Response(JSON.stringify({ processed: results.length, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
