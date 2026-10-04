import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const STAFF_ROLES = ['manager', 'ceo', 'coo', 'cfo', 'cto', 'cmo', 'crm', 'employee', 'operations'];

// Every account gets its OWN cryptographically random temporary password so a
// single leaked constant can never unlock the whole staff batch.
function rand(set: string): string {
  const r = crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000;
  return set[Math.floor(r * set.length)];
}

function generateTempPassword(): string {
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '@#$%&*';
  const all = upper + lower + digits + symbols;
  const chars = [rand(upper), rand(upper), rand(lower), rand(lower), rand(digits), rand(digits), rand(symbols)];
  for (let i = 0; i < 6; i++) chars.push(rand(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000) * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return 'Welile-' + chars.join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify caller is super_admin
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    // Verify caller
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace('Bearer ', '');
    const { data: claimsData, error: claimsError } = await callerClient.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }
    const callerId = claimsData.claims.sub;

    // Check caller has super_admin role
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    const { data: callerRoles } = await adminClient
      .from('user_roles')
      .select('role')
      .eq('user_id', callerId)
      .eq('role', 'super_admin');

    if (!callerRoles || callerRoles.length === 0) {
      return new Response(JSON.stringify({ error: 'Only super_admin can provision staff passwords' }), {
        status: 403, headers: corsHeaders,
      });
    }

    // Get all staff user IDs
    const { data: staffRoles, error: rolesError } = await adminClient
      .from('user_roles')
      .select('user_id, role')
      .in('role', STAFF_ROLES);

    if (rolesError) {
      return new Response(JSON.stringify({ error: rolesError.message }), { status: 500, headers: corsHeaders });
    }

    // Deduplicate user IDs
    const uniqueUserIds = [...new Set(staffRoles.map((r: any) => r.user_id))];

    let provisioned = 0;
    const errors: string[] = [];
    const credentials: { user_id: string; temp_password: string }[] = [];

    for (const userId of uniqueUserIds) {
      try {
        // Set a unique temp password for this account only
        const tempPassword = generateTempPassword();
        const { error: updateError } = await adminClient.auth.admin.updateUserById(userId as string, {
          password: tempPassword,
        });

        if (updateError) {
          errors.push(`${userId}: ${updateError.message}`);
          continue;
        }

        credentials.push({ user_id: userId as string, temp_password: tempPassword });

        // Set must_change_password flag
        await adminClient
          .from('profiles')
          .update({ must_change_password: true })
          .eq('id', userId);

        // Audit log
        await adminClient.from('audit_logs').insert({
          user_id: callerId,
          action_type: 'staff_password_provisioned',
          table_name: 'auth.users',
          record_id: userId as string,
          metadata: { provisioned_by: callerId, role: staffRoles.filter((r: any) => r.user_id === userId).map((r: any) => r.role) },
        });

        provisioned++;
      } catch (err) {
        errors.push(`${userId}: ${(err as Error).message}`);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      total_staff: uniqueUserIds.length,
      provisioned,
      credentials,
      errors: errors.length > 0 ? errors : undefined,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: corsHeaders,
    });
  }
});
