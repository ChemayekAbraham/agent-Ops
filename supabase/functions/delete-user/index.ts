import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAdmin = createClient(
      supabaseUrl,
      supabaseServiceKey,
    );

    // Verify the caller is a manager
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authError || !caller) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Check manager role
    const { data: roles } = await supabaseAdmin.from('user_roles').select('role').eq('user_id', caller.id).eq('role', 'manager').eq('enabled', true);
    if (!roles || roles.length === 0) {
      return new Response(JSON.stringify({ error: 'Forbidden: Manager role required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { user_id, preserve_history, reason } = await req.json();
    if (!user_id) {
      return new Response(JSON.stringify({ error: 'user_id is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Validate UUID format
    if (typeof user_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user_id)) {
      return new Response(JSON.stringify({ error: 'Invalid user ID format' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Prevent self-deletion
    if (user_id === caller.id) {
      return new Response(JSON.stringify({ error: 'Cannot delete your own account' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Mandatory reason (>=10 chars) per audit governance policy
    const auditReason = typeof reason === 'string' ? reason.trim() : '';
    if (auditReason.length < 10) {
      return new Response(JSON.stringify({ error: 'A reason of at least 10 characters is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Snapshot BEFORE values (email/phone) for the audit trail
    const [{ data: beforeAuth }, { data: beforeProfile }] = await Promise.all([
      supabaseAdmin.auth.admin.getUserById(user_id),
      supabaseAdmin.from('profiles').select('full_name, phone, email').eq('id', user_id).maybeSingle(),
    ]);
    const beforeValues = {
      auth_email: beforeAuth?.user?.email ?? null,
      auth_phone: beforeAuth?.user?.phone ?? null,
      profile_email: beforeProfile?.email ?? null,
      profile_phone: beforeProfile?.phone ?? null,
      full_name: beforeProfile?.full_name ?? null,
    };

    if (preserve_history === true) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('full_name, tenant_status')
        .eq('id', user_id)
        .maybeSingle();

      const archivedName = (profile?.full_name || '').startsWith('[ARCHIVED]')
        ? profile?.full_name
        : `[ARCHIVED] ${profile?.full_name || 'Deleted Tenant'}`;

      const archiveResults = await Promise.all([
        supabaseAdmin.from('profiles').update({ full_name: archivedName, tenant_status: 'inactive' }).eq('id', user_id),
        supabaseAdmin.from('user_roles').delete().eq('user_id', user_id),
        supabaseAdmin.from('push_subscriptions').delete().eq('user_id', user_id),
      ]);

      const archiveError = archiveResults.find((result) => result.error)?.error;
      if (archiveError) {
        console.error('Archive cleanup failed:', archiveError);
        return new Response(JSON.stringify({ error: 'Failed to archive tenant: ' + archiveError.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const { error: softDeleteError } = await supabaseAdmin.auth.admin.deleteUser(user_id, true);
      if (softDeleteError) {
        console.warn('Tenant archived, but auth soft-delete failed:', softDeleteError);
      }

      // Snapshot AFTER values for audit
      const { data: afterAuth } = await supabaseAdmin.auth.admin.getUserById(user_id);
      const afterValues = {
        auth_email: afterAuth?.user?.email ?? null,
        auth_phone: afterAuth?.user?.phone ?? null,
        full_name: archivedName,
        deleted_at: afterAuth?.user?.deleted_at ?? null,
      };

      await supabaseAdmin.from('audit_logs').insert({
        user_id: caller.id,
        action_type: 'archive_account',
        action: 'archive_account',
        table_name: 'auth.users',
        record_id: user_id,
        metadata: {
          reason: auditReason,
          target_user_id: user_id,
          performed_by: caller.id,
          performed_by_email: caller.email,
          before: beforeValues,
          after: afterValues,
          auth_soft_deleted: !softDeleteError,
        },
      });

      return new Response(JSON.stringify({ success: true, archived: true, auth_soft_deleted: !softDeleteError, message: 'Tenant archived and payment history preserved' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // PRE-STEP: remove records that have non-nullable FK refs or need explicit cleanup.
    // Most FK constraints now use ON DELETE SET NULL, so only truly blocking refs need handling.
    const preCleanupResults = await Promise.all([
      supabaseAdmin.from('investor_portfolios').delete().eq('agent_id', user_id),
      supabaseAdmin.from('investor_portfolios').update({ investor_id: null, status: 'cancelled' }).eq('investor_id', user_id),
      supabaseAdmin.from('agent_advance_topups').delete().eq('topped_up_by', user_id),
      supabaseAdmin.from('agent_advances').delete().eq('issued_by', user_id),
      supabaseAdmin.from('wallet_transactions').delete().or(`sender_id.eq.${user_id},recipient_id.eq.${user_id}`),
      supabaseAdmin.from('money_requests').delete().or(`requester_id.eq.${user_id},recipient_id.eq.${user_id}`),
      supabaseAdmin.from('voided_ledger_entries').delete().eq('voided_by', user_id),
      supabaseAdmin.from('staff_permissions').update({ granted_by: null }).eq('granted_by', user_id),
    ]);

    const preCleanupError = preCleanupResults.find((result) => result.error)?.error;
    if (preCleanupError) {
      console.error('Pre-delete cleanup failed:', preCleanupError);
      return new Response(JSON.stringify({ error: 'Failed to prepare account deletion: ' + preCleanupError.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // PRE-STEP 2: Automatically detect & clear EVERY remaining blocking dependent
    // (ledger rows + rent_request children + profile references) so the auth.users
    // cascade can never fail with "Database error deleting user".
    let purgeSummary: unknown = null;
    {
      const { data: purgeData, error: purgeError } = await supabaseAdmin.rpc(
        'admin_purge_user_dependencies',
        { p_user_id: user_id },
      );
      if (purgeError) {
        console.error('Dependency purge failed:', purgeError);
        return new Response(JSON.stringify({ error: 'Failed to clear account dependencies: ' + purgeError.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      purgeSummary = purgeData ?? null;
    }

    // STEP 1: Kill auth user to invalidate all sessions immediately.
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(user_id);
    if (deleteError) {
      console.error('Error deleting auth user:', deleteError);
      return new Response(JSON.stringify({ error: 'Failed to delete auth user: ' + deleteError.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // STEP 2: Now safely clean up all related data (user can no longer authenticate)
    await Promise.all([
      supabaseAdmin.from('user_roles').delete().eq('user_id', user_id),
      supabaseAdmin.from('wallets').delete().eq('user_id', user_id),
      supabaseAdmin.from('referrals').delete().or(`referrer_id.eq.${user_id},referred_id.eq.${user_id}`),
      supabaseAdmin.from('notifications').delete().eq('user_id', user_id),
      supabaseAdmin.from('ai_chat_messages').delete().eq('user_id', user_id),
      supabaseAdmin.from('push_subscriptions').delete().eq('user_id', user_id),
      supabaseAdmin.from('supporter_referrals').delete().or(`referrer_id.eq.${user_id},referred_id.eq.${user_id}`),
      supabaseAdmin.from('investment_withdrawal_requests').delete().eq('user_id', user_id),
      supabaseAdmin.from('credit_access_limits').delete().eq('user_id', user_id),
      supabaseAdmin.from('agent_earnings').delete().eq('agent_id', user_id),
      supabaseAdmin.from('earning_baselines').delete().eq('user_id', user_id),
      supabaseAdmin.from('earning_predictions').delete().eq('user_id', user_id),
      supabaseAdmin.from('deposit_requests').delete().eq('user_id', user_id),
      supabaseAdmin.from('cart_items').delete().eq('user_id', user_id),
    ]);

    // Cancel linked supporter invites
    await supabaseAdmin
      .from('supporter_invites')
      .update({ status: 'cancelled' })
      .or(`activated_user_id.eq.${user_id},created_by.eq.${user_id},parent_agent_id.eq.${user_id}`);

    // Delete profile last (other FKs reference it)
    await supabaseAdmin.from('profiles').delete().eq('id', user_id);

    // Audit the hard-delete with before/after (after = nulls, record removed)
    await supabaseAdmin.from('audit_logs').insert({
      user_id: caller.id,
      action_type: 'delete_account',
      action: 'delete_account',
      table_name: 'auth.users',
      record_id: user_id,
      metadata: {
        reason: auditReason,
        target_user_id: user_id,
        performed_by: caller.id,
        performed_by_email: caller.email,
        before: beforeValues,
        after: { auth_email: null, auth_phone: null, profile_email: null, profile_phone: null, full_name: null },
        hard_delete: true,
        dependency_purge: purgeSummary,
      },
    });


    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "🗑️ User Deleted", body: "Activity: user deleted", url: "/dashboard/manager" }),
    }).catch(() => {});


    return new Response(JSON.stringify({ success: true, message: 'User deleted successfully' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('Delete user error:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
