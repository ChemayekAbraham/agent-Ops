import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logSystemEvent } from "../_shared/eventLogger.ts";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";
import { guardCfoApprover } from "../_shared/cfoApprovalGate.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// ── SMS helper (Africa's Talking) ─────────────────────────────────────
// Sends a payroll/salary credit alert to the employee's phone and records
// every attempt to public.sms_delivery_log for the admin delivery view.
function formatPhoneInternational(phone: string): string {
  const digits = (phone || "").replace(/[^0-9]/g, "");
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return digits ? `+${digits}` : "";
}
function isUgandanPhone(phone: string): boolean {
  const f = formatPhoneInternational(phone);
  return f.startsWith("+256") && f.length >= 13;
}
async function logSmsDelivery(row: Record<string, unknown>): Promise<void> {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, key);
    await admin.from("sms_delivery_log").insert(row);
  } catch (e) {
    console.error("[platform-expense-transfer] sms_delivery_log insert failed:", (e as Error).message);
  }
}
async function sendSMS(
  phone: string,
  message: string,
  meta: { recipientUserId?: string | null; recipientName?: string | null; referenceId?: string | null } = {},
): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "platform-expense-transfer" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  const baseRow = {
    recipient_phone: formatPhoneInternational(phone) || phone,
    recipient_user_id: meta.recipientUserId ?? null,
    recipient_name: meta.recipientName ?? null,
    message,
    reference_id: meta.referenceId ?? null,
    source: "platform-expense-transfer",
    provider: "africastalking",
  };
  if (!apiKey || !username) {
    await logSmsDelivery({ ...baseRow, status: "failed", error: "Missing Africa's Talking credentials" });
    return false;
  }
  if (!isUgandanPhone(phone)) {
    await logSmsDelivery({ ...baseRow, status: "failed", error: "Invalid/non-Ugandan phone number" });
    return false;
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  try {
    const body = new URLSearchParams({
      username, from: "WELILE",
      to: formatPhoneInternational(phone),      message,
    });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", apiKey, Accept: "application/json" },
      body: body.toString(),
    });
    const data = await res.json();
    const recipient = (data?.SMSMessageData?.Recipients || [])[0];
    const success = recipient?.statusCode === 101 || recipient?.statusCode === 100;
    await logSmsDelivery({
      ...baseRow,
      status: success ? "sent" : "failed",
      provider_message_id: recipient?.messageId ?? null,
      cost: recipient?.cost ?? null,
      provider_response: data ?? null,
      error: success ? null : (recipient?.status ?? data?.SMSMessageData?.Message ?? "Provider rejected message"),
    });
    return success;
  } catch (err) {
    await logSmsDelivery({ ...baseRow, status: "failed", error: (err as Error).message });
    console.error("[platform-expense-transfer] SMS error:", err);
    return false;
  }
}

