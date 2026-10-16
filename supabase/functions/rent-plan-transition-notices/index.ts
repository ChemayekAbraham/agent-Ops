// Rent Plan transition notices — Phase 3, items 11 and 13.
//
// Five messages, one drain:
//   A1  to the AGENT   when landlord float lands in their wallet and the
//                      landlord has not been paid yet.
//   T1  to the TENANT  when the landlord has actually been paid, telling them
//                      repayment starts tomorrow and what it will be.
//   AP  to the AGENT   on the same event: their landlord is paid, with the
//                      receipt number and code, when the tenant starts, and the
//                      1% they earned. Also sent as an EMAIL to agents who have
//                      a real address of their own - see the AP email notes on
//                      the loop at the bottom of this file.
//   A2/A3 to the AGENT at 6h and 18h, when landlord float is still unpaid and
//                      the 24-hour recall is approaching. Suppressed between
//                      22:00 and 06:00 by the RPC, because landlord payouts are
//                      blocked then anyway.
//   T2  to the TENANT  when a Rent Plan was auto-cancelled because the landlord
//                      was never paid. Nothing is owed by them, and the request
//                      can be submitted again.
//
// The LANDLORD's own message is NOT sent from here. `landlord-rent-receipt`
// already issues the permanent receipt and SMSes them the number and public
// link, invoked from approve-withdrawal at the same moment. 332 sent to date.
// Adding a second would duplicate it.
//
// Why a cron drain rather than sending inline from the trigger. The status
// flip happens inside a landlord-payout transaction, and nothing there may be
// allowed to fail or slow down because an SMS provider is having a bad
// minute. Scanning for the gap instead makes the whole thing self-healing: a
// send that fails is simply picked up on the next run.
//
// Idempotency is the unique index on sms_delivery_log(idempotency_key), so the
// same plan cannot be messaged twice even if this runs concurrently with
// itself. `rent_plan_transition_notices_pending` also filters on that table, so
// an already-sent plan never even reaches the loop.
//
// One round trip fetches the whole work list; the per-recipient loop after it
// is unavoidable, because sending is inherently one message per person.
//
// ON THE 24-HOUR DEADLINE. This file previously omitted the deadline sentence
// from A1, because the recall was Phase 4 and did not exist: telling agents
// about a consequence we could not apply would have been a promise we did not
// keep. THE RECALL IS LIVE NOW, so the sentence is in, exactly as the spec
// writes it.
//
// One conditional remains, and it is not a rewording: a plan funded BEFORE
// `landlord_float_recall_go_live()` is not governed by the timer, so A1 omits
// the deadline paragraph for those rather than threaten a consequence that
// cannot happen to them. Everything funded from go-live onward gets the full
// spec text.
//
// EVERY STRING BELOW IS COPIED FROM docs/rent-plan-new-flow-full-report.md
// section 5. Do not improve them. If a message needs to change, change the
// spec first, because these go to customers and agents who were told what to
// expect.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendSMS } from '../_shared/sendSmsMultiProvider.ts';
import { receiptUrl, formatReceiptDateTime } from '../_shared/landlordReceipt.ts';
import { isPlaceholderRecipient } from '../_shared/recipientMailbox.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ugx = (n: unknown) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

const dayLabel = (iso: unknown) => {
  if (!iso) return '';
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return String(iso);
  // en-GB yields "Tuesday, 29 September", which lands inside a sentence that
  // already has a comma before it: "starts TOMORROW, Tuesday, 29 September:".
  // The document writes it without one, and Postgres formats A1's deadline_date
  // the same way (FMDay DD FMMonth), so the two dates now read alike.
  return d
    .toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long' })
    .replace(',', '');
};

interface AgentNotice {
  rent_request_id: string;
  agent_id: string;
  agent_phone: string;
  agent_name: string | null;
  landlord_name: string | null;
  tenant_name: string | null;
  rent_amount: number;
  ref: string | null;
  /** Kampala-formatted by the RPC, so this file never guesses a timezone. */
  deadline_time: string | null;
  deadline_date: string | null;
  /** False for plans funded before the recall went live — they are not governed. */
  recall_active: boolean;
}

interface AgentCancelledNotice {
  rent_request_id: string;
  agent_id: string;
  agent_phone: string;
  agent_name: string | null;
  landlord_name: string | null;
  tenant_name: string | null;
  rent_amount: number;
  ref: string | null;
}

