import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authError || !caller) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Check manager role
    const { data: roles } = await supabaseAdmin.from('user_roles').select('role').eq('user_id', caller.id).eq('role', 'manager');
    if (!roles || roles.length === 0) {
      return new Response(JSON.stringify({ error: 'Forbidden: Manager role required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { rent_request_id } = await req.json();
    if (!rent_request_id) {
      return new Response(JSON.stringify({ error: 'rent_request_id is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    console.log(`Deleting rent request ${rent_request_id} by manager ${caller.id}`);

    // Delete all FK-dependent records in correct order

    // 1. Delivery confirmations (references disbursement_records, but also rent_request_id)
    await supabaseAdmin.from('agent_delivery_confirmations').delete().eq('rent_request_id', rent_request_id);

    // 2. Disbursement records
    await supabaseAdmin.from('disbursement_records').delete().eq('rent_request_id', rent_request_id);

    // 3. Agent float withdrawals
    await supabaseAdmin.from('agent_float_withdrawals').delete().eq('rent_request_id', rent_request_id);

    // 4. Agent landlord assignments
    await supabaseAdmin.from('agent_landlord_assignments').delete().eq('rent_request_id', rent_request_id);

    // 5. Agent landlord payouts
    await supabaseAdmin.from('agent_landlord_payouts').delete().eq('rent_request_id', rent_request_id);

    // 6. Agent tasks
    await supabaseAdmin.from('agent_tasks').delete().eq('rent_request_id', rent_request_id);

    // 7. Agent earnings
    await supabaseAdmin.from('agent_earnings').delete().eq('rent_request_id', rent_request_id);

    // 8. Default recovery ledger
    await supabaseAdmin.from('default_recovery_ledger').delete().eq('rent_request_id', rent_request_id);

    // 9. General ledger entries
    await supabaseAdmin.from('general_ledger').delete().eq('source_id', rent_request_id);

    // 10. Repayments
    await supabaseAdmin.from('repayments').delete().eq('rent_request_id', rent_request_id);

    // 11. Subscription charge logs (FK dependency on subscription_charges)
    const { data: subs } = await supabaseAdmin.from('subscription_charges').select('id').eq('rent_request_id', rent_request_id);
    if (subs && subs.length > 0) {
      const subIds = subs.map((s: any) => s.id);
      for (const subId of subIds) {
        await supabaseAdmin.from('subscription_charge_logs').delete().eq('subscription_id', subId);
      }
      await supabaseAdmin.from('subscription_charges').delete().eq('rent_request_id', rent_request_id);
    }

    // 12. Supporter ROI payments
    await supabaseAdmin.from('supporter_roi_payments').delete().eq('rent_request_id', rent_request_id);

    // 13. Rent request deletions (snapshot records)
    await supabaseAdmin.from('rent_request_deletions').delete().eq('rent_request_id', rent_request_id);

    // Finally delete the rent request
    const { error: deleteError } = await supabaseAdmin.from('rent_requests').delete().eq('id', rent_request_id);
    if (deleteError) {
      console.error('Error deleting rent request:', deleteError);
      return new Response(JSON.stringify({ error: 'Failed to delete: ' + deleteError.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    console.log(`Rent request ${rent_request_id} deleted successfully`);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('Delete rent request error:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
