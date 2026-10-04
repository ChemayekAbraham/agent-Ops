import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Server configuration error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  let token = ''
  try {
    const body = await req.json()
    token = typeof body.token === 'string' ? body.token.trim() : ''
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON in request body' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (!token || !/^[a-f0-9]{16,64}$/.test(token)) {
    return new Response(JSON.stringify({ error: 'Invalid token' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const supabase = createClient(supabaseUrl, serviceKey)
  const { data, error } = await supabase
    .from('support_diagnostic_reports')
    .select('report, metadata, created_at, expires_at, first_viewed_at, view_count')
    .eq('token', token)
    .maybeSingle()

  if (error) {
    console.error('Failed to load diagnostic report', error)
    return new Response(JSON.stringify({ error: 'Lookup failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (!data) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (new Date(data.expires_at).getTime() < Date.now()) {
    return new Response(JSON.stringify({ error: 'expired' }), {
      status: 410,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Record the view (best-effort; does not block returning the report).
  await supabase
    .from('support_diagnostic_reports')
    .update({
      first_viewed_at: data.first_viewed_at ?? new Date().toISOString(),
      view_count: (data.view_count ?? 0) + 1,
    })
    .eq('token', token)

  return new Response(
    JSON.stringify({
      success: true,
      report: data.report,
      metadata: data.metadata,
      createdAt: data.created_at,
      expiresAt: data.expires_at,
      firstViewedAt: data.first_viewed_at,
      viewCount: (data.view_count ?? 0) + 1,
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})
