import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { attemptYoolaPrimary } from '../_shared/yoolaPrimary.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const fmtUGX = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

type Cohort =
  | 'deducting_but_growing'
  | 'growing_no_deduction'
  | 'flat_no_collection';

const NOTIFY: Cohort[] = ['deducting_but_growing', 'growing_no_deduction', 'flat_no_collection'];

function buildMessage(cohort: Cohort, outstanding: number, interest14: number, paid14: number): string {
  if (cohort === 'flat_no_collection') {
    return `WELILE: Your advance repayment ran daily but collected ${fmtUGX(0)} because you had no withdrawable commission. Outstanding stays ${fmtUGX(outstanding)}. Collect rent or deposit to reduce it.`;
  }
  if (cohort === 'deducting_but_growing') {
    return `WELILE: Your advance is overdue. In 14 days ${fmtUGX(paid14)} was recovered but ${fmtUGX(interest14)} in late charges accrued, so your balance is still growing. Outstanding ${fmtUGX(outstanding)}. Clear it to stop the daily charge.`;
  }
  return `WELILE: Your advance is overdue and a late charge is added every day. ${fmtUGX(interest14)} accrued in the last 14 days with no repayment received. Outstanding ${fmtUGX(outstanding)}. Repay to stop it growing.`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const dryRun = body?.dry_run === true;
    const limit = Number(body?.limit ?? 40);
    const paceMs = Number(body?.pace_ms ?? 1500);
    const only: Cohort[] = Array.isArray(body?.cohorts) && body.cohorts.length
      ? body.cohorts.filter((c: Cohort) => NOTIFY.includes(c))
      : NOTIFY;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data, error } = await supabase.rpc('get_advance_growth_cohorts');
    if (error) throw new Error(error.message);

    const rows = (data ?? []).filter((r: any) => only.includes(r.cohort));

    // Skip agents already reached in the last 24h (rate-limit safe re-runs).
    const { data: recent } = await supabase
      .from('sms_delivery_log')
      .select('recipient_user_id, status, source, created_at')
      .gte('created_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
      .eq('status', 'sent')
      .like('source', 'advance_balance_status%');
    const alreadySent = new Set((recent ?? []).map((r: any) => r.recipient_user_id).filter(Boolean));

    // One SMS per agent: notify on their largest exposure.
    const byAgent = new Map<string, any>();
    for (const r of rows) {
      if (alreadySent.has(r.agent_id)) continue;
      const prev = byAgent.get(r.agent_id);
      if (!prev || Number(r.outstanding) > Number(prev.outstanding)) byAgent.set(r.agent_id, r);
    }

    const results: Array<Record<string, unknown>> = [];
    const queue = Array.from(byAgent.values()).slice(0, dryRun ? byAgent.size : limit);
    for (const r of queue) {
      const message = buildMessage(
        r.cohort as Cohort,
        Number(r.outstanding),
        Number(r.interest_14),
        Number(r.paid_14),
      );
      if (!r.phone) {
        results.push({ agent_id: r.agent_id, cohort: r.cohort, sent: false, skipped: 'no_phone' });
        continue;
      }
      if (dryRun) {
        results.push({ agent_id: r.agent_id, name: r.full_name, cohort: r.cohort, phone: r.phone, message, sent: false });
        continue;
      }
      try {
        const ok = await attemptYoolaPrimary(r.phone, message, {
          source: `advance_balance_status_${r.cohort}`,
          recipientUserId: r.agent_id,
          recipientName: r.full_name ?? undefined,
        });
        results.push({ agent_id: r.agent_id, name: r.full_name, cohort: r.cohort, sent: ok });
        await new Promise((res) => setTimeout(res, paceMs));
      } catch (e) {
        results.push({
          agent_id: r.agent_id,
          cohort: r.cohort,
          sent: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const summary = results.reduce<Record<string, number>>((acc, r) => {
      const key = `${r.cohort}_${r.sent ? 'sent' : 'skipped'}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

    return new Response(
      JSON.stringify({ ok: true, dry_run: dryRun, pending: byAgent.size, attempted: queue.length, summary, results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: corsHeaders });
  }
});