interface AgentPaidNotice {
  rent_request_id: string;
  agent_id: string;
  agent_phone: string;
  agent_name: string | null;
  landlord_name: string | null;
  tenant_first_name: string | null;
  rent_amount: number;
  instalment: number;
  period_label: string;
  repayment_starts_on: string;
  receipt_number: string | null;
  /** The public code the receipt page is read at. Null until the receipt exists. */
  receipt_code: string | null;
  /** Only present when the commission leg actually exists in general_ledger. */
  commission_ugx: number | null;
}

/**
 * AP, by email. The RPC only returns a row when the agent has an address that
 * provably belongs to them and the receipt already exists, so every field the
 * email leans on is present.
 */
interface AgentPaidEmailNotice {
  rent_request_id: string;
  agent_id: string;
  agent_email: string;
  agent_name: string | null;
  landlord_name: string | null;
  tenant_name: string | null;
  rent_amount: number;
  instalment: number;
  period_label: string;
  repayment_starts_on: string;
  receipt_number: string;
  receipt_code: string;
  /** When the landlord was paid, as an ISO timestamp. */
  paid_at: string;
  commission_ugx: number | null;
  ref: string | null;
}

interface AgentNudgeNotice {
  rent_request_id: string;
  agent_id: string;
  agent_phone: string;
  agent_name: string | null;
  landlord_name: string | null;
  tenant_name: string | null;
  amount: number;
  severity: 'reminder' | 'warning';
  hours_left: number;
  ref: string | null;
  deadline_time: string | null;
  deadline_date: string | null;
}

interface TenantCancelledNotice {
  rent_request_id: string;
  tenant_id: string;
  tenant_phone: string;
  tenant_first_name: string | null;
  rent_amount: number;
  landlord_name: string | null;
  ref: string | null;
}

interface TenantNotice {
  rent_request_id: string;
  tenant_id: string;
  tenant_phone: string;
  tenant_first_name: string | null;
  landlord_name: string | null;
  rent_amount: number;
  instalment: number;
  period_label: string;
  duration_days: number | null;
  total_repayment: number;
  repayment_starts_on: string;
  agent_name: string | null;
  agent_phone: string | null;
  ref: string | null;
}

/**
 * SMS copy. Every message must fit ONE 160-character segment once the central
 * sender appends its "Help:" footer (17 chars), so the text budget is 143.
 * Optional parts (tenant name, ref, extras) are tried richest-first and the
 * first variant that fits is sent; the core facts are always present.
 */
const SMS_ROOM = 143;
const pickFit = (variants: string[]): string =>
  variants.find((v) => v.length <= SMS_ROOM) ?? variants[variants.length - 1];

/** "Tue 29 Sep" - short, so a repayment date does not cost a second segment. */
const dayShort = (iso: unknown) => {
  if (!iso) return '';
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return String(iso);
  return d
    .toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })
    .replace(',', '');
};

/** A1: float sent to the agent; pay the landlord by the deadline. */
export function agentMessage(n: AgentNotice): string {
  const ll = n.landlord_name || 'the landlord';
  const head = (t: string) => `${ugx(n.rent_amount)} float for ${ll}${t} is in your wallet. `;
  const tail = `Pay by ${n.deadline_time} on ${n.deadline_date} or it is returned and the Rent Plan cancelled.`;
  const tenant = n.tenant_name ? ` (${n.tenant_name})` : '';
  const ref = n.ref ? ` Ref ${n.ref}.` : '';
  return pickFit([
    head(tenant) + tail + ref,
    head(tenant) + tail,
    head('') + tail + ref,
    head('') + tail,
  ]);
}

/** T1: rent paid; repayment starts tomorrow. */
export function tenantMessage(n: TenantNotice): string {
  const landlord = (n.landlord_name || '').trim();
  const core = `Rent of ${ugx(n.rent_amount)} paid to ${landlord || 'your landlord'}. ` +
    `Repay ${ugx(n.instalment)} ${n.period_label}`;
  const start = ` from TOMORROW (${dayShort(n.repayment_starts_on)})`;
  const days = n.duration_days ? ` for ${n.duration_days} days` : '';
  const total = `. Total ${ugx(n.total_repayment)}.`;
  const agent = n.agent_name
    ? ` Agent ${n.agent_name}${n.agent_phone ? ` ${n.agent_phone}` : ''}.`
    : '';
  const ref = n.ref ? ` Ref ${n.ref}.` : '';
  return pickFit([
    core + start + days + total + agent + ref,
    core + start + days + total + agent,
    core + start + days + total + ref,
    core + start + days + total,
    core + start + total,
  ]);
}

