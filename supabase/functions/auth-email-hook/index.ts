import * as React from 'npm:react@18.3.1'
import { renderAsync } from 'npm:@react-email/components@0.0.22'
import { parseEmailWebhookPayload } from 'npm:@lovable.dev/email-js'
import { WebhookError, verifyWebhookRequest } from 'npm:@lovable.dev/webhooks-js'
import { Webhook } from 'npm:standardwebhooks@1.0.0'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { SignupEmail } from '../_shared/email-templates/signup.tsx'
import { InviteEmail } from '../_shared/email-templates/invite.tsx'
import { MagicLinkEmail } from '../_shared/email-templates/magic-link.tsx'
import { RecoveryEmail } from '../_shared/email-templates/recovery.tsx'
import { EmailChangeEmail } from '../_shared/email-templates/email-change.tsx'
import { ReauthenticationEmail } from '../_shared/email-templates/reauthentication.tsx'
import {
  ensureWelileEmailHeader,
  ensureWelileEmailTextHeader,
} from '../_shared/emailHeader.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-lovable-signature, x-lovable-timestamp, webhook-id, webhook-timestamp, webhook-signature, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

const EMAIL_SUBJECTS: Record<string, string> = {
  signup: 'Confirm your email',
  invite: "You've been invited",
  magiclink: 'Your login link',
  recovery: 'Reset your password',
  email_change: 'Confirm your new email',
  reauthentication: 'Your verification code',
}

// Template mapping
const EMAIL_TEMPLATES: Record<string, React.ComponentType<any>> = {
  signup: SignupEmail,
  invite: InviteEmail,
  magiclink: MagicLinkEmail,
  recovery: RecoveryEmail,
  email_change: EmailChangeEmail,
  reauthentication: ReauthenticationEmail,
}

// Configuration
const SITE_NAME = "Welile"
const SENDER_DOMAIN = "notify.welile.com"
const ROOT_DOMAIN = "welile.com"
const FROM_DOMAIN = "welile.com" // Domain shown in From address (may be root or sender subdomain)

// Sample data for preview mode ONLY (not used in actual email sending).
// URLs are baked in at scaffold time from the project's real data.
// The sample email uses a fixed placeholder (RFC 6761 .test TLD) so the Go backend
// can always find-and-replace it with the actual recipient when sending test emails,
// even if the project's domain has changed since the template was scaffolded.
const SAMPLE_PROJECT_URL = "https://welileapp.com"
const SAMPLE_EMAIL = "user@example.test"
const SAMPLE_DATA: Record<string, object> = {
  signup: {
    siteName: SITE_NAME,
    siteUrl: SAMPLE_PROJECT_URL,
    recipient: SAMPLE_EMAIL,
    confirmationUrl: SAMPLE_PROJECT_URL,
  },
  magiclink: {
    siteName: SITE_NAME,
    confirmationUrl: SAMPLE_PROJECT_URL,
  },
  recovery: {
    siteName: SITE_NAME,
    confirmationUrl: SAMPLE_PROJECT_URL,
  },
  invite: {
    siteName: SITE_NAME,
    siteUrl: SAMPLE_PROJECT_URL,
    confirmationUrl: SAMPLE_PROJECT_URL,
  },
  email_change: {
    siteName: SITE_NAME,
    email: SAMPLE_EMAIL,
    newEmail: SAMPLE_EMAIL,
    confirmationUrl: SAMPLE_PROJECT_URL,
  },
  reauthentication: {
    token: '123456',
  },
}

