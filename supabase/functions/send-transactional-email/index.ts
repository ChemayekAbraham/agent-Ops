import * as React from 'npm:react@18.3.1'
import { renderAsync } from 'npm:@react-email/components@0.0.22'
import { createClient } from 'npm:@supabase/supabase-js@2'
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
import { TEMPLATES } from '../_shared/transactional-email-templates/registry.ts'
import { bytesToBase64, renderPartnershipTopupReceipt } from '../_shared/partnerTopupReceiptPdf.ts'
import { renderPayslipPdf, type PayslipPdfData } from '../_shared/payslipPdf.ts'
import {
  isPlaceholderRecipient,
  PLACEHOLDER_SUPPRESSION_REASON,
} from '../_shared/recipientMailbox.ts'

// Configuration baked in at scaffold time — do NOT change these manually.
// To update, re-run the email domain setup flow.
const SITE_NAME = "Welile"
// SENDER_DOMAIN is the verified sender subdomain FQDN (e.g., "notify.example.com").
// It MUST match the subdomain delegated to Lovable's nameservers — never the root domain.
// The email API looks up this exact domain; a mismatch causes "No email domain record found".
const SENDER_DOMAIN = "notify.welile.com"
// FROM_DOMAIN is the domain shown in the From: header (e.g., "example.com").
// When display_from_root is enabled, this can be the root domain for cleaner branding,
// even though actual sending uses the subdomain above.
const FROM_DOMAIN = "welile.com"

// Partner / funder (investor) facing templates. These MUST be sent from the
// partnerships mailbox and have replies routed to partnership@welile.com so a
// partner who hits "Reply" reaches the partnerships team, not a noreply inbox.
const PARTNER_FROM = `Welile Partnerships <partnership@${FROM_DOMAIN}>`
const PARTNER_REPLY_TO = `partnership@${FROM_DOMAIN}`
const PARTNER_FUNDER_TEMPLATES = new Set<string>([
  'returns-disbursement-confirmation',
  'partnership-returns-processing',
  'partner-wallet-deposit',
  'partnership-agreement',
  'partnership-topup',
  'partnership-split-allocation',
  'partner-compound',
  'partner-portfolio-compounded',
  'portfolio-renewal',
  'portfolio-renewal-days-remaining',
  'portfolio-maturity',
  'portfolio-redemption',
  'partnership-maturity-notice',
  'partner-self-managed-cycle-ended',
  'partner-self-managed-deployment',
  'partner-account-created',
  'angel-pool-share-purchase',
  'proxy-managed-payout-notice',
  'portfolio-request-confirmation',
  'tenant-partnership-agreement',
  'portfolio-renewal-apology',
  'partner-portfolio-invite',
  'shareholder-shares-created',
])

