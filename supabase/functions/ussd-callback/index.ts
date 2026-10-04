import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Africa's Talking USSD callback handler
// Tenants AND Funders without smartphones can dial a shortcode to:
// 1. Check rent balance (tenants) / investment balance (funders)
// 2. Confirm a payment / view last return
// 3. Request help / escalate

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // The callback URL configured with the telecom provider includes the same
    // unguessable token as `?token=...`. Reject direct/spoofed POSTs before
    // trusting the submitted phone number or reading financial information.
    const expectedToken = Deno.env.get('USSD_CALLBACK_SECRET')
    const suppliedToken = new URL(req.url).searchParams.get('token') ?? ''
    if (!expectedToken || suppliedToken.length !== expectedToken.length) {
      return new Response('END Unauthorized request.', {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
      })
    }
    const expectedBytes = new TextEncoder().encode(expectedToken)
    const suppliedBytes = new TextEncoder().encode(suppliedToken)
    let mismatch = 0
    for (let i = 0; i < expectedBytes.length; i += 1) mismatch |= expectedBytes[i] ^ suppliedBytes[i]
    if (mismatch !== 0) {
      return new Response('END Unauthorized request.', {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
      })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const serviceClient = createClient(supabaseUrl, serviceKey)

    // Africa's Talking sends form-encoded data
    const formData = await req.formData()
    const sessionId = formData.get('sessionId') as string
    const serviceCode = formData.get('serviceCode') as string
    const phoneNumber = formData.get('phoneNumber') as string
    const text = formData.get('text') as string || ''

    // Normalize phone: +256... -> 0...
    const normalizedPhone = phoneNumber.startsWith('+256')
      ? '0' + phoneNumber.slice(4)
      : phoneNumber.startsWith('256')
        ? '0' + phoneNumber.slice(3)
        : phoneNumber

    // Find user by phone
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('id, full_name, phone')
      .or(`phone.eq.${normalizedPhone},phone.eq.${phoneNumber}`)
      .limit(1)
      .single()

    if (!profile) {
      return new Response('END Sorry, this phone number is not registered on Welile. Please ask your agent to register you.', {
        headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
      })
    }

    // Determine if user is a funder/supporter
    const { data: roles } = await serviceClient
      .from('user_roles')
      .select('role')
      .eq('user_id', profile.id)

    const userRoles = (roles || []).map(r => r.role)
    const isFunder = userRoles.includes('supporter')

    const textParts = text.split('*').filter(Boolean)
    const level = textParts.length

    // Level 0: Main menu — different for funders vs tenants
    if (level === 0) {
      if (isFunder) {
        const response = `CON Welcome to Welile, ${profile.full_name || 'Partner'}!
1. Investment Balance
2. Last Return Payment
3. Wallet Balance
4. Request Help`
        return new Response(response, {
          headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
        })
      } else {
        const response = `CON Welcome to Welile, ${profile.full_name || 'User'}!
1. Check Rent Balance
2. Last Payment
3. Request Help`
        return new Response(response, {
          headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
        })
      }
    }

    const choice = textParts[0]

    // ========================
    // FUNDER FLOW
    // ========================
    if (isFunder) {
      // Option 1: Investment Balance
      if (choice === '1') {
        const { data: portfolios } = await serviceClient
          .from('investor_portfolios')
          .select('amount_invested, total_roi_earned, status')
          .eq('user_id', profile.id)
          .in('status', ['active', 'matured'])

        if (!portfolios || portfolios.length === 0) {
          return new Response('END No active investments found. Contact your agent for more info.', {
            headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
          })
        }

        const totalInvested = portfolios.reduce((s, p) => s + (p.amount_invested || 0), 0)
        const totalROI = portfolios.reduce((s, p) => s + (p.total_roi_earned || 0), 0)
        const activeCount = portfolios.filter(p => p.status === 'active').length

        return new Response(`END Investment Summary:
Total Invested: UGX ${totalInvested.toLocaleString()}
Returns Earned: UGX ${totalROI.toLocaleString()}
Active Accounts: ${activeCount}
Your money is safe & working!`, {
          headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
        })
      }

      // Option 2: Last ROI payment
      if (choice === '2') {
        const { data: lastROI } = await serviceClient
          .from('supporter_roi_payments')
          .select('amount, paid_at')
          .eq('supporter_id', profile.id)
          .order('paid_at', { ascending: false })
          .limit(1)
          .single()

        if (!lastROI) {
          return new Response('END No return payments found yet. Returns are paid monthly. Contact your agent for details.', {
            headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
          })
        }

        const date = new Date(lastROI.paid_at)
        return new Response(`END Last Return Payment:
Amount: UGX ${(lastROI.amount || 0).toLocaleString()}
Date: ${date.toLocaleDateString('en-UG')}
Returns are credited monthly.`, {
          headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
        })
      }

      // Option 3: Wallet balance
      if (choice === '3') {
        const { data: wallet } = await serviceClient
          .from('wallets')
          .select('balance')
          .eq('user_id', profile.id)
          .maybeSingle()

        return new Response(`END Wallet Balance: UGX ${(wallet?.balance || 0).toLocaleString()}
To withdraw, contact your Welile agent.`, {
          headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
        })
      }

      // Option 4: Help
      if (choice === '4') {
        if (level === 1) {
          return new Response('CON What do you need help with?\n1. Missing returns\n2. Withdrawal request\n3. Speak to manager', {
            headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
          })
        }

        const helpChoice = textParts[1]
        const helpTypes: Record<string, string> = {
          '1': 'missing_returns',
          '2': 'withdrawal_request',
          '3': 'manager_request',
        }
        const escalationType = helpTypes[helpChoice] || 'general'

        // Find linked agent via proxy_agent_assignments
        const { data: proxyAssignment } = await serviceClient
          .from('proxy_agent_assignments')
          .select('agent_id')
          .eq('beneficiary_id', profile.id)
          .eq('is_active', true)
          .limit(1)
          .single()

        if (proxyAssignment?.agent_id) {
          await serviceClient.from('agent_escalations').insert({
            agent_id: proxyAssignment.agent_id,
            tenant_id: profile.id,
            title: `USSD Funder Help: ${escalationType.replace(/_/g, ' ')}`,
            description: `Funder ${profile.full_name} (${phoneNumber}) requested help via USSD. Type: ${escalationType}`,
            escalation_type: escalationType,
            severity: helpChoice === '3' ? 'high' : 'medium',
            metadata: { source: 'ussd_funder', session_id: sessionId, phone: phoneNumber },
          })
        }

        return new Response('END Your request has been submitted. Your Welile agent will contact you shortly. Thank you!', {
          headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
        })
      }

      return new Response('END Invalid option. Please dial again and select 1-4.', {
        headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
      })
    }

    // ========================
    // TENANT FLOW (existing)
    // ========================

    // Option 1: Check rent balance
    if (choice === '1') {
      const { data: rentReq } = await serviceClient
        .from('rent_requests')
        .select('rent_amount, total_repayment, amount_repaid, daily_repayment, duration_days, status')
        .eq('tenant_id', profile.id)
        .in('status', ['funded', 'disbursed', 'repaying'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      if (!rentReq) {
        return new Response('END You have no active rent balance. Contact your agent for more info.', {
          headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
        })
      }

      const remaining = (rentReq.total_repayment || 0) - (rentReq.amount_repaid || 0)
      const response = `END Rent Balance:
Rent: UGX ${(rentReq.rent_amount || 0).toLocaleString()}
Total Due: UGX ${(rentReq.total_repayment || 0).toLocaleString()}
Paid: UGX ${(rentReq.amount_repaid || 0).toLocaleString()}
Remaining: UGX ${remaining.toLocaleString()}
Daily: UGX ${(rentReq.daily_repayment || 0).toLocaleString()}/day`

      return new Response(response, {
        headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
      })
    }

    // Option 2: Last payment
    if (choice === '2') {
      const { data: lastPayment } = await serviceClient
        .from('general_ledger')
        .select('amount, created_at, description')
        .eq('user_id', profile.id)
        .eq('category', 'rent_repayment')
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      if (!lastPayment) {
        return new Response('END No recent payments found. Contact your agent for assistance.', {
          headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
        })
      }

      const date = new Date(lastPayment.created_at)
      const response = `END Last Payment:
Amount: UGX ${(lastPayment.amount || 0).toLocaleString()}
Date: ${date.toLocaleDateString('en-UG')}
Thank you for paying on time!`

      return new Response(response, {
        headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
      })
    }

    // Option 3: Request help
    if (choice === '3') {
      if (level === 1) {
        return new Response('CON What do you need help with?\n1. Agent not collecting\n2. Payment dispute\n3. Speak to manager', {
          headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
        })
      }

      const helpChoice = textParts[1]
      const helpTypes: Record<string, string> = {
        '1': 'agent_not_collecting',
        '2': 'payment_dispute',
        '3': 'manager_request',
      }

      const escalationType = helpTypes[helpChoice] || 'general'

      // Find linked agent
      const { data: rentReq } = await serviceClient
        .from('rent_requests')
        .select('agent_id, assigned_agent_id')
        .eq('tenant_id', profile.id)
        .in('status', ['funded', 'disbursed', 'repaying'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      const agentId = rentReq?.assigned_agent_id || rentReq?.agent_id

      if (agentId) {
        await serviceClient.from('agent_escalations').insert({
          agent_id: agentId,
          tenant_id: profile.id,
          title: `USSD Help Request: ${escalationType.replace(/_/g, ' ')}`,
          description: `Tenant ${profile.full_name} (${phoneNumber}) requested help via USSD shortcode. Type: ${escalationType}`,
          escalation_type: escalationType,
          severity: helpChoice === '3' ? 'high' : 'medium',
          metadata: { source: 'ussd', session_id: sessionId, phone: phoneNumber },
        })
      }

      return new Response('END Your request has been submitted. A Welile agent will contact you shortly. Thank you!', {
        headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
      })
    }

    // Invalid option
    return new Response('END Invalid option. Please dial again and select 1, 2, or 3.', {
      headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
    })

  } catch (err) {
    console.error('[ussd-callback] Error:', err)
    return new Response('END An error occurred. Please try again later.', {
      headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
    })
  }
})
