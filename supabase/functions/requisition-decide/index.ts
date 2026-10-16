import { createClient } from 'npm:@supabase/supabase-js@2';
// creditRequisitionWallet is no longer called here; wallet release is done by
// Financial Ops via requisition-credit-retry.
import { guardCfoApprover, cfoApproverDenied, isCfoApprover } from "../_shared/cfoApprovalGate.ts";

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401);
    const token = authHeader.slice('Bearer '.length);
    const authClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: claims, error: authError } = await authClient.auth.getClaims(token);
    if (authError || !claims?.claims?.sub) return json({ error: 'unauthorized' }, 401);
    const userId = String(claims.claims.sub);
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: roles, error: roleError } = await admin.from('user_roles').select('role').eq('user_id', userId).eq('enabled', true);
    if (roleError) throw roleError;
    const callerRoles = new Set((roles ?? []).map((row: { role: string }) => row.role));
    if (![...callerRoles].some((role) => ['cfo', 'coo', 'manager', 'super_admin'].includes(role))) return json({ error: 'forbidden' }, 403);

    const body = await req.json().catch(() => null) as { id?: string; action?: string; reason?: string; amount?: number } | null;
    if (!body?.id || !['approve', 'reject'].includes(body.action ?? '')) return json({ error: 'bad_request' }, 400);
    if (body.action === 'reject' && (body.reason ?? '').trim().length < 10) return json({ error: 'reason_required' }, 400);

    const { data: before, error: beforeError } = await admin.from('employee_requisitions').select('*').eq('id', body.id).maybeSingle();
    if (beforeError) throw beforeError;
    if (!before) return json({ error: 'not_found' }, 404);
    const isManual = before.link_id != null;
    const isPrivileged = callerRoles.has('manager') || callerRoles.has('super_admin');

    if (isManual && before.workflow_stage === 'coo' && before.status === 'pending_coo') {
      if (!callerRoles.has('coo') && !isPrivileged) return json({ error: 'coo_required' }, 403);
      const now = new Date().toISOString();
      const approved = body.action === 'approve';
      const { error } = await admin.from('employee_requisitions').update(approved
        ? { status: 'pending_cfo', workflow_stage: 'cfo', current_approver_role: 'cfo', coo_decided_by: userId, coo_decided_at: now, coo_note: null, rejection_reason: null }
        : { status: 'rejected', workflow_stage: 'complete', current_approver_role: null, coo_decided_by: userId, coo_decided_at: now, coo_note: body.reason!.trim(), approved_by: userId, approved_at: now, rejection_reason: body.reason!.trim() }
      ).eq('id', body.id).eq('status', 'pending_coo');
      if (error) throw error;
      await audit(admin, userId, body.id, approved ? 'manual_requisition_coo_approved' : 'manual_requisition_coo_rejected', approved ? 'COO approved and forwarded manual requisition to CFO' : body.reason!.trim());
      if (approved) await notifyRole(admin, 'cfo', before, 'Manual requisition forwarded for CFO review');
      else await notifyRequester(admin, before, 'Your manual requisition was rejected during COO review.');
      return json({ ok: true, forwarded: approved, rejected: !approved, wallet_credit: null });
    }

    if (isManual) {
      if (before.workflow_stage !== 'cfo' || before.status !== 'pending_cfo') return json({ error: 'already_decided' }, 409);
      if (!callerRoles.has('cfo') && !isPrivileged) return json({ error: 'cfo_required' }, 403);
      if (!(await isCfoApprover(admin, userId))) return json({ error: 'forbidden', message: 'This request could not be completed.' }, 403);
    } else if (![...callerRoles].some((role) => ['cfo', 'manager', 'super_admin'].includes(role))) {
      return json({ error: 'forbidden' }, 403);
    }

    let approvedAmount: number | null = null;
    if (body.action === 'approve' && body.amount != null) {
      approvedAmount = Math.round(Number(body.amount) * 100) / 100;
      if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) return json({ error: 'invalid_amount' }, 400);
    }
    if (body.action === 'approve' && before.wallet_credit_status === 'credited') return json({ ok: true, already_credited: true, wallet_credit: null });

    const now = new Date().toISOString();
    const approved = body.action === 'approve';
    const patch = approved
      ? { status: 'approved', workflow_stage: isManual ? 'complete' : before.workflow_stage, current_approver_role: null, approved_by: userId, approved_at: now, rejection_reason: null, approved_amount: approvedAmount ?? before.approved_amount ?? before.amount, ...(approvedAmount != null ? { amount: approvedAmount } : {}) }
      : { status: 'rejected', workflow_stage: isManual ? 'complete' : before.workflow_stage, current_approver_role: null, approved_by: userId, approved_at: now, rejection_reason: body.reason!.trim() };
    const { data: updated, error: updateError } = await admin.from('employee_requisitions').update(patch).eq('id', body.id).eq('status', before.status).select('id, employee_email, employee_name, amount, currency, purpose, category, status, approved_at').single();
    if (updateError) throw updateError;

    // Wallet credit is no longer automatic — Financial Ops releases via
    // requisition-credit-retry after approval.

    await audit(admin, userId, body.id, approved ? 'manual_requisition_cfo_approved' : 'manual_requisition_cfo_rejected', approved ? 'CFO approved manual requisition — awaiting Financial Ops release' : body.reason!.trim());
    await notifyRequester(admin, updated, approved ? 'Your manual requisition was approved. Financial Operations will release the funds to your wallet shortly.' : `Your manual requisition was rejected. Reason: ${body.reason}`);
    return json({ ok: true, credit_error: null, credit_detail: null, wallet_credit: null });
  } catch (error) {
    console.error('requisition-decide error', error);
    return json({ error: String((error as Error).message ?? error) }, 500);
  }
});

async function audit(admin: any, userId: string, requisitionId: string, actionType: string, reason: string) {
  try {
    await admin.from('audit_logs').insert({ user_id: userId, action_type: actionType, table_name: 'employee_requisitions', record_id: requisitionId, reason: reason.slice(0, 300) });
  } catch (error) { console.error('audit failed', error); }
}

async function notifyRole(admin: any, role: string, row: any, message: string) {
  try {
    const { data: holders } = await admin.from('user_roles').select('user_id').eq('role', role).eq('enabled', true).limit(50);
    const ids = (holders ?? []).map((holder: { user_id: string }) => holder.user_id);
    if (ids.length) await admin.from('notifications').insert(ids.map((userId: string) => ({ user_id: userId, type: 'employee_requisition', title: 'Manual requisition needs your review', message: `${row.employee_name}: ${message}`, metadata: { requisition_id: row.id, workflow_stage: 'cfo' } })));
  } catch (error) { console.error('role notification failed', error); }
}

async function notifyRequester(admin: any, row: any, message: string) {
  try {
    const { data: profile } = await admin.from('profiles').select('id').ilike('email', row.employee_email).maybeSingle();
    if (profile?.id) await admin.from('notifications').insert({ user_id: profile.id, type: 'employee_requisition', title: 'Manual requisition update', message, metadata: { requisition_id: row.id } });
  } catch (error) { console.error('requester notification failed', error); }
}
