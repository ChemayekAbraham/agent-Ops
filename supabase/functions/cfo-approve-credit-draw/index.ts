// CFO manual review of a Credit Access Draw.
// A draw is submitted by the user as status='pending_cfo' and NO money moves.
// The CFO can edit the amount + duration, then either:
//   - approve: recompute terms, set status='active', and disburse to the
//     user's WITHDRAWABLE wallet (recipient_type='user'), or
//   - reject: set status='rejected' with a reason.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkTreasuryGuard } from '../_shared/treasuryGuard.ts';
import { guardCfoApprover, cfoApproverDenied, isCfoApprover } from '../_shared/cfoApprovalGate.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MONTHLY_RATE = 0.33;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const adminClient = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await adminClient.auth.getUser(token);
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const approverId = userData.user.id;

    // Only CFO / manager / super_admin can approve credit draws.
    const { data: roles } = await adminClient
      .from('user_roles').select('role').eq('user_id', approverId)
      .in('role', ['cfo', 'manager', 'super_admin']);
    if (!roles || roles.length === 0) {
      return new Response(JSON.stringify({ error: 'Insufficient permissions' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Sole-CFO-approver gate: everyone else is read-only for approvals.
    const cfoGate = await guardCfoApprover(adminClient, approverId, corsHeaders);
    if (cfoGate) return cfoGate;

    const body = await req.json();
    const { draw_id, action, amount: editedAmount, duration_months: editedMonths, notes, rejection_reason } = body;
    if (!draw_id || !['approve', 'reject'].includes(action)) {
      return new Response(JSON.stringify({ error: 'draw_id and valid action (approve|reject) required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch fresh draw — high-stakes mutation, never trust cache.
    const { data: draw, error: drawErr } = await adminClient
      .from('credit_access_draws')
      .select('*')
      .eq('id', draw_id)
      .single();
    if (drawErr || !draw) throw new Error('Credit draw not found');
    if (draw.status !== 'pending_cfo') {
      throw new Error(`Invalid status: ${draw.status} — expected pending_cfo`);
    }

    const nowIso = new Date().toISOString();

    // ── REJECT ─────────────────────────────────────────────────────────────
    if (action === 'reject') {
      const { error: updErr } = await adminClient
        .from('credit_access_draws')
        .update({
          status: 'rejected',
          rejection_reason: (rejection_reason || 'Rejected by CFO').slice(0, 500),
          cfo_approved_by: approverId,
          cfo_approved_at: nowIso,
          cfo_notes: notes || null,
          updated_at: nowIso,
        })
        .eq('id', draw_id)
        .eq('status', 'pending_cfo');
      if (updErr) throw updErr;

      await adminClient.from('audit_logs').insert({
        user_id: approverId,
        action_type: 'cfo_credit_draw_rejected',
        table_name: 'credit_access_draws',
        record_id: draw_id,
        reason: (rejection_reason || 'cfo rejected credit draw').slice(0, 200).padEnd(10, '.'),
        metadata: { requested_amount: Number(draw.amount) },
      });

      fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({
          userIds: [draw.user_id],
          payload: { title: '❌ Credit Request Declined', body: rejection_reason || 'Your credit request was declined by the CFO.', url: '/dashboard/tenant', type: 'error' },
        }),
      }).catch(() => {});

      return new Response(JSON.stringify({ success: true, status: 'rejected' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── APPROVE + DISBURSE ──────────────────────────────────────────────────
    // Treasury guard: this path actually moves money. CTO/super_admin bypass.
    const guard = await checkTreasuryGuard(adminClient, 'credit', authHeader);
    if (guard) return guard;

    // Apply CFO edits (fall back to the originally requested values).
    const amount = Math.round(Number(editedAmount ?? draw.amount));
    const durationMonths = Math.max(1, Math.min(12, Math.round(Number(editedMonths ?? draw.duration_months))));
    if (!amount || amount < 10000) throw new Error('Amount must be at least UGX 10,000');

    // Re-validate against the user's credit limit at approval time.
    const { data: limitData } = await adminClient
      .from('credit_access_limits')
      .select('total_limit')
      .eq('user_id', draw.user_id)
      .maybeSingle();
    const creditLimit = Number(limitData?.total_limit) || 30000;
    if (amount > creditLimit) {
      throw new Error(`Amount UGX ${amount.toLocaleString()} exceeds the user's credit limit of UGX ${creditLimit.toLocaleString()}`);
    }

    const durationDays = durationMonths * 30;
    const accessFee = Math.round(amount * (Math.pow(1 + MONTHLY_RATE, durationMonths) - 1));
    const totalPayable = amount + accessFee;
    const dailyCharge = Math.ceil(totalPayable / durationDays);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + durationDays);

    // Mark active + record CFO approval. Guard on status to avoid double-disburse.
    const { data: updated, error: updErr } = await adminClient
      .from('credit_access_draws')
      .update({
        amount,
        duration_months: durationMonths,
        duration_days: durationDays,
        access_fee: accessFee,
        total_payable: totalPayable,
        daily_charge: dailyCharge,
        outstanding_balance: totalPayable,
        status: 'active',
        started_at: nowIso,
        expires_at: expiresAt.toISOString(),
        cfo_approved_by: approverId,
        cfo_approved_at: nowIso,
        cfo_notes: notes || null,
        updated_at: nowIso,
      })
      .eq('id', draw_id)
      .eq('status', 'pending_cfo')
      .select('id')
      .single();
    if (updErr || !updated) throw new Error('Draw already processed by another approver');

    // Disburse to the user's WITHDRAWABLE wallet via balanced ledger transaction.
    // recipient_type='user' routes the credit into the withdrawable bucket.
    const description = `Credit access (CFO-approved): UGX ${amount.toLocaleString()} for ${durationMonths} month(s)`;
    const { error: rpcErr } = await adminClient.rpc('create_ledger_transaction', {
      entries: [
        {
          ledger_scope: 'platform',
          direction: 'cash_out',
          amount,
          category: 'wallet_deposit',
          source_table: 'credit_access_draws',
          source_id: draw_id,
          description,
          currency: 'UGX',
          transaction_date: nowIso,
        },
        {
          user_id: draw.user_id,
          ledger_scope: 'wallet',
          direction: 'cash_in',
          amount,
          category: 'wallet_deposit',
          recipient_type: 'user',
          wallet_bucket: 'withdrawable',
          source_table: 'credit_access_draws',
          source_id: draw_id,
          description,
          currency: 'UGX',
          transaction_date: nowIso,
        },
      ],
    });
    if (rpcErr) throw rpcErr;

    // Fire-and-forget the audit write so the CFO's approve action returns as
    // soon as the money has actually moved (ledger posted above). The audit
    // row still lands; it just no longer blocks the response.
    adminClient.from('audit_logs').insert({
      user_id: approverId,
      action_type: 'cfo_credit_draw_approved',
      table_name: 'credit_access_draws',
      record_id: draw_id,
      reason: (notes || `cfo approved & disbursed credit draw`).slice(0, 200).padEnd(10, '.'),
      metadata: {
        requested_amount: Number(draw.requested_amount ?? draw.amount),
        approved_amount: amount,
        duration_months: durationMonths,
        access_fee: accessFee,
        total_payable: totalPayable,
        daily_charge: dailyCharge,
      },
    }).then(() => {}, (e: unknown) => console.error('[cfo-approve-credit-draw] audit insert failed:', e));

    fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({
        userIds: [draw.user_id],
        payload: { title: '✅ Credit Approved', body: `UGX ${amount.toLocaleString()} has been credited to your wallet.`, url: '/dashboard/tenant', type: 'success' },
      }),
    }).catch(() => {});

    return new Response(JSON.stringify({
      success: true,
      status: 'active',
      draw_id,
      amount,
      access_fee: accessFee,
      total_payable: totalPayable,
      daily_charge: dailyCharge,
      duration_months: durationMonths,
      expires_at: expiresAt.toISOString(),
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[cfo-approve-credit-draw] error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});