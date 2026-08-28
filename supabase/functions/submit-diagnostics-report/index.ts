import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Public/customer-facing app URL where support can open the one-time link.
const DEFAULT_APP_ORIGIN = 'https://welileapp.com'
// Fallback support inbox; override with the SUPPORT_INBOX_EMAIL secret.
const DEFAULT_SUPPORT_INBOX = 'support@welile.com'
const FROM_DOMAIN = 'welile.com'
const SENDER_DOMAIN = 'notify.welile.com'

const MAX_REPORT_BYTES = 200_000 // ~200 KB safety cap

function generateToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
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

  // Auth gate: require a valid session so anonymous callers can't flood the
  // support_diagnostic_reports table or spam the support inbox.
  const authClient = createClient(supabaseUrl, serviceKey)
  const authHeader = req.headers.get('Authorization')
  const token = authHeader?.replace('Bearer ', '').trim() ?? ''
  if (!token) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  if (token !== serviceKey) {
    const { data: authData, error: authError } = await authClient.auth.getUser(token)
    if (authError || !authData?.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
  }

  let report: string
  let metadata: Record<string, unknown> = {}
  let appOrigin = DEFAULT_APP_ORIGIN
  try {
    const body = await req.json()
    report = typeof body.report === 'string' ? body.report : ''
    if (body.metadata && typeof body.metadata === 'object') metadata = body.metadata
    if (typeof body.origin === 'string' && /^https:\/\/[\w.-]+/.test(body.origin)) {
      appOrigin = body.origin.replace(/\/+$/, '')
    }
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON in request body' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (!report || report.trim().length < 10) {
    return new Response(JSON.stringify({ error: 'report is required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  if (new TextEncoder().encode(report).length > MAX_REPORT_BYTES) {
    return new Response(JSON.stringify({ error: 'report too large' }), {
      status: 413,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const supabase = createClient(supabaseUrl, serviceKey)
  const reportToken = generateToken()

  const { error: insertError } = await supabase
    .from('support_diagnostic_reports')
    .insert({ token: reportToken, report, metadata })

  if (insertError) {
    console.error('Failed to store diagnostic report', insertError)
    return new Response(JSON.stringify({ error: 'Failed to store report' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const supportLink = `${appOrigin}/support-report/${reportToken}`
  const supportInbox = Deno.env.get('SUPPORT_INBOX_EMAIL') || DEFAULT_SUPPORT_INBOX
  const generatedAt = new Date().toISOString()

  // Email the report + one-time link to the support inbox via the email queue.
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
      <h2 style="margin:0 0 8px;">Welile diagnostics report</h2>
      <p style="margin:0 0 12px;color:#475569;">A user submitted a diagnostics report from the app.</p>
      <p style="margin:0 0 4px;"><strong>Generated:</strong> ${esc(generatedAt)}</p>
      <p style="margin:0 0 16px;">
        <strong>One-time support link:</strong>
        <a href="${esc(supportLink)}" style="color:#2563eb;">${esc(supportLink)}</a>
        <br/><span style="color:#94a3b8;font-size:12px;">Link expires in 7 days.</span>
      </p>
      <pre style="white-space:pre-wrap;word-break:break-word;background:#f1f5f9;padding:16px;border-radius:8px;font-size:12px;line-height:1.5;border:1px solid #e2e8f0;">${esc(report)}</pre>
    </div>
  `
  const text = `Welile diagnostics report\nGenerated: ${generatedAt}\nOne-time support link: ${supportLink}\n(Link expires in 7 days.)\n\n${report}`

  const messageId = crypto.randomUUID()
  let emailQueued = false
  try {
    await supabase.from('email_send_log').insert({
      message_id: messageId,
      template_name: 'diagnostics-report',
      recipient_email: supportInbox,
      status: 'pending',
      metadata: { subject: 'Welile diagnostics report', support_link: supportLink },
    })

    const { error: enqueueError } = await supabase.rpc('enqueue_email', {
      queue_name: 'transactional_emails',
      payload: {
        message_id: messageId,
        to: supportInbox,
        from: `Welile Diagnostics <info@${FROM_DOMAIN}>`,
        sender_domain: SENDER_DOMAIN,
        subject: 'Welile diagnostics report',
        html,
        text,
        purpose: 'transactional',
        label: 'diagnostics-report',
        idempotency_key: messageId,
        queued_at: new Date().toISOString(),
      },
    })
    if (enqueueError) {
      console.error('Failed to enqueue diagnostics email', enqueueError)
      await supabase.from('email_send_log').insert({
        message_id: messageId,
        template_name: 'diagnostics-report',
        recipient_email: supportInbox,
        status: 'failed',
        error_message: 'Failed to enqueue diagnostics email',
      })
    } else {
      emailQueued = true
    }
  } catch (e) {
    console.error('Diagnostics email send threw', e)
  }

  // The one-time link is always returned even if email delivery failed,
  // so the user can still share it with support manually.
  return new Response(
    JSON.stringify({ success: true, supportLink, token: reportToken, emailQueued }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})