/** AP: landlord paid; receipt link; upload the receipt. */
export function agentPaidMessage(n: AgentPaidNotice): string {
  const tenant = n.tenant_first_name || 'Tenant';
  // The number and the code are one receipt: both or neither. A number with no
  // code is something the agent cannot look up, and 'Receipt No: .' must never
  // reach a live SMS.
  const hasReceipt = Boolean(n.receipt_number && n.receipt_code);
  const paid = `${ugx(n.rent_amount)} paid to ${n.landlord_name || 'landlord'}.`;
  const link = hasReceipt ? ` Receipt ${receiptUrl(n.receipt_code as string)}` : '';
  const num = hasReceipt ? ` (${n.receipt_number}).` : '';
  const end = hasReceipt ? '.' : '';
  const repay = ` ${tenant} repays ${ugx(n.instalment)} ${n.period_label} from tomorrow`;
  const day = ` (${dayShort(n.repayment_starts_on)})`;
  const upload = ' Upload receipt.';
  // Only claim the commission when the ledger leg is really there.
  const comm = n.commission_ugx ? ` Commission ${ugx(n.commission_ugx)}.` : '';
  return pickFit([
    paid + link + num + repay + day + '.' + comm + upload,
    paid + link + end + repay + day + '.' + comm + upload,
    paid + link + end + repay + day + '.' + upload,
    paid + link + end + repay + '.' + upload,
    paid + link + end + upload,
  ]);
}

/**
 * What the `agent-landlord-paid-receipt` email is rendered from. It says what
 * the AP SMS says, so the figures are formatted here, next to that message,
 * and the template only lays them out.
 *
 * `rent_request_id` is in the data on purpose: send-transactional-email stores
 * the template data on its email_send_log row, and that row is the only record
 * that this plan has been emailed. The pending-notices RPC reads the plan id
 * back out of it so the same plan is never emailed twice.
 */
export function agentPaidEmailData(n: AgentPaidEmailNotice) {
  return {
    rent_request_id: n.rent_request_id,
    agent_name: (n.agent_name || '').trim().split(/\s+/)[0] || 'there',
    landlord_name: n.landlord_name || 'your landlord',
    tenant_name: n.tenant_name || 'your tenant',
    amount: n.rent_amount,
    currency: 'UGX',
    receipt_number: n.receipt_number,
    receipt_code: n.receipt_code,
    receipt_url: receiptUrl(n.receipt_code),
    paid_on: formatReceiptDateTime(n.paid_at),
    repayment_starts_on: dayLabel(n.repayment_starts_on),
    instalment: n.instalment,
    period_label: n.period_label,
    commission: n.commission_ugx ?? '',
    rent_request_ref: n.ref ?? '',
  };
}

export function agentNudgeMessage(n: AgentNudgeNotice): string {
  const who = n.landlord_name || 'the landlord';
  const tenantName = n.tenant_name || 'the tenant';
  const ref = n.ref ? ` Ref ${n.ref}.` : '';

  if (n.severity === 'warning') {
    // A3: fires at 18h of a 24h clock, hence "6 hours left"; deadline time quoted.
    const left = `6 hours left${n.deadline_time ? ` (${n.deadline_time})` : ''}`;
    const base = `Reminder: ${ugx(n.amount)} for ${who} still in your wallet. ${left}. `;
    return pickFit([
      `${base}Then float is returned and ${tenantName}'s Rent Plan cancelled.${ref}`,
      `${base}Then float is returned and ${tenantName}'s Rent Plan cancelled.`,
      `${base}Then float is returned and Rent Plan cancelled.${ref}`,
      `${base}Then float is returned and Rent Plan cancelled.`,
    ]);
  }

  // A2: nudges without threatening; the recall consequence belongs to A3.
  const tenant = n.tenant_name ? ` (${n.tenant_name})` : '';
  const head = (t: string) => `${ugx(n.amount)} float for ${who}${t} is still in your wallet. `;
  const pay = `Pay the landlord by ${n.deadline_time} on ${n.deadline_date}.`;
  const hours = ' Payouts run 06:00-22:00.';
  return pickFit([
    head(tenant) + pay + hours + ref,
    head(tenant) + pay + ref,
    head(tenant) + pay,
    head('') + pay + ref,
    head('') + pay,
  ]);
}

