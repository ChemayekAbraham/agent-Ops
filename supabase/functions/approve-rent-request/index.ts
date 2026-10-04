import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { logSystemEvent } from "../_shared/eventLogger.ts";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Staged agent rewards are now paid by DB triggers + funding edge functions.

// --- SMS Helper (Africa's Talking) ---
function formatPhoneInternational(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

function isUgandanPhone(phone: string): boolean {
  const formatted = formatPhoneInternational(phone);
  return formatted.startsWith("+256") && formatted.length >= 13;
}

async function sendSMS(phone: string, message: string): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "approve-rent-request" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.log("[approve-rent-request] Missing AT credentials, skipping SMS");
    return false;
  }
  if (!isUgandanPhone(phone)) {
    console.log(`[approve-rent-request] Non-UG phone ${phone}, skipping SMS`);
    return false;
  }

  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";

  const formattedPhone = formatPhoneInternational(phone);
  try {
    const body = new URLSearchParams({ username, from: "WELILE", to: formattedPhone, message });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", apiKey, Accept: "application/json" },
      body: body.toString(),
    });
    const data = await res.json();
    const recipients = data?.SMSMessageData?.Recipients || [];
    const success = recipients.some((r: any) => r.statusCode === 101 || r.statusCode === 100);
    console.log(`[approve-rent-request] SMS to ${formattedPhone}: ${success ? "sent" : "failed"}`);
    return success;
  } catch (err) {
    console.error("[approve-rent-request] SMS error:", err);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'No authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    const token = authHeader.replace('Bearer ', '');
    const { data: claimsData, error: claimsError } = await supabase.auth.getUser(token);
    if (claimsError || !claimsData?.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized', details: claimsError?.message }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const approverId = claimsData.user.id;
    const { rent_request_id, action, approval_comment } = await req.json();
    const requestAction = action || 'approve';

    console.log(`User ${approverId} ${requestAction} rent request ${rent_request_id}`);

    if (!rent_request_id) {
      return new Response(JSON.stringify({ error: 'Invalid request parameters' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Check roles
    const { data: userRoles } = await adminClient.from('user_roles').select('role').eq('user_id', approverId);
    const roles = userRoles?.map(r => r.role) || [];
    const isManager = roles.includes('manager');
    const isAgent = roles.includes('agent');

    if (!isManager && !isAgent) {
      return new Response(JSON.stringify({ error: 'Only managers and agents can approve/reject requests' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Get rent request
    const { data: rentRequest, error: requestError } = await adminClient
      .from('rent_requests').select('*').eq('id', rent_request_id).single();

    if (requestError || !rentRequest) {
      return new Response(JSON.stringify({ error: 'Rent request not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (rentRequest.status !== 'pending') {
      return new Response(JSON.stringify({ error: 'Request is not pending' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // === GATE: landlord must be verified before approval ===
    if (requestAction === 'approve') {
      if (!rentRequest.landlord_id) {
        return new Response(
          JSON.stringify({ error: 'This rent request has no landlord attached. Attach and verify the landlord first.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      const { data: landlord } = await adminClient
        .from('landlords')
        .select('id, full_name, name, verified')
        .eq('id', rentRequest.landlord_id)
        .single();
      if (!landlord || landlord.verified !== true) {
        const name = landlord?.full_name || landlord?.name || 'the landlord';
        return new Response(
          JSON.stringify({
            error: `Landlord ${name} is not yet verified. Verify the landlord in Landlord Ops before approving this rent request.`,
            code: 'LANDLORD_NOT_VERIFIED',
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Fetch tenant profile (needed for SMS + notifications)
    const { data: tenantProfile } = await adminClient
      .from('profiles').select('full_name, phone').eq('id', rentRequest.tenant_id).single();

    const tenantName = tenantProfile?.full_name || 'Tenant';
    const tenantPhone = tenantProfile?.phone || '';

    // Fetch agent profile if exists
    let agentName = '';
    let agentPhone = '';
    if (rentRequest.agent_id) {
      const { data: agentProfile } = await adminClient
        .from('profiles').select('full_name, phone').eq('id', rentRequest.agent_id).single();
      agentName = agentProfile?.full_name || 'Agent';
      agentPhone = agentProfile?.phone || '';
    }

    if (requestAction === 'approve') {
      const now = new Date().toISOString();

      // Update rent request
      const { error: updateError } = await adminClient
        .from('rent_requests')
        .update({
          status: 'approved', approved_by: approverId, approved_at: now,
          approval_comment: approval_comment || null, funded_at: now, schedule_status: 'active',
        })
        .eq('id', rent_request_id);

      if (updateError) throw updateError;

      // === TREASURY FEE RECOGNITION (idempotent; non-fatal) ===
      // Creates the L7 funding-side credit that later instalment waterfall drawdowns debit against.
      const { error: treasuryErr } = await adminClient.rpc('recognise_funding_treasury', {
        p_rent_request_id: rent_request_id,
      });
      if (treasuryErr) {
        console.error('[approve-rent-request] Treasury recognition failed (non-fatal):', treasuryErr.message);
      } else {
        console.log('[approve-rent-request] Treasury recognition recorded for', rent_request_id);
      }

      // === AUTO-CREATE SUBSCRIPTION CHARGE ===
      // Re-derive from canonical formula in case the row predates the
      // enforce_rent_request_formula trigger. Trigger-protected rows already
      // match these values exactly.
      const durationDays = Number(rentRequest.duration_days);
      const rentAmount = Number(rentRequest.rent_amount);
      let totalRepayment = Number(rentRequest.total_repayment);
      let dailyRepayment = Number(rentRequest.daily_repayment);
      try {
        const { data: canon } = await adminClient.rpc('compute_rent_repayment', {
          p_rent_amount: rentAmount,
          p_duration_days: durationDays,
        });
        if (canon && Array.isArray(canon) && canon.length > 0) {
          totalRepayment = Number(canon[0].total_repayment) || totalRepayment;
          dailyRepayment = Number(canon[0].daily_repayment) || dailyRepayment;
        }
      } catch (e) {
        console.warn('[approve-rent-request] compute_rent_repayment fallback:', e);
      }

      if (totalRepayment > 0 && durationDays > 0) {
        let frequency = "daily";
        let chargeAmount = dailyRepayment > 0 ? dailyRepayment : Math.ceil(totalRepayment / durationDays);
        let totalCharges = durationDays;

        if (durationDays <= 30 && dailyRepayment > 0) {
          frequency = "daily";
          chargeAmount = Math.round(dailyRepayment);
          totalCharges = durationDays;
        } else if (durationDays <= 21) {
          frequency = "weekly";
          totalCharges = Math.ceil(durationDays / 7);
          chargeAmount = Math.round(totalRepayment / totalCharges);
        } else if (durationDays > 30) {
          frequency = "daily";
          chargeAmount = Math.round(dailyRepayment > 0 ? dailyRepayment : totalRepayment / durationDays);
          totalCharges = durationDays;
        }

        const startDate = new Date();
        const nextChargeDate = new Date(startDate);
        if (frequency === "daily") nextChargeDate.setDate(nextChargeDate.getDate() + 1);
        else if (frequency === "weekly") nextChargeDate.setDate(nextChargeDate.getDate() + 7);
        else nextChargeDate.setMonth(nextChargeDate.getMonth() + 1);

        // === Outstanding-balance grace period ===
        // For tenants registered with arrears who still have N days left on their
        // CURRENT rent period, defer the first arrears charge so they aren't
        // double-billed (current rent period + arrears collection at the same time).
        // Billing model: arrears-only over duration_days. Recurring rent resumes
        // via a separate rent_request after the arrears subscription completes.
        const graceDays = Number(rentRequest.outstanding_grace_days || 0);
        const isOutstandingArrears = rentRequest.registration_type === 'outstanding_balance';
        if (isOutstandingArrears && graceDays > 0) {
          const deferred = new Date(startDate);
          deferred.setDate(deferred.getDate() + graceDays);
          nextChargeDate.setTime(deferred.getTime());
          console.log(`[approve-rent-request] Outstanding arrears: deferring first charge by ${graceDays} day(s) to ${nextChargeDate.toISOString().split('T')[0]}`);
        }

        const endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + durationDays + (isOutstandingArrears ? graceDays : 0));

        const { error: subError } = await adminClient.from("subscription_charges").insert({
          tenant_id: rentRequest.tenant_id,
          rent_request_id: rent_request_id,
          agent_id: rentRequest.agent_id || null,
          service_type: "rent_facilitation",
          charge_amount: chargeAmount,
          frequency,
          next_charge_date: nextChargeDate.toISOString().split("T")[0],
          start_date: startDate.toISOString().split("T")[0],
          end_date: endDate.toISOString().split("T")[0],
          total_charges_due: totalRepayment,
          charges_remaining: totalCharges,
          status: "active",
          charge_agent_wallet: rentRequest.tenant_no_smartphone === true,
        });

        if (subError) {
          console.error("Error creating subscription charge:", subError.message);
        } else {
          console.log(`Created subscription: ${frequency} @ UGX ${chargeAmount} for ${totalCharges} charges`);

          await adminClient.from("notifications").insert({
            user_id: rentRequest.tenant_id,
            title: isOutstandingArrears
              ? "📅 Arrears Plan Activated"
              : "📅 Repayment Schedule Active",
            message: isOutstandingArrears
              ? `Your arrears plan is active. Daily charges of UGX ${chargeAmount.toLocaleString()} will start on ${nextChargeDate.toLocaleDateString()}${graceDays > 0 ? ` (after your current rent period of ${graceDays} day(s))` : ''}. Total arrears: UGX ${totalRepayment.toLocaleString()} over ${totalCharges} days.`
              : `Your wallet will be auto-charged UGX ${chargeAmount.toLocaleString()} ${frequency} starting ${nextChargeDate.toLocaleDateString()}. Total: UGX ${totalRepayment.toLocaleString()} over ${totalCharges} payments.`,
            type: "info",
            metadata: { rent_request_id, frequency, charge_amount: chargeAmount, total_charges: totalCharges, outstanding_grace_days: isOutstandingArrears ? graceDays : null },
          });
        }
      }

      // NOTE: Tenant obligation is tracked via rent_receivable_created in the bridge scope
      // when the rent is funded/disbursed. No direct ledger insert needed here.

      // === AGENT REWARDS ===
      // Staged agent rewards (UGX 1,000 on posting with a listed house, UGX 4,000 on
      // landlord verification, UGX 5,000 on funding to the agent's landlord float) are
      // now paid automatically by database triggers and the funding edge functions.
      // No approval-time bonus is paid here anymore.

      // === IN-APP NOTIFICATIONS ===
      // Tenant approval notification
      await adminClient.from('notifications').insert({
        user_id: rentRequest.tenant_id,
        title: 'Rent Request Approved!',
        message: `Your rent request for UGX ${rentRequest.rent_amount.toLocaleString()} has been approved. Auto-deductions will begin shortly.${approval_comment ? ` Note: ${approval_comment}` : ''}`,
        type: 'success',
      });

      // Agent approval notification (separate from bonus)
      if (rentRequest.agent_id) {
        await adminClient.from('notifications').insert({
          user_id: rentRequest.agent_id,
          title: '✅ Rent Approved',
          message: `${tenantName}'s rent request for UGX ${rentRequest.rent_amount.toLocaleString()} has been approved and funded.`,
          type: 'success',
          metadata: { rent_request_id, tenant_id: rentRequest.tenant_id },
        });
      }

      // === SMS NOTIFICATIONS (fire-and-forget) ===
      const smsPromises: Promise<boolean>[] = [];

      // Tenant SMS
      if (tenantPhone) {
        const dailyAmt = dailyRepayment > 0 ? dailyRepayment : Math.ceil(totalRepayment / durationDays);
        const tenantMsg = `WELILE: Your rent of UGX ${Number(rentRequest.rent_amount).toLocaleString()} has been approved and will be paid to your landlord. Repayment of UGX ${dailyAmt.toLocaleString()}/day starts tomorrow. Ref: ${rent_request_id.slice(0, 8)}`;
        smsPromises.push(sendSMS(tenantPhone, tenantMsg));
      }

      // Agent SMS
      if (rentRequest.agent_id && agentPhone) {
        const agentMsg = `WELILE: Rent request for ${tenantName} (UGX ${Number(rentRequest.rent_amount).toLocaleString()}) has been approved.`;
        smsPromises.push(sendSMS(agentPhone, agentMsg));
      }

      // Don't await — fire and forget
      Promise.all(smsPromises).catch(e => console.error("SMS batch error:", e));

      // Log system event
      logSystemEvent(adminClient, 'rent_request_approved', approverId, 'rent_requests', rent_request_id, { rent_amount: rentRequest.rent_amount, tenant_id: rentRequest.tenant_id });

      return new Response(
        JSON.stringify({
          success: true,
          message: 'Rent request approved with auto-charge subscription created',
          agent_bonus_paid: 0,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } else if (requestAction === 'reject') {
      const { error: rejectError } = await adminClient
        .from('rent_requests').update({ status: 'rejected' }).eq('id', rent_request_id);

      if (rejectError) throw rejectError;

      // Tenant in-app notification
      await adminClient.from('notifications').insert({
        user_id: rentRequest.tenant_id,
        title: 'Rent Request Rejected',
        message: `Your rent request for UGX ${rentRequest.rent_amount.toLocaleString()} was not approved.`,
        type: 'info',
      });

      // Agent in-app notification
      if (rentRequest.agent_id) {
        await adminClient.from('notifications').insert({
          user_id: rentRequest.agent_id,
          title: '❌ Rent Request Rejected',
          message: `${tenantName}'s rent request for UGX ${rentRequest.rent_amount.toLocaleString()} was not approved.`,
          type: 'info',
          metadata: { rent_request_id, tenant_id: rentRequest.tenant_id },
        });
      }

      // Tenant SMS on rejection (fire-and-forget)
      if (tenantPhone) {
        const rejectMsg = `WELILE: Your rent request for UGX ${Number(rentRequest.rent_amount).toLocaleString()} was not approved. Contact your agent for details.`;
        sendSMS(tenantPhone, rejectMsg).catch(e => console.error("Rejection SMS error:", e));
      }

      return new Response(
        JSON.stringify({ success: true, message: 'Rent request rejected' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }


    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "🏠 Rent Request Processed", body: "Activity: rent request", url: "/dashboard/manager" }),
    }).catch(() => {});


    return new Response(JSON.stringify({ error: 'Invalid action' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Unexpected error:', errorMessage);
    return new Response(JSON.stringify({ error: 'Internal server error', details: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
