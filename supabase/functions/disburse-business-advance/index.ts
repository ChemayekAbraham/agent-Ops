// CFO disburses an approved business advance directly to the tenant's wallet.
// Requires status = 'coo_approved'. Sets last_compounded_date = today and status = 'active'.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkTreasuryGuard } from '../_shared/treasuryGuard.ts';
import { guardCfoApprover, cfoApproverDenied, isCfoApprover } from '../_shared/cfoApprovalGate.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing authorization');

    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await anonClient.auth.getUser();
    if (authErr || !user) throw new Error('Unauthorized');

    const service = createClient(supabaseUrl, serviceKey);

    const guard = await checkTreasuryGuard(service, 'any', req.headers.get("Authorization"));
    if (guard) return guard;

    // Verify CFO/manager
    const { data: roles } = await service
      .from('user_roles').select('role').eq('user_id', user.id)
      .in('role', ['cfo', 'manager', 'super_admin']);
    if (!roles || roles.length === 0) throw new Error('Insufficient permissions');

    // Sole-CFO-approver gate: everyone else is read-only for approvals.
    const cfoGate = await guardCfoApprover(service, user.id, corsHeaders);
    if (cfoGate) return cfoGate;

    const { advance_id, notes } = await req.json();
    if (!advance_id) throw new Error('advance_id required');

    const { data: adv, error: advErr } = await service
      .from('business_advances')
      .select('*')
      .eq('id', advance_id)
      .single();
    if (advErr || !adv) throw new Error('Advance not found');
    if (adv.status !== 'coo_approved') {
      throw new Error(`Invalid status: ${adv.status} — expected coo_approved`);
    }

    const principal = Number(adv.principal);
    const today = new Date().toISOString().split('T')[0];
    const nowIso = new Date().toISOString();

    // Mark advance disbursed/active
    const { error: updErr } = await service
      .from('business_advances')
      .update({
        status: 'active',
        cfo_disbursed_by: user.id,
        cfo_disbursed_at: nowIso,
        cfo_notes: notes || null,
        disbursed_at: nowIso,
        last_compounded_date: today,
        outstanding_balance: principal,
        updated_at: nowIso,
      })
      .eq('id', advance_id)
      .eq('status', 'coo_approved');
    if (updErr) throw updErr;

    // Ledger: platform pays out (rent_disbursement category — same as agent advance pattern)
    const { error: rpcErr } = await service.rpc('create_ledger_transaction', {
      entries: [
        {
          user_id: adv.tenant_id,
          ledger_scope: 'wallet',
          direction: 'cash_in',
          amount: principal,
          category: 'rent_disbursement',
          source_table: 'business_advances',
          source_id: advance_id,
          description: `Business advance disbursed: ${adv.business_name}`,
          currency: 'UGX',
          transaction_date: nowIso,
        },
        {
          user_id: adv.tenant_id,
          ledger_scope: 'platform',
          direction: 'cash_out',
          amount: principal,
          category: 'rent_disbursement',
          source_table: 'business_advances',
          source_id: advance_id,
          description: `Business advance disbursement to ${adv.business_name}`,
          currency: 'UGX',
          transaction_date: nowIso,
        },
      ],
    });
    if (rpcErr) throw rpcErr;

    return new Response(JSON.stringify({ ok: true, advance_id, amount: principal }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error('[disburse-business-advance] error', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
