// Rent Plan transition notices — Phase 3, items 11 and 13.
//
// Two messages, one drain:
//   A1  to the AGENT   when landlord float lands in their wallet and the
//                      landlord has not been paid yet.
//   T1  to the TENANT  when their plan becomes `repaying`, telling them
//                      repayment starts tomorrow and what it will be.
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
// NOTE ON THE 24-HOUR DEADLINE. The spec's A1 text warns the agent that the
// float will be recalled and the plan cancelled after 24 hours. That recall is
// Phase 4 and does not exist yet, so this message does NOT state it. Telling
// agents about a consequence we cannot yet apply would be a promise we do not
// keep; the sentence goes in when the timer does.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendSMS } from '../_shared/sendSmsMultiProvider.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ugx = (n: unknown) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

const dayLabel = (iso: unknown) => {
  if (!iso) return '';
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long' });
};

interface AgentNotice {
  rent_request_id: string;
  agent_id: string;
  agent_phone: string;
  agent_name: string | null;
  landlord_name: string | null;
  tenant_name: string | null;
  rent_amount: number;
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
}

/** Terminology is mandatory in customer copy: Rent Plan, never "loan". */
function agentMessage(n: AgentNotice): string {
  const tenant = n.tenant_name ? ` for ${n.tenant_name}` : '';
  return (
    `${ugx(n.rent_amount)} landlord float is in your wallet to pay ` +
    `${n.landlord_name || 'the landlord'}${tenant}.\n\n` +
    `Please pay the landlord and submit the TID and receipt. ` +
    `The tenant starts repaying the day after the landlord is paid.\n\n` +
    `Payouts run 06:00-22:00.`
  );
}

function tenantMessage(n: TenantNotice): string {
  const name = n.tenant_first_name ? `, ${n.tenant_first_name}` : '';
  const landlord = (n.landlord_name || '').trim();
  const paidTo = landlord ? `your landlord ${landlord}` : 'your landlord';
  const term = n.duration_days ? `\n  for ${n.duration_days} days` : '';
  const agent = n.agent_name
    ? `\n\nYour agent ${n.agent_name}${n.agent_phone ? ` (${n.agent_phone})` : ''} will collect from you.`
    : '';

  return [
    `Welcome to Welile${name}.`,
    '',
    `Your rent of ${ugx(n.rent_amount)} has been paid to ${paidTo}.`,
    '',
    `Your repayment starts TOMORROW, ${dayLabel(n.repayment_starts_on)}:`,
    `  ${ugx(n.instalment)} ${n.period_label}${term}`,
    `  Total to repay: ${ugx(n.total_repayment)}`,
  ].join('\n') + agent;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const result = { agent_sent: 0, agent_failed: 0, tenant_sent: 0, tenant_failed: 0 };

  try {
    // One round trip for the entire work list.
    const { data, error } = await admin.rpc('rent_plan_transition_notices_pending', {
      p_lookback_hours: 48,
    });
    if (error) throw new Error(`pending lookup failed: ${error.message}`);

    const agents = (data?.agent_float_funded ?? []) as AgentNotice[];
    const tenants = (data?.tenant_welcome ?? []) as TenantNotice[];

    for (const n of agents) {
      const ok = await sendSMS(n.agent_phone, agentMessage(n), {
        admin,
        source: 'rent_plan_float_funded',
        reference_id: n.rent_request_id,
        recipient_user_id: n.agent_id,
        recipient_name: n.agent_name,
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
        idempotencyKey: `rent-plan-t1:${n.rent_request_id}`,
      });
      ok ? result.tenant_sent++ : result.tenant_failed++;
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
