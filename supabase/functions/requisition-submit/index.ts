import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendSMS } from '../_shared/sendSmsMultiProvider.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function fmtUGX(amount: number) {
  return `UGX ${Math.round(amount).toLocaleString('en-US')}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const employeeName = typeof body?.employee_name === 'string' ? body.employee_name.trim() : '';
    const employeeEmail = typeof body?.employee_email === 'string' ? body.employee_email.trim().toLowerCase() : '';
    const purpose = typeof body?.purpose === 'string' ? body.purpose.trim() : '';
    const category = typeof body?.category === 'string' ? body.category.trim() : '';
    const amount = Math.round(Number(body?.amount) * 100) / 100;
    const currency = typeof body?.currency === 'string' ? body.currency.trim().toUpperCase() : 'UGX';
    const priority = typeof body?.priority === 'string' ? body.priority.trim() : 'normal';
    const attachmentUrls = Array.isArray(body?.attachment_urls)
      ? body.attachment_urls.slice(0, 10).filter((value): value is string => typeof value === 'string').map((value) => value.slice(0, 500))
      : [];

    if (token.length < 20) return json({ error: 'invalid_token' }, 400);
    if (employeeName.length < 2 || employeeName.length > 160) return json({ error: 'invalid_employee_name' }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(employeeEmail) || employeeEmail.length > 254) return json({ error: 'invalid_employee_email' }, 400);
    if (purpose.length < 3 || purpose.length > 500) return json({ error: 'invalid_purpose' }, 400);
    if (!category || category.length > 100) return json({ error: 'invalid_category' }, 400);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) return json({ error: 'invalid_amount' }, 400);
    if (currency !== 'UGX') return json({ error: 'invalid_currency' }, 400);
    if (!['low', 'normal', 'high', 'urgent'].includes(priority)) return json({ error: 'invalid_priority' }, 400);

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: slot, error: slotError } = await admin.rpc('consume_requisition_link_slot', { p_token: token });
    if (slotError) throw slotError;
    const link = Array.isArray(slot) ? slot[0] : slot;
    if (!link) return json({ error: 'exhausted' }, 403);
    // `consume_requisition_link_slot` returns the id as `link_id`; keep the
    // legacy `id` fallback so the requisition is always tied to its link.
    const linkId = (link.link_id ?? link.id) as string | undefined;
    if (!linkId) return json({ error: 'invalid_token' }, 400);

    const { data: inserted, error: insertError } = await admin
      .from('employee_requisitions')
      .insert({
        link_id: linkId,
        employee_name: employeeName,
        employee_id: typeof body?.employee_id === 'string' ? body.employee_id.trim().slice(0, 100) || null : null,
        department: typeof body?.department === 'string' ? body.department.trim().slice(0, 160) || link.department : link.department,
        employee_phone: typeof body?.employee_phone === 'string' ? body.employee_phone.trim().slice(0, 40) || null : null,
        employee_email: employeeEmail,
        purpose,
        category,
        amount,
        currency,
        priority,
        required_by: typeof body?.required_by === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.required_by) ? body.required_by : null,
        description: typeof body?.description === 'string' ? body.description.trim().slice(0, 4000) || null : null,
        attachment_urls: attachmentUrls,
        status: 'pending_coo',
        workflow_stage: 'coo',
        current_approver_role: 'coo',
        submitted_at: new Date().toISOString(),
        submitter_ip: req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip'),
      })
      .select('*')
      .single();
    if (insertError || !inserted) throw new Error(insertError?.message || 'Could not create requisition');

    await admin.from('audit_logs').insert({
      action_type: 'manual_requisition_submitted',
      table_name: 'employee_requisitions',
      record_id: inserted.id,
      reason: `Manual requisition submitted for ${employeeName} (${fmtUGX(amount)})`,
      metadata: { link_id: linkId, workflow_stage: 'coo', employee_email: employeeEmail },
    });
    await admin.from('system_events').insert({
      event_type: 'requisition_created',
      payload: { source: 'employee_requisitions', id: inserted.id, stage: 'coo', amount, currency },
    });
    await notifyApprovers(admin, 'coo', inserted);

    return json({ ok: true, requisition_id: inserted.id });
  } catch (error) {
    console.error('requisition-submit error', error);
    return json({ error: 'submission_failed', message: String((error as Error).message ?? error) }, 500);
  }
});

async function notifyApprovers(admin: any, role: string, row: any) {
  try {
    const { data: holders } = await admin.from('user_roles').select('user_id').eq('role', role).eq('enabled', true).limit(50);
    const ids = (holders ?? []).map((holder: { user_id: string }) => holder.user_id);
    if (!ids.length) return;
    await admin.from('notifications').insert(ids.map((userId: string) => ({
      user_id: userId,
      type: 'employee_requisition',
      title: 'Manual requisition needs COO review',
      message: `${row.employee_name} submitted ${fmtUGX(Number(row.amount))} for ${row.purpose}.`,
      metadata: { requisition_id: row.id, workflow_stage: 'coo' },
    })));
    const { data: profiles } = await admin.from('profiles').select('id, phone').in('id', ids);
    for (const profile of profiles ?? []) {
      if (!profile.phone) continue;
      await sendSMS(profile.phone, `Welile: Manual requisition from ${row.employee_name} for ${fmtUGX(Number(row.amount))} awaits COO review.`, {
        admin,
        source: 'requisition-submit',
        reference_id: row.id,
        recipient_user_id: profile.id,
        idempotencyKey: `manual-requisition-${row.id}-${profile.id}`,
      });
    }
  } catch (error) {
    console.error('manual requisition notification failed', error);
  }
}