/** T2: the landlord was not paid in time; nothing owed. */
export function tenantCancelledMessage(n: TenantCancelledNotice): string {
  const name = n.tenant_first_name ? `${n.tenant_first_name}, the` : 'The';
  const ref = n.ref ? ` Ref ${n.ref}.` : '';
  const core = `${name} Rent Plan for ${ugx(n.rent_amount)} was not completed: landlord not paid in time. You owe nothing.`;
  return pickFit([
    `${core} Your agent can resubmit.${ref}`,
    `${core} Your agent can resubmit.`,
    core,
  ]);
}

/** A4: the agent's float was taken back after 24 hours. */
export function agentCancelledMessage(n: AgentCancelledNotice): string {
  const tenant = n.tenant_name || 'The tenant';
  const ref = n.ref ? ` Ref ${n.ref}.` : '';
  const ll = n.landlord_name || 'the landlord';
  return pickFit([
    `${ugx(n.rent_amount)} float for ${ll} not paid within 24 hours and returned. ${tenant}'s Rent Plan cancelled; resubmit it.${ref}`,
    `${ugx(n.rent_amount)} float for ${ll} not paid within 24 hours and returned. ${tenant}'s Rent Plan cancelled; resubmit it.`,
    `${ugx(n.rent_amount)} float for ${ll} not paid in 24 hours and returned. Rent Plan cancelled; resubmit it.`,
  ]);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const result = {
    agent_sent: 0, agent_failed: 0,
    agent_cancelled_sent: 0, agent_cancelled_failed: 0,
    tenant_sent: 0, tenant_failed: 0,
    agent_paid_sent: 0, agent_paid_failed: 0,
    agent_paid_email_sent: 0, agent_paid_email_skipped: 0, agent_paid_email_failed: 0,
    nudge_sent: 0, nudge_failed: 0,
    cancelled_sent: 0, cancelled_failed: 0,
  };

  try {
    // One round trip for the entire work list.
    const { data, error } = await admin.rpc('rent_plan_transition_notices_pending', {
      p_lookback_hours: 48,
    });
    if (error) throw new Error(`pending lookup failed: ${error.message}`);

    // Yoola accepts EVERY message and confirms none of them. The provider
    // chain in sendSmsMultiProvider breaks on the first acceptance, so
    // Africa's Talking is never reached and these notices die at yoola:
    // measured 2026-09-29, the tenant welcome for plan 1C635D8D was accepted
    // twice (message_id 396185 and 396328, UGX 90 each, statusCode 100) and
    // the tenant received neither, while Africa's Talking had delivered to
    // that same number six times in September.
    //
    // These messages are the ones a Rent Plan depends on, so they now poll
    // briefly for a real receipt and fail over when it does not come - the
    // same mechanism the withdrawal and cash-deposit OTPs use, which are the
    // only messages on the platform that reliably arrive.
    //
    // The window is deliberately short. This job runs every 10 minutes and a
    // single tick can carry several plans; the OTP settings (4 attempts over
    // ~10s) would risk timing the whole run out when a batch transitions at
    // once. Two attempts is enough to tell 'yoola has a receipt' from
    // 'yoola only ever says sent'.
    const CONFIRM = {
      requireDeliveryConfirmation: true,
      deliveryConfirmation: { attempts: 2, delayMs: 1500 },
    } as const;

    const agents = (data?.agent_float_funded ?? []) as AgentNotice[];
    const tenants = (data?.tenant_welcome ?? []) as TenantNotice[];
    const agentsPaid = (data?.agent_landlord_paid ?? []) as AgentPaidNotice[];
    const agentsPaidEmail = (data?.agent_landlord_paid_email ?? []) as AgentPaidEmailNotice[];
    const nudges = (data?.agent_nudge ?? []) as AgentNudgeNotice[];
    const cancelled = (data?.tenant_cancelled ?? []) as TenantCancelledNotice[];
    const agentCancelled = (data?.agent_cancelled ?? []) as AgentCancelledNotice[];

    for (const n of agents) {
      const ok = await sendSMS(n.agent_phone, agentMessage(n), {
        admin,
        source: 'rent_plan_float_funded',
        reference_id: n.rent_request_id,
        recipient_user_id: n.agent_id,
        recipient_name: n.agent_name,
        ...CONFIRM,
        idempotencyKey: `rent-plan-a1:${n.rent_request_id}`,
      });
      ok ? result.agent_sent++ : result.agent_failed++;
    }

    for (const n of tenants) {
      const ok = await sendSMS(n.tenant_phone, tenantMessage(n), {
        admin,
        source: 'rent_plan_tenant_welcome',
        reference_id: n.rent_request_id,
        recipient_user_id: n.tenant_id,
        recipient_name: n.tenant_first_name,
        ...CONFIRM,
        idempotencyKey: `rent-plan-t1:${n.rent_request_id}`,
      });
      ok ? result.tenant_sent++ : result.tenant_failed++;
    }

    for (const n of agentsPaid) {
      const ok = await sendSMS(n.agent_phone, agentPaidMessage(n), {
        admin,
        source: 'rent_plan_landlord_paid',
        reference_id: n.rent_request_id,
        recipient_user_id: n.agent_id,
        recipient_name: n.agent_name,
        ...CONFIRM,
        idempotencyKey: `rent-plan-ap:${n.rent_request_id}`,
      });
      ok ? result.agent_paid_sent++ : result.agent_paid_failed++;
    }

    for (const n of nudges) {
      const ok = await sendSMS(n.agent_phone, agentNudgeMessage(n), {
        admin,
        source: `rent_plan_float_${n.severity}`,
        reference_id: n.rent_request_id,
        recipient_user_id: n.agent_id,
        recipient_name: n.agent_name,
        ...CONFIRM,
        idempotencyKey: `rent-plan-${n.severity}:${n.rent_request_id}`,
      });
      ok ? result.nudge_sent++ : result.nudge_failed++;
    }

    for (const n of cancelled) {
      const ok = await sendSMS(n.tenant_phone, tenantCancelledMessage(n), {
        admin,
        source: 'rent_plan_cancelled',
        reference_id: n.rent_request_id,
        recipient_user_id: n.tenant_id,
        recipient_name: n.tenant_first_name,
        ...CONFIRM,
        idempotencyKey: `rent-plan-t2:${n.rent_request_id}`,
      });
      ok ? result.cancelled_sent++ : result.cancelled_failed++;
    }

    // A4. The agent whose float was taken back.
    for (const n of agentCancelled) {
      const ok = await sendSMS(n.agent_phone, agentCancelledMessage(n), {
        admin,
        source: 'rent_plan_float_returned',
        reference_id: n.rent_request_id,
        recipient_user_id: n.agent_id,
        recipient_name: n.agent_name,
        ...CONFIRM,
        idempotencyKey: `rent-plan-a4:${n.rent_request_id}`,
      });
      ok ? result.agent_cancelled_sent++ : result.agent_cancelled_failed++;
    }

    // AP, by email. Deliberately LAST: every SMS above has already gone, so
    // nothing here - a slow render, a mail outage - can delay a notice an agent
    // or tenant is waiting for.
    //
    // The RPC has already decided who is mailed: only an address that provably
    // belongs to the agent (resolve_owned_notification_email - never a
    // phone-only placeholder, never one shared between accounts), only once the
    // receipt exists, only for payouts in the last six hours, and never a plan
    // that already has a row in email_send_log. So this loop holds no policy of
    // its own; it sends what it is given.
    //
    // send-transactional-email answers 200 with success:false for a recipient it
    // will not mail (suppressed, unsubscribed). That is a skip, not an outage,
    // and it is logged, so the plan stops being offered.
    for (const n of agentsPaidEmail) {
      // resolve_owned_notification_email only rules out the @welile.user and
      // @welile.agent placeholders; this is the platform's full list. The mailer
      // would refuse these too, but it logs the refusal WITHOUT the plan id, so
      // the plan would be offered again on every run for six hours. Skip it here.
      if (isPlaceholderRecipient(n.agent_email)) {
        result.agent_paid_email_skipped++;
        continue;
      }
      try {
        const { data: sent, error } = await admin.functions.invoke('send-transactional-email', {
          body: {
            templateName: 'agent-landlord-paid-receipt',
            recipientEmail: n.agent_email,
            idempotencyKey: `rent-plan-ap-email:${n.rent_request_id}`,
            templateData: agentPaidEmailData(n),
          },
        });
        if (error) {
          console.error('[rent-plan-transition-notices] AP email failed', n.rent_request_id, error.message);
          result.agent_paid_email_failed++;
        } else if (sent?.success === true) {
          result.agent_paid_email_sent++;
        } else {
          result.agent_paid_email_skipped++;
        }
      } catch (e) {
        console.error('[rent-plan-transition-notices] AP email threw', n.rent_request_id, e);
        result.agent_paid_email_failed++;
      }
    }

    return new Response(JSON.stringify({ success: true, ...result }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[rent-plan-transition-notices]', err);
    return new Response(
      JSON.stringify({ success: false, error: (err as Error).message, ...result }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
