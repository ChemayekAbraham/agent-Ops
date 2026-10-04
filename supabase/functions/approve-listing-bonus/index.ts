import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardCfoApprover, cfoApproverDenied, isCfoApprover } from '../_shared/cfoApprovalGate.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

const LISTING_BONUS = 4000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing authorization')

    const anonClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authErr } = await anonClient.auth.getUser()
    if (authErr || !user) throw new Error('Unauthorized')

    // Verify CFO role
    const serviceClient = createClient(supabaseUrl, serviceKey)
    const { data: roles } = await serviceClient
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .in('role', ['cfo', 'manager', 'super_admin'])

    if (!roles || roles.length === 0) throw new Error('Only CFO/Manager can approve listing bonuses')

    // Sole-CFO-approver gate: everyone else is read-only for approvals.
    const cfoGate = await guardCfoApprover(serviceClient, user.id, corsHeaders)
    if (cfoGate) return cfoGate

    const { approval_id, action, notes } = await req.json()

    if (!approval_id) throw new Error('approval_id is required')
    if (!action || !['approve', 'reject'].includes(action)) throw new Error('action must be approve or reject')

    // Fetch the approval record
    const { data: approval, error: approvalErr } = await serviceClient
      .from('listing_bonus_approvals')
      .select('*')
      .eq('id', approval_id)
      .single()

    if (approvalErr || !approval) throw new Error('Approval record not found')
    if (approval.status !== 'pending_cfo') throw new Error(`Cannot ${action}: current status is ${approval.status}`)

    const now = new Date().toISOString()

    if (action === 'reject') {
      await serviceClient
        .from('listing_bonus_approvals')
        .update({
          status: 'rejected',
          rejected_by: user.id,
          rejected_at: now,
          rejection_reason: notes || 'Rejected by CFO',
        })
        .eq('id', approval_id)

      // Notify agent
      await serviceClient.from('notifications').insert({
        user_id: approval.agent_id,
        title: 'Listing Bonus Rejected',
        message: `Your UGX ${LISTING_BONUS.toLocaleString()} listing bonus was not approved. Reason: ${notes || 'Not specified'}`,
        type: 'warning',
        metadata: { approval_id, reason: notes },
      })

      await serviceClient.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'listing_bonus_rejected',
        table_name: 'listing_bonus_approvals',
        record_id: approval_id,
        metadata: { agent_id: approval.agent_id, reason: notes || 'Rejected by CFO' },
      })

      return new Response(JSON.stringify({ success: true, action: 'rejected' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // APPROVE: Credit agent wallet via RPC as balanced entry
    // Idempotency: keyed on the approval id so a retry between the ledger post
    // and the status update can never credit the agent twice.
    const { data: txGroupId, error: ledgerErr } = await serviceClient.rpc('create_ledger_transaction', {
      entries: [
        {
          user_id: approval.agent_id,
          amount: approval.amount,
          direction: 'cash_in',
          category: 'agent_commission_earned',
          ledger_scope: 'wallet',
          source_table: 'listing_bonus_approvals',
          source_id: approval_id,
          description: `UGX ${approval.amount.toLocaleString()} house listing bonus`,
          currency: 'UGX',
          transaction_date: now,
        },
        {
          direction: 'cash_out',
          amount: approval.amount,
          category: 'agent_commission_earned',
          ledger_scope: 'platform',
          source_table: 'listing_bonus_approvals',
          source_id: approval_id,
          description: `Platform expense: agent listing bonus for house registration`,
          currency: 'UGX',
          transaction_date: now,
        },
      ],
      idempotency_key: `listing_bonus_approval:${approval_id}`,
    })

    if (ledgerErr) throw new Error(`Ledger credit failed: ${ledgerErr.message}`)

    // Update approval record
    await serviceClient
      .from('listing_bonus_approvals')
      .update({
        status: 'paid',
        cfo_approved_by: user.id,
        cfo_approved_at: now,
        cfo_notes: notes || 'Approved by CFO',
        paid_at: now,
      })
      .eq('id', approval_id)

    // Mark listing as bonus paid
    await serviceClient
      .from('house_listings')
      .update({
        listing_bonus_paid: true,
        listing_bonus_paid_at: now,
      })
      .eq('id', approval.listing_id)

    // Record in agent_earnings
    await serviceClient.from('agent_earnings').insert({
      agent_id: approval.agent_id,
      amount: approval.amount,
      earning_type: 'listing_bonus',
      source_user_id: user.id,
      description: `House listing bonus (CFO approved)`,
      currency: 'UGX',
    })

    // Notify agent
    await serviceClient.from('notifications').insert({
      user_id: approval.agent_id,
      title: 'Listing Bonus Paid! 💰',
      message: `UGX ${approval.amount.toLocaleString()} listing bonus has been approved and credited to your wallet!`,
      type: 'earning',
      metadata: { approval_id, amount: approval.amount },
    })

    // Audit log
    await serviceClient.from('audit_logs').insert({
      user_id: user.id,
      action_type: 'listing_bonus_approved',
      table_name: 'listing_bonus_approvals',
      record_id: approval_id,
      metadata: {
        agent_id: approval.agent_id,
        amount: approval.amount,
        tx_group_id: txGroupId,
        reason: notes || 'CFO approved listing bonus as platform expense',
      },
    })


    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({ title: "🏡 Listing Bonus Approved", body: "Activity: listing bonus approved", url: "/dashboard/manager" }),
    }).catch(() => {});


    return new Response(JSON.stringify({
      success: true,
      action: 'approved',
      amount: approval.amount,
      agent_id: approval.agent_id,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
