import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Early exit if no credit limits exist
    const { count, error: countErr } = await supabase
      .from('credit_access_limits')
      .select('user_id', { count: 'exact', head: true });

    if (countErr) throw countErr;
    if (!count || count === 0) {
      return new Response(JSON.stringify({ processed: 0, skipped: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get all users with credit access limits
    const { data: limits, error } = await supabase
      .from('credit_access_limits')
      .select('user_id')
      .limit(1000);

    if (error) throw error;

    let processed = 0;
    for (const row of (limits || [])) {
      await supabase.rpc('recalculate_credit_limit', { p_user_id: row.user_id });
      processed++;
    }

    return new Response(JSON.stringify({ processed }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
