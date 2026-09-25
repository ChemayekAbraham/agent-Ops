import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// ── SMS helper — mirrors platform-expense-transfer: Yoola first, then
// Africa's Talking, with every attempt logged to public.sms_delivery_log.
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
    console.error("[hr-pay-release] sms_delivery_log insert failed:", (e as Error).message);
  }
}
async function sendSMS(
  phone: string,
  message: string,
  meta: { recipientUserId?: string | null; recipientName?: string | null; referenceId?: string | null } = {},
): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "hr-pay-release" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  const baseRow = {
    recipient_phone: formatPhoneInternational(phone) || phone,
    recipient_user_id: meta.recipientUserId ?? null,
    recipient_name: meta.recipientName ?? null,
    message,
    reference_id: meta.referenceId ?? null,
    source: "hr-pay-release",
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
      to: formatPhoneInternational(phone),
      message,
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
    console.error("[hr-pay-release] SMS error:", err);
    return false;
  }
}

const json = (payload: unknown, status: number) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  // 1. CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const adminClient = createClient(supabaseUrl, serviceKey);

    // 2. Treasury guard — this function moves money
    const guardBlock = await checkTreasuryGuard(adminClient, "any", req.headers.get("Authorization"));
    if (guardBlock) return guardBlock;

    // 3. Resolve the caller
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);

    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json({ error: 'Unauthorized' }, 401);

    // 4. Authorise by POSITION via rpc, running as the caller (never user_roles)
    const { data: isReleaser } = await (userClient.rpc as any)('hr_pay_is_releaser');
    let authorised = isReleaser === true;
    if (!authorised) {
      const { data: isRuleAdmin } = await (userClient.rpc as any)('hr_pay_is_rule_admin');
      authorised = isRuleAdmin === true;
    }
    if (!authorised) {
      return json({ error: 'Only the position holding release authority may release a payroll run.' }, 403);
    }

    const body = await req.json();
    const runId: string = body?.runId;
    const dryRun: boolean = body?.dryRun === true;
    if (!runId) return json({ error: 'runId is required' }, 400);

    // NEW — optional batch. When payslipIds is present it must be a non-empty
    // list; an empty list is refused rather than treated as "everyone", so a
    // screen fault can never release the whole run by accident.
    const rawIds = body?.payslipIds;
    let payslipIds: string[] | null = null;
    if (rawIds !== undefined && rawIds !== null) {
      const valid = Array.isArray(rawIds) && rawIds.length > 0 &&
        rawIds.every((x: unknown) => typeof x === 'string' && x.length > 0);
      if (!valid) {
        return json({ error: 'payslipIds must be a non-empty list of payslip ids.' }, 400);
      }
      payslipIds = Array.from(new Set(rawIds as string[]));
    }

    // 5. Load the run
    const { data: run, error: runErr } = await adminClient
      .from('hr_pay_runs')
      .select('id, status, period_id, hr_pay_periods:period_id(code)')
      .eq('id', runId)
      .maybeSingle();
    if (runErr || !run) return json({ error: 'Payroll run not found' }, 404);
    if (run.status !== 'approved') {
      return json({ error: `Payroll run status is '${run.status}' — only an approved run can be released.` }, 409);
    }
    const periodCode: string = (run as any).hr_pay_periods?.code ?? '';

    // 6. Current payslips joined to staff — NEW: optionally only a chosen batch
    let psQuery = adminClient
      .from('hr_pay_payslips')
      .select('id, staff_id, net, hr_staff:staff_id(id, staff_ref, user_id)')
      .eq('run_id', runId)
      .eq('is_current', true);
    if (payslipIds) psQuery = psQuery.in('id', payslipIds);
    const { data: payslips, error: psErr } = await psQuery;
    if (psErr) return json({ error: psErr.message }, 500);
    const rows = payslips ?? [];

    // NEW — a batch may only name current payslips of this run. Anything else is
    // stale or foreign; refuse the whole batch rather than pay part of it.
    if (payslipIds && rows.length !== payslipIds.length) {
      return json({
        error: `${payslipIds.length - rows.length} of the ${payslipIds.length} selected payslips are not current payslips of this run. Reload the run and select again.`,
      }, 409);
    }

    // 7. Dry run — write nothing
    if (dryRun) {
      const items = rows.map((p: any) => {
        const net = Number(p.net ?? 0);
        let blocker: string | null = null;
        if (net <= 0) blocker = 'Net is zero or negative';
        else if (!p.hr_staff?.user_id) blocker = 'Staff member has no linked user account';
        return { payslip_id: p.id, staff_ref: p.hr_staff?.staff_ref ?? null, amount: net, blocker };
      });
      return json({
        dryRun: true,
        batch: payslipIds ? 'selected' : 'all',
        payslip_count: rows.length,
        total_net: items.reduce((s, i) => s + i.amount, 0),
        items,
      }, 200);
    }

    // 8. Post each payslip sequentially
    let posted = 0, skipped = 0, failed = 0, alreadyHandled = 0, retried = 0, totalPosted = 0;

    for (const p of rows as any[]) {
      const net = Number(p.net ?? 0);
      const employeeUserId: string | null = p.hr_staff?.user_id ?? null;

      // a. deterministic idempotency key
      const idempotencyKey = "hrpay:" + runId + ":" + p.id;

      // b. claim the attempt
      const { data: disb, error: insErr } = await adminClient
        .from('hr_pay_disbursements')
        .insert({
          run_id: runId,
          payslip_id: p.id,
          staff_id: p.staff_id,
          user_id: employeeUserId,
          amount: net,
          idempotency_key: idempotencyKey,
          status: 'pending',
          attempted_at: new Date().toISOString(),
          released_by: user.id,
        })
        .select('id')
        .single();

      let disbId: string;
      if (insErr) {
        if ((insErr as any).code === '23505' || /duplicate key|unique/i.test(insErr.message)) {
          // NEW — already attempted. A FAILED attempt is retried by reclaiming the
          // same row, conditionally on it still being failed, so two releases can
          // never both claim it. Posted, skipped and pending rows are left alone —
          // a pending row may already have reached the ledger.
          const { data: reclaimed, error: reErr } = await adminClient
            .from('hr_pay_disbursements')
            .update({
              status: 'pending',
              error_text: null,
              attempted_at: new Date().toISOString(),
              released_by: user.id,
            })
            .eq('idempotency_key', idempotencyKey)
            .eq('status', 'failed')
            .select('id');
          if (reErr) {
            failed++;
            console.error(`[hr-pay-release] retry claim failed for payslip ${p.id}:`, reErr.message);
            continue;
          }
          if (!reclaimed || reclaimed.length === 0) {
            alreadyHandled++;
            continue;
          }
          disbId = reclaimed[0].id;
          retried++;
        } else {
          failed++;
          console.error(`[hr-pay-release] claim failed for payslip ${p.id}:`, insErr.message);
          continue;
        }
      } else {
        disbId = disb!.id;
      }

      // c. zero or negative net
      if (net <= 0) {
        await adminClient.from('hr_pay_disbursements')
          .update({ status: 'skipped', error_text: 'Net is zero or negative' })
          .eq('id', disbId);
        skipped++;
        continue;
      }

      // d. no linked user account
      if (!employeeUserId) {
        await adminClient.from('hr_pay_disbursements')
          .update({ status: 'failed', error_text: 'Staff member has no linked user account — cannot credit a wallet' })
          .eq('id', disbId);
        failed++;
        continue;
      }

      // e. ensure wallet exists
      await adminClient.from('wallets')
        .upsert({ user_id: employeeUserId, balance: 0 }, { onConflict: 'user_id', ignoreDuplicates: true });

      // f. reference + timestamp
      const refId = crypto.randomUUID();
      const payTxDate = new Date().toISOString();

      // g. two balanced legs; recipient_type routes the credit to withdrawable
      const entries = [
        {
          user_id: employeeUserId, ledger_scope: 'platform', direction: 'cash_out',
          amount: net, category: 'salary_payout',
          source_table: 'hr_pay_payslips',
          description: 'Salary take-home',
          currency: 'UGX', reference_id: refId, transaction_date: payTxDate,
          recipient_type: 'user',
        },
        {
          user_id: employeeUserId, ledger_scope: 'wallet', direction: 'cash_in',
          amount: net, category: 'salary_payout',
          source_table: 'hr_pay_payslips',
          description: 'Salary for ' + periodCode,
          currency: 'UGX', reference_id: refId, transaction_date: payTxDate,
          recipient_type: 'user',
        },
      ];

      // h. post
      const { error: rpcErr } = await adminClient.rpc('create_ledger_transaction', { entries });

      // i. failure — record and carry on
      if (rpcErr) {
        console.error(`[hr-pay-release] ledger error for payslip ${p.id}:`, rpcErr.message);
        await adminClient.from('hr_pay_disbursements')
          .update({ status: 'failed', error_text: rpcErr.message })
          .eq('id', disbId);
        failed++;
        continue;
      }

      // j. success
      await adminClient.from('hr_pay_disbursements')
        .update({ status: 'posted', ledger_reference_id: refId, posted_at: new Date().toISOString() })
        .eq('id', disbId);

      await adminClient.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'hr_pay_disbursed',
        table_name: 'hr_pay_disbursements',
        record_id: disbId,
        metadata: {
          run_id: runId,
          payslip_id: p.id,
          staff_id: p.staff_id,
          amount: net,
          reference_id: refId,
          batch: payslipIds ? 'selected' : 'all',
        },
      });

      posted++;
      totalPosted += net;

      // k. salary credit SMS — only after a posted disbursement. Never on
      // failed, skipped or dry run. A failure here never affects the payment.
      try {
        const { data: prof } = await adminClient
          .from('profiles')
          .select('phone, full_name')
          .eq('id', employeeUserId)
          .maybeSingle();
        const phone = (prof?.phone ?? '').toString().trim();
        if (phone) {
          const firstName =
            (prof?.full_name ?? '').toString().trim().split(/\s+/)[0] || 'Team Member';
          const smsMsg =
            `Dear ${firstName}, your salary for ${periodCode} has been processed and credited to your wallet. ` +
            `Log in to view your balance and payslip. For any questions, contact the Finance Department. ` +
            `- Welile Finance Department`;
          const sent = await sendSMS(phone, smsMsg, {
            recipientUserId: employeeUserId,
            recipientName: (prof?.full_name ?? null) as string | null,
            referenceId: refId,
          });
          console.log(`[hr-pay-release] salary SMS to ${phone}: ${sent ? 'sent' : 'failed'} ref=${refId}`);
        }
      } catch (e) {
        console.error('[hr-pay-release] salary SMS failed:', (e as Error).message);
      }
    }

    // 9. Summary
    return json({
      success: true,
      batch: payslipIds ? 'selected' : 'all',
      selected: payslipIds ? payslipIds.length : null,
      posted,
      skipped,
      failed,
      retried,
      already_handled: alreadyHandled,
      total_posted: totalPosted,
    }, 200);
  } catch (e) {
    console.error('[hr-pay-release] unhandled error:', (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
