import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { logSystemEvent } from "../_shared/eventLogger.ts";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { guardCfoApprover } from "../_shared/cfoApprovalGate.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const RENT_FUNDED_BONUS = 5000; // UGX 5,000 flat bonus when rent is funded to landlord

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Verify caller
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing authorization')

    const anonClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authErr } = await anonClient.auth.getUser()
    if (authErr || !user) throw new Error('Unauthorized')

    // Verify CFO role
    const serviceClient = createClient(supabaseUrl, serviceKey)

    // Treasury guard: disbursement moves money — block when paused
    const guardBlock = await checkTreasuryGuard(serviceClient, "any", req.headers.get("Authorization"))
    if (guardBlock) return guardBlock
    // Only the Chief Finance Officer office or a designated super admin may disburse rent.
    // Role membership (cfo / manager / super_admin), enabled or disabled, no longer qualifies.
    const denied = await guardCfoApprover(serviceClient, user.id, corsHeaders)
    if (denied) return denied

    const { rent_request_id, transaction_reference, payout_method, notes } = await req.json()

    if (!rent_request_id || !transaction_reference) {
      throw new Error('rent_request_id and transaction_reference are required')
    }

    // Fetch the rent request
    const { data: request, error: reqErr } = await serviceClient
      .from('rent_requests')
      .select('id, tenant_id, agent_id, landlord_id, rent_amount, daily_repayment, duration_days, status, payout_method, assigned_agent_id')
      .eq('id', rent_request_id)
      .single()

    if (reqErr || !request) throw new Error('Rent request not found')
    if (!['coo_approved', 'funded'].includes(request.status)) throw new Error(`Invalid status: ${request.status}. Expected coo_approved or funded.`)

    // Determine the agent who should earn bonus (assigned > original)
    const bonusAgentId = request.assigned_agent_id || request.agent_id

    // Fetch landlord details
    const { data: landlord } = await serviceClient
      .from('landlords')
      .select('id, name, phone, mobile_money_number')
      .eq('id', request.landlord_id)
      .single()

    const method = payout_method || request.payout_method || 'cash'
    const now = new Date().toISOString()

    // Check if landlord has a wallet (profile exists)
    let landlordHasWallet = false
    if (landlord?.phone) {
      const { data: walletCheck } = await serviceClient
        .from('profiles')
        .select('id')
        .eq('phone', landlord.phone)
        .single()
      landlordHasWallet = !!walletCheck
    }

    // Update the rent request as funded/disbursed
    const { error: updateErr } = await serviceClient
      .from('rent_requests')
      .update({
        status: 'disbursed',
        payout_transaction_reference: transaction_reference,
        payout_method: method,
        cfo_reviewed_by: user.id,
        cfo_reviewed_at: now,
        funded_at: now,
        disbursed_at: now,
        approval_comment: notes || null,
        updated_at: now,
      })
      .eq('id', rent_request_id)

    if (updateErr) throw new Error(`Failed to update request: ${updateErr.message}`)

    // === TREASURY FEE RECOGNITION (idempotent; non-fatal) ===
    // Creates the L7 funding-side credit that later instalment waterfall drawdowns debit against.
    const { error: treasuryErr } = await serviceClient.rpc('recognise_funding_treasury', {
      p_rent_request_id: rent_request_id,
    });
    if (treasuryErr) {
      console.error('[disburse-rent-to-landlord] Treasury recognition failed (non-fatal):', treasuryErr.message);
    } else {
      console.log('[disburse-rent-to-landlord] Treasury recognition recorded for', rent_request_id);
    }

    // Record in disbursement_records for CFO tracking
    await serviceClient.from('disbursement_records').insert({
      rent_request_id: rent_request_id,
      tenant_id: request.tenant_id,
      landlord_id: request.landlord_id,
      agent_id: bonusAgentId || request.agent_id,
      amount: request.rent_amount,
      payout_method: method,
      transaction_reference: transaction_reference,
      disbursed_by: user.id,
      disbursed_at: now,
      reconciliation_status: 'pending',
      notes: notes || null,
    })

    // Record in general ledger — landlord payout via RPC
    const { data: transactionGroupId, error: disburseLedgerErr } = await serviceClient.rpc('create_ledger_transaction', {
      entries: [
        {
          direction: 'cash_out',
          amount: request.rent_amount,
          category: 'rent_disbursement',
          ledger_scope: 'platform',
          source_table: 'rent_requests',
          source_id: rent_request_id,
          description: `Rent paid to landlord ${landlord?.name || 'Unknown'} (${method}). Ref: ${transaction_reference}`,
          currency: 'UGX',
          user_id: request.tenant_id,
          linked_party: request.landlord_id,
          transaction_date: now,
        },
        {
          direction: 'cash_in',
          amount: request.rent_amount,
          category: 'rent_receivable_created',
          ledger_scope: 'bridge',
          source_table: 'rent_requests',
          source_id: rent_request_id,
          description: `Rent receivable created for tenant – landlord ${landlord?.name || 'Unknown'}`,
          currency: 'UGX',
          user_id: request.tenant_id,
          linked_party: request.landlord_id,
          transaction_date: now,
        },
      ],
    });

    // Update landlord rent tracking
    if (landlord) {
      await serviceClient
        .from('landlords')
        .update({
          rent_last_paid_at: now,
          rent_last_paid_amount: request.rent_amount,
        })
        .eq('id', landlord.id)
    }

    // ============================================================
    // AGENT BONUS: UGX 5,000 flat bonus for posting a rent request
    // that was successfully funded to the landlord.
    // The 5% recurring commission is earned on EACH rent repayment
    // via the credit_agent_rent_commission() database function.
    // ============================================================
    let bonusPaid = false

    if (bonusAgentId) {
      // Fetch agent name for audit trail
      const { data: agentProfile } = await serviceClient
        .from('profiles')
        .select('full_name')
        .eq('id', bonusAgentId)
        .single()

      const agentName = agentProfile?.full_name || 'Agent'

      // Credit UGX 5,000 flat bonus directly to agent wallet via RPC
      const { error: ledgerErr } = await serviceClient.rpc('create_ledger_transaction', {
        entries: [
          {
            user_id: bonusAgentId,
            amount: RENT_FUNDED_BONUS,
            direction: 'cash_in',
            category: 'agent_commission_earned',
            ledger_scope: 'wallet',
            source_table: 'rent_requests',
            source_id: rent_request_id,
            description: `UGX 5,000 rent funded bonus – landlord ${landlord?.name || 'Unknown'} paid via ${method}. Ref: ${transaction_reference}`,
            currency: 'UGX',
            linked_party: request.tenant_id,
            transaction_date: now,
          },
          {
            direction: 'cash_out',
            amount: RENT_FUNDED_BONUS,
            category: 'agent_commission_earned',
            ledger_scope: 'platform',
            source_table: 'rent_requests',
            source_id: rent_request_id,
            description: `Platform expense: rent funded bonus for agent`,
            currency: 'UGX',
            transaction_date: now,
          },
        ],
      })

      if (!ledgerErr) {
        bonusPaid = true

        // Record in agent_earnings for tracking
        await serviceClient.from('agent_earnings').insert({
          agent_id: bonusAgentId,
          amount: RENT_FUNDED_BONUS,
          earning_type: 'rent_funded_bonus',
          description: `UGX 5,000 bonus – rent funded to ${landlord?.name || 'Unknown'} (UGX ${request.rent_amount.toLocaleString()})`,
      currency: 'UGX',
          rent_request_id: rent_request_id,
          source_user_id: request.tenant_id,
        })

        // Notify agent
        await serviceClient.from('notifications').insert({
          user_id: bonusAgentId,
          title: 'Rent Funded Bonus! 🎉',
          message: `You earned UGX ${RENT_FUNDED_BONUS.toLocaleString()} bonus because rent for your tenant was paid to landlord ${landlord?.name || 'Unknown'}. You will also earn 5% on every repayment this tenant makes!`,
          type: 'earning',
          metadata: {
            amount: RENT_FUNDED_BONUS,
            type: 'rent_funded_bonus',
            rent_request_id,
            landlord_name: landlord?.name,
          },
        })
      } else {
        console.error('Failed to credit rent funded bonus:', ledgerErr.message)
      }
    }

    // ============================================================
    // EMAIL: Notify agent that landlord has been funded
    // Agent should go collect a physical receipt from landlord
    // ============================================================
    if (bonusAgentId) {
      const { data: agentEmailProfile } = await serviceClient
        .from('profiles')
        .select('email, full_name')
        .eq('id', bonusAgentId)
        .single()

      if (agentEmailProfile?.email) {
        const agentName = agentEmailProfile.full_name || 'Agent'
        const landlordName = landlord?.name || 'the landlord'
        const landlordPhone = landlord?.phone || 'N/A'
        const rentFormatted = `UGX ${request.rent_amount.toLocaleString()}`
        const dailyRepayment = request.daily_repayment ? `UGX ${request.daily_repayment.toLocaleString()}` : 'N/A'
        const durationDays = request.duration_days || 'N/A'

        const emailSubject = `✅ Landlord Funded – Please Collect Receipt | ${landlordName}`
        const emailBody = `Hi ${agentName},\n\nGreat news! The rent of ${rentFormatted} has been successfully disbursed to ${landlordName}.\n\n📋 ACTION REQUIRED:\nPlease visit ${landlordName} physically to collect a signed receipt confirming they received the rent payment.\n\n📞 Landlord Contact: ${landlordPhone}\n💳 Payout Method: ${method}\n🔖 Transaction Ref: ${transaction_reference}\n\n📊 TENANT REPAYMENT SCHEDULE:\n💵 Daily Repayment: ${dailyRepayment}/day\n📅 Duration: ${durationDays} days\n\n💰 Your Bonus: UGX ${RENT_FUNDED_BONUS.toLocaleString()} (already credited)\n\nRemember: You will also earn 10% commission on every repayment this tenant makes!\n\nThank you for your service.\n— Welile Team`

        try {
          await serviceClient.rpc("enqueue_email" as any, {
            p_queue_name: "transactional_emails",
            p_message: JSON.stringify({
              to: agentEmailProfile.email,
              subject: emailSubject,
              text: emailBody,
              template_name: "agent_disbursement_receipt",
            }),
          })
        } catch (emailErr) {
          console.warn('[disburse] Agent email enqueue failed:', emailErr)
        }
      }
    }

    // Record audit log
    await serviceClient.from('audit_logs').insert({
      user_id: user.id,
      action_type: 'rent_disbursement',
      table_name: 'rent_requests',
      record_id: rent_request_id,
      metadata: {
        rent_amount: request.rent_amount,
        landlord_name: landlord?.name,
        payout_method: method,
        transaction_reference,
        landlord_has_wallet: landlordHasWallet,
        bonus_agent_id: bonusAgentId,
        bonus_amount: RENT_FUNDED_BONUS,
        bonus_paid: bonusPaid,
        notes,
      },
    })


    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({ title: "🏠 Rent Disbursed", body: "Activity: rent disbursed", url: "/dashboard/manager" }),
    }).catch(() => {});

    // Push notification to tenant (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({
        userIds: [request.tenant_id],
        payload: { title: "🏠 Rent Disbursed", body: `UGX ${request.rent_amount.toLocaleString()} disbursed to ${landlord?.name || 'your landlord'}`, url: "/dashboard/tenant", type: "success" },
      }),
    }).catch(() => {});


    // Log system event
    logSystemEvent(serviceClient, 'rent_disbursed', user.id, 'rent_requests', rent_request_id, { rent_amount: request.rent_amount, landlord_id: request.landlord_id, payout_method: method });

    return new Response(
      JSON.stringify({
        success: true,
        message: `Rent of UGX ${request.rent_amount.toLocaleString()} disbursed to ${landlord?.name || 'landlord'} via ${method}`,
        payout_method: method,
        landlord_has_wallet: landlordHasWallet,
        transaction_reference,
        agent_bonus: {
          agent_id: bonusAgentId,
          amount: RENT_FUNDED_BONUS,
          paid: bonusPaid,
          note: 'Agent will also earn 5% on every future rent repayment',
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