// Preview endpoint handler - returns rendered HTML without sending email
async function handlePreview(req: Request): Promise<Response> {
  const previewCorsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: previewCorsHeaders })
  }

  const apiKey = Deno.env.get('LOVABLE_API_KEY')
  const authHeader = req.headers.get('Authorization')

  if (!apiKey || authHeader !== `Bearer ${apiKey}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...previewCorsHeaders, 'Content-Type': 'application/json' },
    })
  }

  let type: string
  try {
    const body = await req.json()
    type = body.type
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Invalid JSON in request body' }), {
      status: 400,
      headers: { ...previewCorsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const EmailTemplate = EMAIL_TEMPLATES[type]

  if (!EmailTemplate) {
    return new Response(JSON.stringify({ error: `Unknown email type: ${type}` }), {
      status: 400,
      headers: { ...previewCorsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const sampleData = SAMPLE_DATA[type] || {}
  const html = ensureWelileEmailHeader(await renderAsync(React.createElement(EmailTemplate, sampleData)))

  return new Response(html, {
    status: 200,
    headers: { ...previewCorsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
  })
}

// Webhook handler - verifies signature and sends email
async function handleWebhook(req: Request): Promise<Response> {
  const apiKey = Deno.env.get('LOVABLE_API_KEY')

  if (!apiKey) {
    console.error('LOVABLE_API_KEY not configured')
    return new Response(
      JSON.stringify({ error: 'Server configuration error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Verify signature + timestamp, then parse payload.
  let payload: any
  let run_id = ''
  try {
    const verified = await verifyWebhookRequest({
      req,
      secret: apiKey,
      parser: parseEmailWebhookPayload,
    })
    payload = verified.payload
    run_id = payload.run_id
  } catch (error) {
    if (error instanceof WebhookError) {
      switch (error.code) {
        case 'invalid_signature':
        case 'missing_timestamp':
        case 'invalid_timestamp':
        case 'stale_timestamp':
          console.error('Invalid webhook signature', { error: error.message })
          return new Response(JSON.stringify({ error: 'Invalid signature' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          })
        case 'invalid_payload':
        case 'invalid_json':
          console.error('Invalid webhook payload', { error: error.message })
          return new Response(
            JSON.stringify({ error: 'Invalid webhook payload' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
      }
    }

    console.error('Webhook verification failed', { error })
    return new Response(
      JSON.stringify({ error: 'Invalid webhook payload' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  if (!run_id) {
    console.error('Webhook payload missing run_id')
    return new Response(
      JSON.stringify({ error: 'Invalid webhook payload' }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  if (payload.version !== '1') {
    console.error('Unsupported payload version', { version: payload.version, run_id })
    return new Response(
      JSON.stringify({ error: `Unsupported payload version: ${payload.version}` }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // The email action type is in payload.data.action_type (e.g., "signup", "recovery")
  // payload.type is the hook event type ("auth")
  const emailType = payload.data.action_type
  console.log('Received auth event', { emailType, email: payload.data.email, run_id })

  const EmailTemplate = EMAIL_TEMPLATES[emailType]
  if (!EmailTemplate) {
    console.error('Unknown email type', { emailType, run_id })
    return new Response(
      JSON.stringify({ error: `Unknown email type: ${emailType}` }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Build template props from payload.data (HookData structure)
  const templateProps = {
    siteName: SITE_NAME,
    siteUrl: `https://${ROOT_DOMAIN}`,
    recipient: payload.data.email,
    confirmationUrl: payload.data.url,
    token: payload.data.token,
    email: payload.data.email,
    newEmail: payload.data.new_email,
  }

  const result = await renderAndEnqueue(emailType, payload.data.email, templateProps, run_id)
  if (!result.ok) {
    return new Response(JSON.stringify({ error: 'Failed to enqueue email' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  return new Response(
    JSON.stringify({ success: true, queued: true }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

// Render a template and put it on the auth_emails queue. process-email-queue
// delivers it through Mailgun (MAILGUN_API_KEY / MAILGUN_DOMAIN).
async function renderAndEnqueue(
  emailType: string,
  to: string,
  templateProps: Record<string, unknown>,
  run_id: string,
): Promise<{ ok: boolean }> {
  const EmailTemplate = EMAIL_TEMPLATES[emailType]

  // Render React Email to HTML and plain text
  const html = ensureWelileEmailHeader(await renderAsync(React.createElement(EmailTemplate, templateProps)))
  const text = ensureWelileEmailTextHeader(await renderAsync(React.createElement(EmailTemplate, templateProps), {
    plainText: true,
  }))

  // Enqueue email for async processing by the dispatcher (process-email-queue).
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const messageId = crypto.randomUUID()

  // Log pending BEFORE enqueue so we have a record even if enqueue crashes
  await supabase.from('email_send_log').insert({
    message_id: messageId,
    template_name: emailType,
    recipient_email: to,
    status: 'pending',
  })

  const { error: enqueueError } = await supabase.rpc('enqueue_email', {
    queue_name: 'auth_emails',
    payload: {
      run_id,
      message_id: messageId,
      to,
      from: `${SITE_NAME} <noreply@${FROM_DOMAIN}>`,
      sender_domain: SENDER_DOMAIN,
      subject: EMAIL_SUBJECTS[emailType] || 'Notification',
      html,
      text,
      purpose: 'transactional',
      label: emailType,
      queued_at: new Date().toISOString(),
    },
  })

  if (enqueueError) {
    console.error('Failed to enqueue auth email', { error: enqueueError, run_id, emailType })
    await supabase.from('email_send_log').insert({
      message_id: messageId,
      template_name: emailType,
      recipient_email: to,
      status: 'failed',
      error_message: 'Failed to enqueue email',
    })
    return { ok: false }
  }

  console.log('Auth email enqueued', { emailType, email: to, run_id })
  return { ok: true }
}

// Supabase Auth "Send Email" hook (Standard Webhooks signature). Since the move
// off Lovable Cloud nothing sends Lovable-signed auth webhooks, so without this
// path Supabase falls back to its built-in mailer and its few-per-hour quota
// ("email rate limit exceeded"). Configure the hook in the dashboard with this
// function's URL and store its secret as SEND_EMAIL_HOOK_SECRET.
const SUPABASE_ACTION_TO_TEMPLATE: Record<string, string> = {
  signup: 'signup',
  invite: 'invite',
  magiclink: 'magiclink',
  email: 'magiclink',
  recovery: 'recovery',
  email_change: 'email_change',
  reauthentication: 'reauthentication',
}

function hookError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { http_code: status, message } }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function handleSupabaseHook(req: Request): Promise<Response> {
  const rawSecret = Deno.env.get('SEND_EMAIL_HOOK_SECRET')
  if (!rawSecret) {
    console.error('SEND_EMAIL_HOOK_SECRET not configured')
    return hookError(500, 'Server configuration error')
  }

  const body = await req.text()
  let payload: any
  try {
    const wh = new Webhook(rawSecret.replace(/^v1,whsec_/, ''))
    payload = wh.verify(body, Object.fromEntries(req.headers))
  } catch (error) {
    console.error('Invalid Supabase hook signature', { error: (error as Error).message })
    return hookError(401, 'Invalid signature')
  }

  const user = payload?.user
  const data = payload?.email_data
  const actionType: string = data?.email_action_type
  const emailType = SUPABASE_ACTION_TO_TEMPLATE[actionType]
  if (!user?.email || !emailType) {
    console.error('Unsupported Supabase hook payload', { actionType })
    return hookError(400, `Unknown email type: ${actionType}`)
  }

  const run_id = req.headers.get('webhook-id') || crypto.randomUUID()
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const verifyUrl = (tokenHash: string) =>
    `${supabaseUrl}/auth/v1/verify?token=${encodeURIComponent(tokenHash)}` +
    `&type=${encodeURIComponent(actionType)}` +
    `&redirect_to=${encodeURIComponent(data.redirect_to || data.site_url || SAMPLE_PROJECT_URL)}`

  const base = {
    siteName: SITE_NAME,
    siteUrl: `https://${ROOT_DOMAIN}`,
    email: user.email,
    newEmail: user.new_email,
  }

  // Secure email change sends two links. Supabase's naming is inverted here:
  // token_hash_new goes to the CURRENT address, token_hash to the NEW one.
  const sends: Array<{ to: string; props: Record<string, unknown> }> = []
  if (actionType === 'email_change' && user.new_email) {
    if (data.token_hash_new) {
      sends.push({ to: user.email, props: { ...base, recipient: user.email, confirmationUrl: verifyUrl(data.token_hash_new), token: data.token_new } })
    }
    if (data.token_hash) {
      sends.push({ to: user.new_email, props: { ...base, recipient: user.new_email, confirmationUrl: verifyUrl(data.token_hash), token: data.token } })
    }
  } else {
    sends.push({
      to: user.email,
      props: { ...base, recipient: user.email, confirmationUrl: verifyUrl(data.token_hash), token: data.token },
    })
  }

  console.log('Received Supabase auth hook', { emailType, email: user.email, run_id })
  for (const s of sends) {
    const result = await renderAndEnqueue(emailType, s.to, s.props, run_id)
    if (!result.ok) return hookError(500, 'Failed to enqueue email')
  }

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const url = new URL(req.url)

  // Handle CORS preflight for main endpoint
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  // Route to preview handler for /preview path
  if (url.pathname.endsWith('/preview')) {
    return handlePreview(req)
  }

  // Main webhook handler. Supabase Auth's hook signs with Standard Webhooks
  // headers; Lovable's signs with x-lovable-signature.
  try {
    if (req.headers.get('webhook-signature')) {
      return await handleSupabaseHook(req)
    }
    return await handleWebhook(req)
  } catch (error) {
    console.error('Webhook handler error:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
