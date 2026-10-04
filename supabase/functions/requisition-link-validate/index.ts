import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const token = url.searchParams.get('token') ?? '';
    if (!token || token.length < 20) {
      return new Response(JSON.stringify({ valid: false, reason: 'invalid_token' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data, error } = await admin
      .from('requisition_links')
      .select('id, label, department, expires_at, is_active, max_submissions, submission_count, revoked_at')
      .eq('token', token)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return new Response(JSON.stringify({ valid: false, reason: 'not_found' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!data.is_active || data.revoked_at) {
      return new Response(JSON.stringify({ valid: false, reason: 'revoked' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
      return new Response(JSON.stringify({ valid: false, reason: 'expired' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (data.max_submissions && data.submission_count >= data.max_submissions) {
      return new Response(JSON.stringify({ valid: false, reason: 'exhausted' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        valid: true,
        label: data.label,
        department: data.department,
        expires_at: data.expires_at,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    console.error('validate error', e);
    return new Response(JSON.stringify({ valid: false, reason: 'server_error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