// Generate a cryptographically random 32-byte hex token
function generateToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Auth note: this function uses verify_jwt = true in config.toml, so Supabase's
// gateway validates the caller's JWT (anon or service_role) before the request
// reaches this code. No in-function auth check is needed.

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing required environment variables')
    return new Response(
      JSON.stringify({ error: 'Server configuration error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Parse request body
  let templateName: string
  let recipientEmail: string
  let idempotencyKey: string
  let messageId: string
  let templateData: Record<string, any> = {}
  try {
    const body = await req.json()
    templateName = body.templateName || body.template_name
    recipientEmail = body.recipientEmail || body.recipient_email
    messageId = crypto.randomUUID()
    idempotencyKey = body.idempotencyKey || body.idempotency_key || messageId
    if (body.templateData && typeof body.templateData === 'object') {
      templateData = body.templateData
    }
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON in request body' }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  if (!templateName) {
    return new Response(
      JSON.stringify({ error: 'templateName is required' }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // 1. Look up template from registry (early — needed to resolve recipient)
  const template = TEMPLATES[templateName]

  if (!template) {
    console.error('Template not found in registry', { templateName })
    return new Response(
      JSON.stringify({
        error: `Template '${templateName}' not found. Available: ${Object.keys(TEMPLATES).join(', ')}`,
      }),
      {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Resolve effective recipient: template-level `to` takes precedence over
  // the caller-provided recipientEmail. This allows notification templates
  // to always send to a fixed address (e.g., site owner from env var).
  const effectiveRecipient = template.to || recipientEmail

  if (!effectiveRecipient) {
    return new Response(
      JSON.stringify({
        error: 'recipientEmail is required (unless the template defines a fixed recipient)',
      }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Create Supabase client with service role (bypasses RLS)
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // Placeholder / phone-only accounts have no real mailbox. Never hand these to
  // the mail provider — record the skip and return success:false so callers do
  // not treat it as an outage. SMS / in-app notification still reaches them.
  if (isPlaceholderRecipient(effectiveRecipient)) {
    console.log('Email skipped — placeholder recipient', {
      effectiveRecipient,
      templateName,
    })
    await supabase.from('email_send_log').insert({
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'suppressed',
      metadata: {
        suppressed: true,
        suppressed_reason: PLACEHOLDER_SUPPRESSION_REASON,
      },
    })
    return new Response(
      JSON.stringify({ success: false, reason: PLACEHOLDER_SUPPRESSION_REASON }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Partner/funder emails send from the partnerships mailbox with replies
  // routed to partnership@welile.com.
  const isPartnerFunder = PARTNER_FUNDER_TEMPLATES.has(templateName)

  // Hard exclusion: weliletenants@gmail.com is a shared operational inbox and
  // must never receive partner/funder (partnership renewal, maturity, agreement,
  // ROI, etc.) emails — even as a BCC. Block the send here so no code path
  // (auto-renew cron, submit-portfolio-action-request confirmation, etc.) can
  // deliver a partnership email to that mailbox.
  const EXCLUDED_PARTNER_RECIPIENTS = new Set<string>([
    'weliletenants@gmail.com',
  ])
  if (
    isPartnerFunder &&
    EXCLUDED_PARTNER_RECIPIENTS.has(effectiveRecipient.toLowerCase())
  ) {
    console.log('Partnership email blocked for excluded recipient', {
      effectiveRecipient,
      templateName,
    })
    await supabase.from('email_send_log').insert({
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'suppressed',
      metadata: {
        subject:
          typeof template.subject === 'function'
            ? template.subject(templateData)
            : template.subject,
        suppressed: true,
        suppressed_reason: 'partner_recipient_excluded',
      },
    })
    return new Response(
      JSON.stringify({ success: false, reason: 'partner_recipient_excluded' }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Resolve subject — supports static string or dynamic function
  const resolvedSubject =
    typeof template.subject === 'function'
      ? template.subject(templateData)
      : template.subject

  const routingMetadata = {
    subject: resolvedSubject,
    template_data: templateData,
    from: isPartnerFunder ? PARTNER_FROM : `${SITE_NAME} <noreply@${FROM_DOMAIN}>`,
    ...(isPartnerFunder ? { reply_to: PARTNER_REPLY_TO } : {}),
    ...(isPartnerFunder ? { bcc: PARTNER_REPLY_TO } : {}),
  }

  // 2. Check suppression list (fail-closed: if we can't verify, don't send)
  const { data: suppressed, error: suppressionError } = await supabase
    .from('suppressed_emails')
    .select('id')
    .eq('email', effectiveRecipient.toLowerCase())
    .maybeSingle()

  if (suppressionError) {
    console.error('Suppression check failed — refusing to send', {
      error: suppressionError,
      effectiveRecipient,
    })
    return new Response(
      JSON.stringify({ error: 'Failed to verify suppression status' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  if (suppressed) {
    // Log the suppressed attempt
    await supabase.from('email_send_log').insert({
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'suppressed',
      metadata: {
        ...routingMetadata,
        suppressed: true,
        suppressed_reason: 'recipient_suppressed',
      },
    })

    console.log('Email suppressed', { effectiveRecipient, templateName })
    return new Response(
      JSON.stringify({ success: false, reason: 'email_suppressed' }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // 3. Get or create unsubscribe token (one token per email address)
  const normalizedEmail = effectiveRecipient.toLowerCase()
  let unsubscribeToken: string

  // Check for existing token for this email
  const { data: existingToken, error: tokenLookupError } = await supabase
    .from('email_unsubscribe_tokens')
    .select('token, used_at')
    .eq('email', normalizedEmail)
    .maybeSingle()

  if (tokenLookupError) {
    console.error('Token lookup failed', {
      error: tokenLookupError,
      email: normalizedEmail,
    })
    await supabase.from('email_send_log').insert({
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'failed',
      error_message: 'Failed to look up unsubscribe token',
    })
    return new Response(
      JSON.stringify({ error: 'Failed to prepare email' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  if (existingToken && !existingToken.used_at) {
    // Reuse existing unused token
    unsubscribeToken = existingToken.token
  } else if (!existingToken) {
    // Create new token — upsert handles concurrent inserts gracefully
    unsubscribeToken = generateToken()
    const { error: tokenError } = await supabase
      .from('email_unsubscribe_tokens')
      .upsert(
        { token: unsubscribeToken, email: normalizedEmail },
        { onConflict: 'email', ignoreDuplicates: true }
      )

    if (tokenError) {
      console.error('Failed to create unsubscribe token', {
        error: tokenError,
      })
      await supabase.from('email_send_log').insert({
        message_id: messageId,
        template_name: templateName,
        recipient_email: effectiveRecipient,
        status: 'failed',
        error_message: 'Failed to create unsubscribe token',
      })
      return new Response(
        JSON.stringify({ error: 'Failed to prepare email' }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    // If another request raced us, our upsert was silently ignored.
    // Re-read to get the actual stored token.
    const { data: storedToken, error: reReadError } = await supabase
      .from('email_unsubscribe_tokens')
      .select('token')
      .eq('email', normalizedEmail)
      .maybeSingle()

    if (reReadError || !storedToken) {
      console.error('Failed to read back unsubscribe token after upsert', {
        error: reReadError,
        email: normalizedEmail,
      })
      await supabase.from('email_send_log').insert({
        message_id: messageId,
        template_name: templateName,
        recipient_email: effectiveRecipient,
        status: 'failed',
        error_message: 'Failed to confirm unsubscribe token storage',
      })
      return new Response(
        JSON.stringify({ error: 'Failed to prepare email' }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }
    unsubscribeToken = storedToken.token
  } else {
    // Token exists but is already used — email should have been caught by suppression check above.
    // This is a safety fallback; log and skip sending.
    console.warn('Unsubscribe token already used but email not suppressed', {
      email: normalizedEmail,
    })
    await supabase.from('email_send_log').insert({
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'suppressed',
      error_message:
        'Unsubscribe token used but email missing from suppressed list',
    })
    return new Response(
      JSON.stringify({ success: false, reason: 'email_suppressed' }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // 4. Render React Email template to HTML and plain text
  const html = await renderAsync(
    React.createElement(template.component, templateData)
  )
  const plainText = await renderAsync(
    React.createElement(template.component, templateData),
    { plainText: true }
  )

  // Partnership top-ups carry a compact PDF receipt generated from the same
  // live values used in the email body. It is base64-encoded only for the
  // short-lived queue message; the dispatcher turns it back into multipart
  // Mailgun attachment data.
  let attachment: Record<string, string> | undefined
  if (templateName === 'partnership-topup') {
    const pdfBytes = await renderPartnershipTopupReceipt({
      receiptNumber: String(templateData.receipt_number || messageId),
      effectiveAt: String(templateData.effective_datetime || new Date().toISOString()),
      topupAmount: Number(templateData.topup_amount) || 0,
      portfolioId: String(templateData.parent_portfolio_id || '—'),
      portfolioName: String(templateData.portfolio_name || 'Partnership Portfolio'),
      previousPrincipal: Number(templateData.previous_portfolio_value) || 0,
      newTotalPrincipal: Number(templateData.new_total_partnership_value) || 0,
      partnerName: String(templateData.partner_name || 'Partner'),
      partnerId: String(templateData.partner_id || '—'),
      portfoliosToppedUpCount: Number(templateData.portfolios_topped_up_count) || 1,
      createdAt: String(templateData.created_at || new Date().toISOString()),
      reviewedBy: String(templateData.reviewed_by || 'System'),
    })
    attachment = {
      filename: `${String(templateData.receipt_number || messageId)}.pdf`,
      content_base64: bytesToBase64(pdfBytes),
      content_type: 'application/pdf',
    }
  } else if (
    templateName === 'angel-pool-share-purchase' &&
    typeof templateData.contract_pdf_path === 'string' &&
    /^share-agreements\/[0-9a-f-]{36}\.pdf$/.test(templateData.contract_pdf_path)
  ) {
    // Shares Onboarding: attach the countersigned shareholders agreement.
    const { data: pdfBlob, error: pdfErr } = await supabase.storage
      .from('partner-agreements')
      .download(templateData.contract_pdf_path)
    if (pdfErr || !pdfBlob) {
      console.error('Share agreement attachment missing', pdfErr)
    } else {
      attachment = {
        filename: String(templateData.contract_pdf_name || 'Welile-Angel-Pool-Agreement.pdf'),
        content_base64: bytesToBase64(new Uint8Array(await pdfBlob.arrayBuffer())),
        content_type: 'application/pdf',
      }
    }
  }

  // Salary payslips carry a PDF copy built from the same figures as the email.
  // A PDF failure never blocks the email — it is sent without the attachment.
  if (templateName === 'salary-payslip' && !attachment) {
    try {
      const pdfBytes = await renderPayslipPdf(templateData as PayslipPdfData)
      const ref = String((templateData as any).staff_ref || 'staff').replace(/[^A-Za-z0-9-]/g, '')
      const period = String((templateData as any).period_label || '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
      attachment = {
        filename: `Welile-Payslip-${period}-${ref}.pdf`,
        content_base64: bytesToBase64(pdfBytes),
        content_type: 'application/pdf',
      }
    } catch (pdfErr) {
      console.error('Payslip PDF generation failed — sending without attachment', pdfErr)
    }
  }

  // 5. Enqueue the pre-rendered email for async processing by the dispatcher.
  // The dispatcher (process-email-queue) handles sending, retries, and rate-limit backoff.

  // Log pending BEFORE enqueue so we have a record even if enqueue crashes
  await supabase.from('email_send_log').insert({
    message_id: messageId,
    template_name: templateName,
    recipient_email: effectiveRecipient,
    status: 'pending',
    // Record routing details (subject, from, reply_to, bcc) so the CTO Emails
    // admin view can verify partner/funder mail was BCC'd to partnership@welile.com.
    metadata: routingMetadata,
  })

  const { error: enqueueError } = await supabase.rpc('enqueue_email', {
    queue_name: 'transactional_emails',
    payload: {
      message_id: messageId,
      to: effectiveRecipient,
      from: isPartnerFunder ? PARTNER_FROM : `${SITE_NAME} <noreply@${FROM_DOMAIN}>`,
      sender_domain: SENDER_DOMAIN,
      ...(isPartnerFunder ? { reply_to: PARTNER_REPLY_TO } : {}),
      // BCC the partnerships mailbox on partner/funder emails so a filtered
      // copy lands in the partnership@welile.com folder for record-keeping.
      ...(isPartnerFunder ? { bcc: PARTNER_REPLY_TO } : {}),
      subject: resolvedSubject,
      html,
      text: plainText,
      ...(attachment ? { attachment } : {}),
      purpose: 'transactional',
      label: templateName,
      idempotency_key: idempotencyKey,
      unsubscribe_token: unsubscribeToken,
      queued_at: new Date().toISOString(),
    },
  })

  if (enqueueError) {
    console.error('Failed to enqueue email', {
      error: enqueueError,
      templateName,
      effectiveRecipient,
    })

    await supabase.from('email_send_log').insert({
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'failed',
      error_message: 'Failed to enqueue email',
    })

    return new Response(JSON.stringify({ error: 'Failed to enqueue email' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  console.log('Transactional email enqueued', { templateName, effectiveRecipient })

  return new Response(
    JSON.stringify({ success: true, queued: true }),
    {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  )
})
