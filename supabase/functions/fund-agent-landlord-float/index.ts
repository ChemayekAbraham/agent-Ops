import { createClient } from 'npm:@supabase/supabase-js@2'
import { guardCfoApprover, cfoApproverDenied, isCfoApprover } from '../_shared/cfoApprovalGate.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}


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

    const serviceClient = createClient(supabaseUrl, serviceKey)

    // Verify CFO/manager/super_admin role
    const { data: roles } = await serviceClient
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .in('role', ['cfo', 'manager', 'super_admin'])
    if (!roles || roles.length === 0) throw new Error('Insufficient permissions')

    // Sole-CFO-approver gate: everyone else is read-only for approvals.
    const cfoGate = await guardCfoApprover(serviceClient, user.id, corsHeaders)
    if (cfoGate) return cfoGate

    const { rent_request_id, notes, transaction_reference, payout_method } = await req.json()
    if (!rent_request_id) throw new Error('rent_request_id is required')

    // Fetch the rent request
    const { data: request, error: reqErr } = await serviceClient
      .from('rent_requests')
      .select('id, tenant_id, agent_id, landlord_id, rent_amount, daily_repayment, duration_days, status, assigned_agent_id')
      .eq('id', rent_request_id)
      .single()

    if (reqErr || !request) throw new Error('Rent request not found')
    if (!['approved', 'coo_approved'].includes(request.status)) {
      // Idempotency guard: refuse to re-fund. A duplicate click on "Batch: landlord float"
      // used to double- or quadruple-fund the agent's float (see RR d723bc4d incident,
      // 2026-07-29). Once status='funded' this endpoint is a no-op.
      if (request.status === 'funded') {
        return new Response(
          JSON.stringify({
            success: false,
            already_funded: true,
            error: 'This rent request is already funded. Refusing to re-fund.',
          }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }
      throw new Error(`Invalid status: ${request.status}. Expected approved or coo_approved.`)
    }

    const bonusAgentId = request.assigned_agent_id || request.agent_id
    if (!bonusAgentId) throw new Error('No agent assigned to this rent request')

    // Fetch landlord details
    const { data: landlord } = await serviceClient
      .from('landlords')
      .select('id, name, phone, mobile_money_number')
      .eq('id', request.landlord_id)
      .single()

    const now = new Date().toISOString()

    // Create the live per-request allocation BEFORE mutating balances. The
    // table has a unique live-allocation guard, so duplicate/batched clicks fail
    // here and cannot inflate an agent's landlord float again.
    const { data: existingAllocation } = await serviceClient
      .from('agent_landlord_float_allocations')
      .select('id, agent_id, status')
      .eq('rent_request_id', rent_request_id)
      .eq('source', 'cfo_disbursement')
      .in('status', ['open', 'partially_paid'])
      .maybeSingle()

    // A previous attempt may have inserted the allocation and then failed later
    // (e.g. a trigger error while flipping the request to 'funded'). In that case
    // the request is still approved/coo_approved, so we RESUME with the existing
    // allocation instead of blocking the CFO with a 409.
    if (existingAllocation && existingAllocation.agent_id !== bonusAgentId) {
      return new Response(
        JSON.stringify({
          success: false,
          already_funded: true,
          error: 'This rent request already has live landlord float allocated. Refusing to re-fund.',
        }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const { data: allocation, error: allocationInsertErr } = existingAllocation
      ? { data: { id: existingAllocation.id }, error: null as any }
      : await serviceClient
      .from('agent_landlord_float_allocations')
      .insert({
        agent_id: bonusAgentId,
        tenant_id: request.tenant_id,
        rent_request_id,
        landlord_id: request.landlord_id,
        landlord_name: landlord?.name || 'Unknown Landlord',
        landlord_phone: landlord?.mobile_money_number || landlord?.phone || null,
        allocated_amount: request.rent_amount,
        source: 'cfo_disbursement',
      })
      .select('id')
      .single()

    if (allocationInsertErr) {
      if (allocationInsertErr.code === '23505') {
        return new Response(
          JSON.stringify({
            success: false,
            already_funded: true,
            error: 'This rent request already has live landlord float allocated. Refusing to re-fund.',
          }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }
      throw new Error(`Failed to create landlord float allocation: ${allocationInsertErr.message}`)
    }

    // ============================================================
    // FUND AGENT'S LANDLORD FLOAT (no TID required at this stage)
    //
    // The balance is NOT written here any more. Since 2026-07-30
    // `agent_landlord_float.balance` is derived from the allocation rows by
    // `trg_sync_landlord_float_from_allocation`, so inserting the allocation
    // above has already credited exactly the right amount. Writing it here as
    // well (plus the old agent_float_funding trigger) is what double- and
    // quadruple-credited agent floats. Only the lifetime `total_funded`
    // counter is incremented.
    // ============================================================
    const { data: existingFloat } = await serviceClient
      .from('agent_landlord_float')
      .select('id, balance, total_funded')
      .eq('agent_id', bonusAgentId)
      .maybeSingle()

    if (existingFloat && !existingAllocation) {
      const { error: floatErr } = await serviceClient
        .from('agent_landlord_float')
        .update({
          total_funded: (existingFloat.total_funded || 0) + request.rent_amount,
          updated_at: now,
        })
        .eq('id', existingFloat.id)

      if (floatErr) {
        if (allocation?.id) {
          await serviceClient
            .from('agent_landlord_float_allocations')
            .update({ status: 'cancelled', updated_at: now })
            .eq('id', allocation.id)
        }
        throw new Error(`Failed to update agent float: ${floatErr.message}`)
      }
    } else if (!existingFloat) {
      const { error: insertErr } = await serviceClient
        .from('agent_landlord_float')
        .insert({
          agent_id: bonusAgentId,
          balance: request.rent_amount,
          total_funded: request.rent_amount,
          total_paid_out: 0,
        })

      // 23505 = the allocation trigger already created the float row with the
      // correct derived balance; that is the expected happy path.
      if (insertErr && insertErr.code !== '23505') {
        if (allocation?.id) {
          await serviceClient
            .from('agent_landlord_float_allocations')
            .update({ status: 'cancelled', updated_at: now })
            .eq('id', allocation.id)
        }
        throw new Error(`Failed to create agent float: ${insertErr.message}`)
      }
    }

    // Update rent request status to 'funded'
    const { error: updateErr } = await serviceClient
      .from('rent_requests')
      .update({
        status: 'funded',
        cfo_reviewed_by: user.id,
        cfo_reviewed_at: now,
        funded_at: now,
        approval_comment: notes || null,
        payout_transaction_reference: transaction_reference || null,
        payout_method: payout_method || null,
        updated_at: now,
      })
      .eq('id', rent_request_id)

    if (updateErr) {
      // Business guards raised by DB triggers (e.g. LANDLORD_NOT_VERIFIED) should reach
      // the operator as plain, actionable text — not wrapped in internal prefixes.
      const raw = updateErr.message || 'Unknown error'
      const guard = raw.match(/LANDLORD_NOT_VERIFIED:\s*(.+)$/)
      if (guard) throw new Error(guard[1].trim())
      throw new Error(`Failed to update request: ${raw}`)
    }

    // Record agent_float_funding so it shows in the agent's float history.
    // `rent_request_id` carries a unique index for active rows, so a retry can
    // never write a second funding record for the same rent request.
    const { error: fundingErr } = await serviceClient.from('agent_float_funding').insert({
      agent_id: bonusAgentId,
      amount: request.rent_amount,
      funded_by: user.id,
      rent_request_id,
      notes: `CFO funded rent for landlord ${landlord?.name || 'Unknown'} – Request: ${rent_request_id.slice(0, 8)}`,
    })
    if (fundingErr && fundingErr.code !== '23505') {
      console.warn('[fund-float] funding history insert failed:', fundingErr.message)
    }

    // Record in general ledger via RPC — platform cash out to agent float
    const { data: transactionGroupId, error: floatLedgerErr } = await serviceClient.rpc('create_ledger_transaction', {
      entries: [
        {
          direction: 'cash_out',
          amount: request.rent_amount,
          category: 'rent_disbursement',
          ledger_scope: 'platform',
          source_table: 'rent_requests',
          source_id: rent_request_id,
          description: `Rent float funded for agent to pay landlord ${landlord?.name || 'Unknown'}. Request: ${rent_request_id.slice(0, 8)}`,
          currency: 'UGX',
          user_id: bonusAgentId,
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
          description: `Landlord float credited – ${landlord?.name || 'Unknown'} (UGX ${request.rent_amount.toLocaleString()})`,
          currency: 'UGX',
          user_id: bonusAgentId,
          linked_party: request.landlord_id,
          transaction_date: now,
        },
      ],
      idempotency_key: `fund-agent-landlord-float:${rent_request_id}:float`,
    });

    // ============================================================
    // LANDLORD FLOW TREASURY RECOGNITION (Phase 2)
    //
    // The legs above recognise the PRINCIPAL only: DR A3 / CR A1. But the tenant
    // owes total_repayment = principal + access fee + registration fee, and the
    // repayment waterfall credits A3 for the WHOLE instalment. Without a fee
    // receivable recognised here, A3 would be over-credited by exactly
    // (access + registration) over the life of the plan.
    //
    //   DR A3  bridge.fee_receivable_created    = access + registration
    //   CR L7  platform.treasury_fee_recognised = access + registration
    //
    // No cash moves: A1/A2/A5 are untouched. L7 is an accounting designation,
    // not a second cash account. No L3 payable is created — the 15% Partner
    // Reward stays allocation-only (BD-2).
    //
    // This ALSO establishes the L7 credit that the repayment waterfall later
    // draws down. assert_funding_treasury_recognised() enforces that ordering,
    // so a repayment cannot silently push L7 into an unexplained debit.
    //
    // Idempotent on rent_request_id; a retry returns 'already_recognised'.
    // Non-fatal: funding must not fail because a reporting entry did not post.
    const { data: treasuryRecognition, error: treasuryErr } = await serviceClient.rpc(
      'recognise_funding_treasury',
      { p_rent_request_id: rent_request_id },
    )
    if (treasuryErr) {
      console.error('[fund-float] Treasury recognition failed:', treasuryErr.message,
                    'rent_request:', rent_request_id)
    } else {
      console.log('[fund-float] Treasury recognition:', JSON.stringify(treasuryRecognition))
    }

    // ============================================================
    // LANDLORD FLOAT POOL — company-managed draw.
    //
    // The rent_disbursement group above is unchanged (CR A1). This draws the
    // same amount out of the company-managed pool (CR A22 / DR A1) beside it,
    // oldest money first, so the tenant is funded from partner money that was
    // reserved for landlords. Whatever the pool cannot cover stays funded by
    // plain treasury — which is what rent_disbursement already recorded.
    //
    // No-op while the pool is off. Idempotent per rent request. Non-fatal:
    // the landlord float has been credited; a failed draw is filed for replay.
    if (!floatLedgerErr) {
      const { data: poolDraw, error: poolErr } = await serviceClient.rpc('landlord_pool_deploy', {
        p_rent_request_id: rent_request_id,
        p_amount: request.rent_amount,
        p_origin: 'company_managed',
        p_allocation_id: allocation?.id ?? null,
        p_pool_entry_id: null,
        p_caller: 'fund-agent-landlord-float',
      })
      if (poolErr) {
        console.error('[fund-float] Landlord pool draw failed:', poolErr.message, 'rent_request:', rent_request_id)
        await serviceClient.from('landlord_pool_exceptions').insert({
          operation: 'deploy',
          caller: 'fund-agent-landlord-float',
          reason: poolErr.message,
          detail: { rent_request_id, amount: request.rent_amount, allocation_id: allocation?.id ?? null },
        })
      } else {
        console.log('[fund-float] Landlord pool draw:', JSON.stringify(poolDraw))
      }
    }

    // ============================================================
    // NO BONUS IS PAID HERE.
    //
    // Funding the landlord float used to pay the agent twice — a flat UGX
    // 5,000 posted inline here, and UGX 10,000 from
    // trg_credit_agent_rent_funded_bonus, neither aware of the other. Both are
    // removed as of Phase 1 (see docs/rent-plan-new-flow-full-report.md §2).
    //
    // The agent now earns at the point the work is actually done: 1% of the
    // payout when the landlord float leaves their wallet, posted by
    // post_landlord_payout_finops_commission. Do not reinstate a payment here.
    // ============================================================
    const { data: agentProfile } = await serviceClient
      .from('profiles')
      .select('full_name, email')
      .eq('id', bonusAgentId)
      .single()

    const agentName = agentProfile?.full_name || 'Agent'

    // The agent still has to be told the float arrived and that paying the
    // landlord is now their next action.
    await serviceClient.from('notifications').insert({
      user_id: bonusAgentId,
      title: 'Landlord float is in your wallet',
      message: `UGX ${request.rent_amount.toLocaleString()} has been added to your landlord float to pay ${landlord?.name || 'Unknown'}. Please pay the landlord and submit the TID and receipt.`,
      type: 'float',
      metadata: {
        float_amount: request.rent_amount,
        type: 'landlord_float_funded',
        rent_request_id,
        landlord_name: landlord?.name,
      },
    })

    // Branded transactional email to the agent — uses the
    // `agent-landlord-float-funded` React Email template.
    if (agentProfile?.email) {
      try {
        // Try to fetch tenant name (optional, non-fatal)
        let tenantName: string | undefined
        if (request.tenant_id) {
          const { data: tenantProfile } = await serviceClient
            .from('profiles')
            .select('full_name')
            .eq('id', request.tenant_id)
            .maybeSingle()
          tenantName = tenantProfile?.full_name || undefined
        }

        const todayLabel = new Date().toLocaleDateString('en-GB', {
          day: '2-digit', month: 'long', year: 'numeric',
        })

        await fetch(`${supabaseUrl}/functions/v1/send-transactional-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            templateName: 'agent-landlord-float-funded',
            recipientEmail: agentProfile.email,
            idempotencyKey: `agent-landlord-float-funded-${rent_request_id}`,
            templateData: {
              agent_name: agentName,
              landlord_name: landlord?.name || 'the landlord',
              landlord_phone: landlord?.phone || landlord?.mobile_money_number || '',
              tenant_name: tenantName || '',
              amount: request.rent_amount,
              currency: 'UGX',
              date: todayLabel,
              rent_request_ref: rent_request_id.slice(0, 8).toUpperCase(),
              daily_repayment: request.daily_repayment || '',
              duration_days: request.duration_days || '',
              bonus_amount: '',
              withdraw_url: 'https://welileapp.com/dashboard/agent',
              company_name: 'Welile',
              logo_url: 'https://welileapp.com/welile-logo.png',
            },
          }),
        })
      } catch (emailErr) {
        console.warn('[fund-float] Agent branded email send failed:', emailErr)
      }
    }

    // Audit log
    await serviceClient.from('audit_logs').insert({
      user_id: user.id,
      action_type: 'rent_float_funding',
      table_name: 'rent_requests',
      record_id: rent_request_id,
      metadata: {
        rent_amount: request.rent_amount,
        landlord_name: landlord?.name,
        agent_id: bonusAgentId,
        agent_name: agentName,
        bonus_amount: 0,
        bonus_paid: false,
        notes,
      },
    })


    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({ title: "🏦 Float Funded", body: "Activity: agent float funded", url: "/dashboard/manager" }),
    }).catch(() => {});


    return new Response(
      JSON.stringify({
        success: true,
        message: `UGX ${request.rent_amount.toLocaleString()} funded to ${agentName}'s landlord float for ${landlord?.name || 'landlord'}`,
        agent_id: bonusAgentId,
        float_funded: request.rent_amount,
        agent_bonus: { amount: 0, paid: false },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('[fund-agent-landlord-float] failed:', err?.message, err)
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
