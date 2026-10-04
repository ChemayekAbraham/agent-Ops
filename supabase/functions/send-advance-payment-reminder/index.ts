import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { attemptYoolaPrimary } from '../_shared/yoolaPrimary.ts';

// Manual CORS headers (project standard — do not import corsHeaders).
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const fmtUGX = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

const ALLOWED_ROLES = ['coo', 'ceo', 'cfo', 'cto', 'super_admin', 'manager', 'agent_ops', 'financial_ops'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(supabaseUrl, serviceKey);

    // Authenticate the caller and confirm they hold an ops/exec role.
    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const { data: roles } = await admin
      .from('user_roles')
      .select('role')
      .eq('user_id', userData.user.id);
    const hasRole = (roles || []).some((r) => ALLOWED_ROLES.includes(r.role));
    if (!hasRole) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json().catch(() => ({}));
    const agentIds: string[] = Array.isArray(body?.agent_ids) ? body.agent_ids.filter(Boolean) : [];
    const customMessage: string | undefined = typeof body?.custom_message === 'string' && body.custom_message.trim()
      ? body.custom_message.trim() : undefined;

    if (!agentIds.length) {
      return new Response(JSON.stringify({ error: 'No agent_ids provided' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Pull each agent's active/overdue advance (amounts computed server-side).
    const { data: advances } = await admin
      .from('agent_advances')
      .select('agent_id, outstanding_balance, arrears_balance, principal, access_fee, cycle_days, status, recovery_source, daily_installment')
      .in('agent_id', agentIds)
      .in('status', ['active', 'overdue'])
      // ROI advances never get daily repayment reminders — late or missed ROI
      // payouts are not the agent's action to take. NULL-safe: legacy rows with
      // no recovery_source are still treated as daily-sweep advances.
      .or('recovery_source.is.null,recovery_source.neq.roi');

    const { data: profs } = await admin
      .from('profiles')
      .select('id, phone, full_name')
      .in('id', agentIds);
    const profMap = new Map((profs || []).map((p) => [p.id, p]));

    const sent: string[] = [];
    const failed: string[] = [];
    const skippedRoi: string[] = [];

    for (const adv of advances || []) {
      // Defence in depth: ROI advances (and any advance with no daily
      // installment obligation) are excluded from repayment reminders.
      if (String(adv.recovery_source || '').toLowerCase() === 'roi') {
        skippedRoi.push(adv.agent_id);
        continue;
      }
      const prof = profMap.get(adv.agent_id);
      if (!prof?.phone) { failed.push(adv.agent_id); continue; }
      const cycle = Number(adv.cycle_days) || 30;
      const scheduled = cycle > 0 ? Math.round((Number(adv.principal) + Number(adv.access_fee || 0)) / cycle) : 0;
      const arrears = Number(adv.arrears_balance || 0);
      const outstanding = Number(adv.outstanding_balance || 0);

      const message = customMessage ?? [
        `WELILE: Reminder — your advance repayment is pending.`,
        arrears > 0 ? `Missed/arrears: ${fmtUGX(arrears)}.` : `Today's installment: ${fmtUGX(scheduled)}.`,
        `Outstanding: ${fmtUGX(outstanding)}.`,
        `Please keep your wallet funded so we can collect it. Repayments are collected daily at 6pm.`,
      ].join(' ');

      let ok = false;
      try {
        ok = await attemptYoolaPrimary(prof.phone, message, {
          source: 'advance_payment_reminder',
          recipientUserId: adv.agent_id,
          recipientName: prof.full_name ?? undefined,
        });
      } catch (_e) { ok = false; }
      (ok ? sent : failed).push(adv.agent_id);
    }

    await admin.from('system_events').insert({
      event_type: 'advance_payment_reminder_sent',
      user_id: userData.user.id,
      payload: { sent_count: sent.length, failed_count: failed.length, requested: agentIds.length },
    }).then(() => {}, () => {});

    return new Response(JSON.stringify({ sent: sent.length, failed: failed.length, skipped_roi: skippedRoi.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});