// Turns "2026-06" (or a free-text label) into "June 2026" for the SMS body.
function formatPayrollPeriod(batchMonth: string | null | undefined): string {
  if (!batchMonth) return "this period";
  const m = /^(\d{4})-(\d{2})$/.exec(batchMonth.trim());
  if (!m) return batchMonth;
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const idx = Number(m[2]) - 1;
  return idx >= 0 && idx < 12 ? `${months[idx]} ${m[1]}` : batchMonth;
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
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const adminClient = createClient(supabaseUrl, serviceKey);

    // Only the Chief Finance Officer office or a designated super admin may do this.
    const denied = await guardCfoApprover(adminClient, user.id, corsHeaders)
    if (denied) return denied

    // Treasury guard: platform-to-agent transfers move money — block when paused
    const guardBlock = await checkTreasuryGuard(adminClient, "any", req.headers.get("Authorization"));
    if (guardBlock) return guardBlock;

    const { data: roles } = await adminClient.from('user_roles').select('role').eq('user_id', user.id);
    const allowedRoles = ['cfo', 'coo', 'super_admin'];
    if (!roles?.some(r => allowedRoles.includes(r.role))) {
      return new Response(JSON.stringify({ error: 'Insufficient permissions' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const body = await req.json();
    const { action } = body;

    // === PLATFORM EXPENSE TRANSFER ===
    if (action === 'transfer') {
      const { financial_agent_id, amount, description, expense_category } = body;

      if (!financial_agent_id || !amount || amount <= 0 || !description || description.length < 5) {
        return new Response(JSON.stringify({ error: 'Invalid parameters' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const { data: fa, error: faErr } = await adminClient
        .from('financial_agents')
        .select('*, profiles:agent_id(id, full_name)')
        .eq('id', financial_agent_id)
        .eq('is_active', true)
        .single();

      if (faErr || !fa) {
        return new Response(JSON.stringify({ error: 'Financial agent not found or inactive' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const agentId = fa.agent_id;

      // Ensure wallet exists
      await adminClient.from('wallets')
        .upsert({ user_id: agentId, balance: 0 }, { onConflict: 'user_id', ignoreDuplicates: true });

      // Credit agent wallet via balanced RPC: platform cash_out + wallet cash_in
      const refId = crypto.randomUUID();
      const expTxDate = new Date().toISOString();
      const { error: rpcErr } = await adminClient.rpc('create_ledger_transaction', {
        entries: [
          {
            user_id: agentId, ledger_scope: 'platform', direction: 'cash_out',
            amount, category: 'system_balance_correction',
            source_table: 'platform_expense_transfers',
            description: `[${expense_category || fa.expense_category}] ${description}`,
            currency: 'UGX', reference_id: refId, transaction_date: expTxDate,
          },
          {
            user_id: agentId, ledger_scope: 'wallet', direction: 'cash_in',
            amount, category: 'system_balance_correction',
            source_table: 'platform_expense_transfers',
            description: `Platform expense credit: [${expense_category || fa.expense_category}] ${description}`,
            currency: 'UGX', reference_id: refId, transaction_date: expTxDate,
          },
        ],
      });

      if (rpcErr) {
        console.error('[platform-expense-transfer] RPC error:', rpcErr);
        return new Response(JSON.stringify({ error: 'Transaction failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      await adminClient.from('platform_expense_transfers').insert({
        financial_agent_id, agent_id: agentId, amount,
        expense_category: expense_category || fa.expense_category,
        description, approved_by: user.id, ledger_reference_id: refId,
      });

      await adminClient.from('audit_logs').insert({
        user_id: user.id, action_type: 'platform_expense_transfer',
        table_name: 'platform_expense_transfers', record_id: refId,
        metadata: { agent_id: agentId, amount, category: expense_category || fa.expense_category, description },
      });

      logSystemEvent(adminClient, 'expense_transfer', user.id, 'platform_expense_transfers', refId, { amount, agent_id: agentId, category: expense_category || fa.expense_category });

      return new Response(JSON.stringify({ success: true, message: `UGX ${amount.toLocaleString()} transferred to ${fa.profiles?.full_name || 'agent'}` }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // === BATCH PAYROLL ===
    if (action === 'process_payroll') {
      const { batch_id } = body;
      if (!batch_id) {
        return new Response(JSON.stringify({ error: 'batch_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const { data: batch, error: bErr } = await adminClient.from('payroll_batches').select('*').eq('id', batch_id).eq('status', 'draft').single();
      if (bErr || !batch) {
        return new Response(JSON.stringify({ error: 'Batch not found or already processed' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      await adminClient.from('payroll_batches').update({ status: 'processing' }).eq('id', batch_id);

      const { data: items } = await adminClient.from('payroll_items').select('*').eq('batch_id', batch_id).eq('status', 'pending');
      if (!items || items.length === 0) {
        await adminClient.from('payroll_batches').update({ status: 'completed', processed_at: new Date().toISOString() }).eq('id', batch_id);
        return new Response(JSON.stringify({ success: true, message: 'No items to process' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const batchDefaultPct = Number((batch as any).default_recovery_percent ?? 30);

      // Pre-fetch employee names + phones for the salary SMS alert.
      const employeeIds = [...new Set(items.map((it: any) => it.employee_id).filter(Boolean))];
      const profileMap = new Map<string, { full_name: string | null; phone: string | null }>();
      if (employeeIds.length > 0) {
        const { data: profs } = await adminClient
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', employeeIds);
        for (const p of profs ?? []) {
          profileMap.set(p.id, { full_name: p.full_name, phone: p.phone });
        }
      }
      const payrollPeriod = formatPayrollPeriod((batch as any).batch_month);

      let processed = 0;
      for (const item of items) {
        try {
          // Ensure wallet exists
          await adminClient.from('wallets')
            .upsert({ user_id: item.employee_id, balance: 0 }, { onConflict: 'user_id', ignoreDuplicates: true });

          // Detect outstanding advance and compute recovery split
          const gross = Number(item.amount);
          const { data: walletRow } = await adminClient
            .from('wallets')
            .select('advance_balance')
            .eq('user_id', item.employee_id)
            .maybeSingle();
          const advanceBal = Math.max(0, Number(walletRow?.advance_balance ?? 0));
          const itemPct = item.recovery_percent != null ? Number(item.recovery_percent) : batchDefaultPct;
          const pct = Math.max(0, Math.min(100, itemPct));
          // Only deduct against advance for salary/bonus/allowance — never an advance disbursement itself
          const eligible = item.category !== 'advance' && advanceBal > 0;
          const recovery = eligible ? Math.min(advanceBal, Math.floor((gross * pct) / 100)) : 0;
          const takeHome = gross - recovery;

          const refId = crypto.randomUUID();
          const payTxDate = new Date().toISOString();

          const entries: any[] = [];
          if (takeHome > 0) {
            entries.push({
              user_id: item.employee_id, ledger_scope: 'platform', direction: 'cash_out',
              amount: takeHome, category: 'system_balance_correction',
              source_table: 'payroll_items',
              description: `${item.category === 'salary' ? 'Salary' : item.category} take-home`,
              currency: 'UGX', reference_id: refId, transaction_date: payTxDate,
              recipient_type: 'user',
            });
            entries.push({
              user_id: item.employee_id, ledger_scope: 'wallet', direction: 'cash_in',
              amount: takeHome, category: 'system_balance_correction',
              source_table: 'payroll_items',
              description: item.description || `${item.category} payment`,
              currency: 'UGX', reference_id: refId, transaction_date: payTxDate,
              recipient_type: 'user',
            });
          }
          if (recovery > 0) {
            entries.push({
              user_id: item.employee_id, ledger_scope: 'wallet', direction: 'cash_out',
              amount: recovery, category: 'advance_repayment',
              source_table: 'payroll_items',
              description: `Advance recovery from ${item.category} (${pct}%)`,
              currency: 'UGX', reference_id: refId, transaction_date: payTxDate,
            });
            entries.push({
              user_id: item.employee_id, ledger_scope: 'platform', direction: 'cash_in',
              amount: recovery, category: 'advance_repayment',
              source_table: 'payroll_items',
              description: `Advance recovery from ${item.category}`,
              currency: 'UGX', reference_id: refId, transaction_date: payTxDate,
            });
          }

          const { error: rpcErr } = entries.length === 0
            ? { error: null }
            : await adminClient.rpc('create_ledger_transaction', { entries });

          if (rpcErr) {
            console.error(`Payroll RPC error for ${item.id}:`, rpcErr);
            await adminClient.from('payroll_items').update({ status: 'failed' }).eq('id', item.id);
            continue;
          }

          await adminClient.from('payroll_items').update({
            status: 'paid',
            paid_at: new Date().toISOString(),
            ledger_reference_id: refId,
            advance_balance_snapshot: advanceBal,
            recovery_amount: recovery,
            take_home_amount: takeHome,
            recovery_percent: pct,
          }).eq('id', item.id);

          await adminClient.from('audit_logs').insert({
            user_id: user.id,
            action_type: 'payroll_item_paid',
            table_name: 'payroll_items',
            record_id: item.id,
            metadata: {
              employee_id: item.employee_id,
              category: item.category,
              gross, recovery, take_home: takeHome,
              recovery_percent: pct,
              advance_balance_before: advanceBal,
              reason: 'payroll_advance_recovery',
            },
          });

          // ── Salary credit SMS (fire only when money actually hit the wallet) ──
          if (takeHome > 0) {
            const prof = profileMap.get(item.employee_id);
            if (prof?.phone) {
              const firstName = (prof.full_name || "Team Member").trim().split(/\s+/)[0];
              const smsMsg =
                `Dear ${firstName}, your salary for ${payrollPeriod} has been successfully processed and credited to your wallet. ` +
                `Log in to view your updated balance and transaction history. For any discrepancies or questions, contact the Finance Department. ` +
                `Thank you for your continued commitment. - Welile Finance Department`;
              try {
                const sent = await sendSMS(prof.phone, smsMsg, {
                  recipientUserId: item.employee_id,
                  recipientName: prof.full_name,
                  referenceId: refId,
                });
                console.log(`[platform-expense-transfer] payroll SMS to ${prof.phone}: ${sent ? "sent" : "failed"} ref=${refId}`);
              } catch (e) {
                console.error("[platform-expense-transfer] payroll SMS failed:", (e as Error).message);
              }
            }
          }

          processed++;
        } catch (e) {
          console.error(`Payroll item ${item.id} failed:`, e);
          await adminClient.from('payroll_items').update({ status: 'failed' }).eq('id', item.id);
        }
      }

      await adminClient.from('payroll_batches').update({
        status: 'completed', processed_count: processed, processed_at: new Date().toISOString(),
      }).eq('id', batch_id);

      await adminClient.from('audit_logs').insert({
        user_id: user.id, action_type: 'payroll_batch_processed',
        table_name: 'payroll_batches', record_id: batch_id,
        metadata: { total_items: items.length, processed },
      });

      return new Response(JSON.stringify({ success: true, message: `Processed ${processed}/${items.length} payments` }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({ title: "💳 Platform Expense", body: "Activity: expense transfer", url: "/dashboard/manager" }),
    }).catch(() => {});

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
