import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logSystemEvent } from "../_shared/eventLogger.ts";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── SMS helper (Africa's Talking) ─────────────────────────────────────
function formatPhoneInternational(phone: string): string {
  const digits = (phone || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('256')) return `+${digits}`;
  if (digits.startsWith('0')) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return digits ? `+${digits}` : '';
}
function isUgandanPhone(phone: string): boolean {
  const f = formatPhoneInternational(phone);
  return f.startsWith('+256') && f.length >= 13;
}
async function sendSMS(phone: string, message: string): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "reject-withdrawal" })) return true;
  const apiKey = Deno.env.get('AFRICASTALKING_API_KEY');
  const username = Deno.env.get('AFRICASTALKING_USERNAME');
  if (!apiKey || !username) return false;
  if (!isUgandanPhone(phone)) return false;
  const isSandbox = username.toLowerCase() === 'sandbox';
  const baseUrl = isSandbox
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';
  try {
    const body = new URLSearchParams({
      username, from: "WELILE",
      to: formatPhoneInternational(phone),      message,
    });
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        apiKey,
        Accept: 'application/json',
      },
      body: body.toString(),
    });
    const data = await res.json();
    const recipients = data?.SMSMessageData?.Recipients || [];
    return recipients.some((r: any) => r.statusCode === 101 || r.statusCode === 100);
  } catch (err) {
    console.error('[reject-withdrawal] SMS error:', err);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { withdrawal_ids, reason, withdrawal_type } = await req.json();

    if (!withdrawal_ids?.length || !reason || reason.length < 10) {
      return new Response(JSON.stringify({ error: 'withdrawal_ids and reason (min 10 chars) required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    // Treasury guard: rejection refunds (credits) the user wallet — block when paused
    const guardBlock = await checkTreasuryGuard(admin, "credit", req.headers.get("Authorization"));
    if (guardBlock) return guardBlock;

    // Verify caller has operations/manager/cfo role
    const { data: roles } = await admin
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id);
    const allowedRoles = ['manager', 'super_admin', 'cfo', 'coo', 'operations', 'agent'];
    const hasRole = roles?.some(r => allowedRoles.includes(r.role));
    const isAgentOnly = !!roles?.length && roles.every(r => r.role === 'agent');

    // If caller is only an agent, they must be an active cashout agent and may
    // ONLY reject withdrawals they themselves have claimed. Enforced per-row below.
    let cashoutAgentId: string | null = null;
    if (isAgentOnly) {
      const { data: ca } = await admin
        .from('cashout_agents')
        .select('id')
        .eq('agent_id', user.id)
        .eq('is_active', true)
        .maybeSingle();
      cashoutAgentId = ca?.id ?? null;
      if (!cashoutAgentId) {
        return new Response(JSON.stringify({ error: 'Insufficient permissions' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    if (!hasRole) {
      return new Response(JSON.stringify({ error: 'Insufficient permissions' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const results: { id: string; status: string; refunded: boolean }[] = [];

    for (const wId of withdrawal_ids) {
      const table = withdrawal_type === 'float' ? 'agent_float_withdrawals' : 'withdrawal_requests';

      const { data: wr, error: fetchErr } = await admin
        .from(table)
        .select('*')
        .eq('id', wId)
        .single();

      if (fetchErr || !wr) {
        results.push({ id: wId, status: 'not_found', refunded: false });
        continue;
      }

      if (wr.status === 'rejected' || wr.status === 'completed' || wr.status === 'approved' || wr.status === 'processing') {
        results.push({ id: wId, status: 'already_' + wr.status, refunded: false });
        continue;
      }

      // Agent-only callers can only reject items they themselves have claimed,
      // and only on the regular wallet withdrawal table.
      if (isAgentOnly) {
        if (withdrawal_type === 'float') {
          results.push({ id: wId, status: 'forbidden_float', refunded: false });
          continue;
        }
        if ((wr as any).assigned_cashout_agent_id !== cashoutAgentId) {
          results.push({ id: wId, status: 'not_your_claim', refunded: false });
          continue;
        }
      }

      const userId = withdrawal_type === 'float' ? wr.agent_id : wr.user_id;

      // ── Landlord-float payout rejection ────────────────────────────────
      // These rows live in withdrawal_requests but are funded from the
      // dedicated agent_landlord_float ledger. As of 2026-07-24 the LP payout
      // float is only debited when FinOps APPROVES the payout, not at OTP /
      // queue-insertion time — so a rejection here means nothing left the
      // ring-fenced bucket and there is no refund to perform. We just fail
      // the linked landlord_payout so it returns to Landlord Ops and skip
      // the standard wallet reversal.
      const isLandlordFloatPayout =
        withdrawal_type !== 'float' &&
        typeof (wr as any).reason === 'string' &&
        (wr as any).reason.startsWith('Landlord float payout');
      if (isLandlordFloatPayout) {
        const refunded = false; // nothing was ever debited from LP float
        const landlordPayoutId = (wr as any).landlord_payout_id ?? null;
        if (landlordPayoutId) {
          // Match every pre-settlement status, not just 'pending_merchant_payout'.
          // A rejection that lands while the payout is still 'otp_verified' or
          // 'disbursing' used to no-op here, stranding the row in a status that
          // ring-fences the agent's Landlord Payout Float forever.
          await admin
            .from('landlord_payouts')
            .update({ status: 'failed', last_error: `Merchant rejected: ${String(reason).slice(0, 200)}` } as any)
            .eq('id', landlordPayoutId)
            .in('status', ['otp_verified', 'pending_merchant_payout', 'pending_finops_disbursement', 'disbursing']);
        }

        const { error: lpUpdateErr } = await admin
          .from('withdrawal_requests')
          .update({
            status: 'rejected',
            rejection_reason: reason,
            processed_by: user.id,
            processed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          } as any)
          .eq('id', wId);
        if (lpUpdateErr) {
          console.error(`[reject-withdrawal] Failed to update ${wId}:`, lpUpdateErr);
          results.push({ id: wId, status: 'update_failed', refunded });
          continue;
        }

        try {
          await admin.from('notifications').insert({
            user_id: userId,
            title: 'Landlord Payout Returned',
            message: `The payout of UGX ${Number(wr.amount).toLocaleString()} to the landlord could not be completed. Reason: ${reason}. Your Landlord Payout Float was not debited — please retry from Landlord Ops.`,
            type: 'financial',
          });
        } catch { /* non-blocking */ }

        await admin.from('audit_logs').insert({
          user_id: user.id,
          action_type: 'landlord_float_payout_rejected',
          metadata: { withdrawal_id: wId, landlord_payout_id: landlordPayoutId, target_user: userId, amount: wr.amount, reason, refunded },
        });
        logSystemEvent(admin, 'landlord_float_payout_rejected', user.id, 'withdrawal_requests', wId, { amount: wr.amount, refunded });
        results.push({ id: wId, status: 'rejected', refunded });
        continue;
      }

      // Per financial governance: rejection = NO ledger entry.
      // Nothing moved financially. The original withdrawal request's ledger entry
      // (if any deduction happened at request time) should be handled by the
      // deduct_wallet_on_withdrawal_request trigger reversal, NOT here.

      // For float withdrawals, restore float balance (operational, not ledger)
      let refunded = false;
      if (withdrawal_type === 'float') {
        const { error: restoreErr } = await admin
          .from('agent_landlord_float')
          .update({
            balance: (wr as any).amount + ((await admin.from('agent_landlord_float').select('balance').eq('agent_id', userId).single()).data?.balance || 0),
            total_paid_out: Math.max(0, ((await admin.from('agent_landlord_float').select('total_paid_out').eq('agent_id', userId).single()).data?.total_paid_out || 0) - (wr as any).amount),
            updated_at: new Date().toISOString(),
          })
          .eq('agent_id', userId);

        if (!restoreErr) refunded = true;
      } else {
        // Policy (2026-07-24): Rejecting a wallet withdrawal at FinOps NEVER
        // refunds the user's wallet. The rejection simply closes the request
        // — no ledger entry is created. Legacy request-time holds are no
        // longer reversed here; if a genuinely stuck legacy hold surfaces,
        // CFO must resolve it manually via CFO Direct Credit.
        refunded = false;
      }

      // Update the withdrawal status
      const updateFields: Record<string, unknown> = {
        status: 'rejected',
        updated_at: new Date().toISOString(),
      };

      if (withdrawal_type === 'float') {
        updateFields.agent_ops_notes = reason;
        updateFields.agent_ops_reviewed_at = new Date().toISOString();
        updateFields.agent_ops_reviewed_by = user.id;
      } else {
        updateFields.rejection_reason = reason;
        updateFields.processed_by = user.id;
        updateFields.processed_at = new Date().toISOString();
      }

      const { error: updateErr } = await admin
        .from(table)
        .update(updateFields)
        .eq('id', wId);

      if (updateErr) {
        console.error(`[reject-withdrawal] Failed to update ${wId}:`, updateErr);
        results.push({ id: wId, status: 'update_failed', refunded });
        continue;
      }

      // Send notification to user
      try {
        await admin.from('notifications').insert({
          user_id: userId,
          title: 'Cash-out Request Rejected',
          message: `Your ${withdrawal_type === 'float' ? 'landlord float' : 'wallet'} withdrawal of UGX ${Number(wr.amount).toLocaleString()} was rejected. Reason: ${reason}${refunded ? '. Funds have been restored to your balance.' : ''}`,
          type: 'financial',
        });
      } catch { /* notification table may be suppressed by trigger */ }

      // ── User SMS alert (rejected) ──────────────────────────────────────
      // Fire-and-forget; the AT helper no-ops if creds are missing or the
      // phone isn't a valid UG number. Pulls the phone via a single targeted
      // profiles lookup so we don't depend on caller-supplied data.
      try {
        const { data: rejProfile } = await admin
          .from('profiles')
          .select('phone')
          .eq('id', userId)
          .maybeSingle();
        const phone = rejProfile?.phone as string | undefined;
        if (phone) {
          const shortReason = String(reason).slice(0, 120);
          const smsMsg =
            `WELILE: Your withdrawal of UGX ${Number(wr.amount).toLocaleString()} ` +
            `was REJECTED. Reason: ${shortReason}` +
            (refunded ? '. Funds restored to your balance.' : '.');
          sendSMS(phone, smsMsg).catch((e) =>
            console.error('[reject-withdrawal] rejection SMS failed:', e),
          );
        }
      } catch (e) {
        console.error('[reject-withdrawal] phone lookup failed:', e);
      }

      // Audit log
      await admin.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'withdrawal_rejected',
        metadata: {
          withdrawal_id: wId,
          withdrawal_type,
          target_user: userId,
          amount: wr.amount,
          reason,
          refunded,
        },
      });

      logSystemEvent(admin, 'withdrawal_rejected', user.id, withdrawal_type === 'float' ? 'agent_float_withdrawals' : 'withdrawal_requests', wId, { amount: wr.amount, withdrawal_type, refunded });

      results.push({ id: wId, status: 'rejected', refunded });
    }

    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({ title: "❌ Withdrawal Rejected", body: "Activity: withdrawal rejected", url: "/dashboard/manager" }),
    }).catch(() => {});

    return new Response(JSON.stringify({ success: true, results }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[reject-withdrawal] Error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
