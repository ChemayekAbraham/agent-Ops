// Resend the latest stored partner agreement PDF without regenerating it.
// Used when an already counter-signed agreement needs to be resent, including
// a direct partnerships mailbox copy for audit even if the partner address is suppressed.
import { createClient } from 'npm:@supabase/supabase-js@2'
import * as React from 'npm:react@18.3.1'
import { renderAsync } from 'npm:@react-email/components@0.0.22'
import { template as tenantPartnershipAgreementTemplate } from '../_shared/transactional-email-templates/tenant-partnership-agreement.tsx'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const PARTNERSHIP_EMAIL = 'partnership@welile.com'
const FROM_DOMAIN = 'welile.com'
const SENDER_DOMAIN = 'notify.welile.com'
const PARTNER_FROM = `Welile Partnerships <partnership@${FROM_DOMAIN}>`

class MailgunError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'MailgunError'
    this.status = status
  }
}

async function sendDirectMailgun(payload: {
  to: string
  from: string
  replyTo?: string
  bcc?: string
  subject: string
  html: string
  text: string
}) {
  const apiKey = Deno.env.get('MAILGUN_API_KEY')
  const domain = Deno.env.get('MAILGUN_DOMAIN') || SENDER_DOMAIN
  const baseUrl = Deno.env.get('MAILGUN_API_BASE') || 'https://api.mailgun.net'
  if (!apiKey) throw new Error('MAILGUN_API_KEY is not configured')

  const form = new URLSearchParams()
  form.set('from', payload.from)
  form.set('to', payload.to)
  form.set('subject', payload.subject)
  form.set('html', payload.html)
  form.set('text', payload.text)
  if (payload.replyTo) form.set('h:Reply-To', payload.replyTo)
  if (payload.bcc) form.set('bcc', payload.bcc)

  const res = await fetch(`${baseUrl}/v3/${domain}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`api:${apiKey}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  })
  const body = await res.text().catch(() => '')
  if (!res.ok) throw new MailgunError(res.status, `Mailgun send failed [${res.status}]: ${body.slice(0, 500)}`)
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
const SCALES = ['', 'Thousand', 'Million', 'Billion', 'Trillion']

function threeDigits(n: number): string {
  const parts: string[] = []
  const h = Math.floor(n / 100)
  const r = n % 100
  if (h > 0) parts.push(`${ONES[h]} Hundred`)
  if (r > 0) {
    if (r < 20) parts.push(ONES[r])
    else {
      const t = Math.floor(r / 10)
      const o = r % 10
      parts.push(o > 0 ? `${TENS[t]}-${ONES[o]}` : TENS[t])
    }
  }
  return parts.join(' ')
}

function numberToWords(value: number): string {
  const n = Math.floor(Math.abs(value || 0))
  if (n === 0) return 'Zero'
  const groups: number[] = []
  let rem = n
  while (rem > 0) {
    groups.push(rem % 1000)
    rem = Math.floor(rem / 1000)
  }
  const words: string[] = []
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i] === 0) continue
    const chunk = threeDigits(groups[i])
    const scale = SCALES[i]
    words.push(scale ? `${chunk} ${scale}` : chunk)
  }
  return words.join(' ').replace(/\s+/g, ' ').trim()
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function isAuthorized(admin: ReturnType<typeof createClient>, userId: string) {
  const [{ data: isOps }, { data: isManager }, { data: isSuperAdmin }] = await Promise.all([
    admin.rpc('is_ops_role', { _user_id: userId }),
    admin.rpc('has_role', { _user_id: userId, _role: 'manager' }),
    admin.rpc('has_role', { _user_id: userId, _role: 'super_admin' }),
  ])
  return isOps === true || isManager === true || isSuperAdmin === true
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405)

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceKey) return json({ error: 'Server configuration error' }, 500)

    const admin = createClient(supabaseUrl, serviceKey)
    const authHeader = req.headers.get('authorization') || req.headers.get('Authorization') || ''
    const token = authHeader.replace('Bearer ', '').trim()
    if (!token) return json({ error: 'Unauthorized' }, 401)

    const { data: userData, error: userErr } = await admin.auth.getUser(token)
    if (userErr || !userData?.user) return json({ error: 'Unauthorized' }, 401)
    if (!(await isAuthorized(admin, userData.user.id))) return json({ error: 'Insufficient permissions' }, 403)

    const body = await req.json().catch(() => ({}))
    const partnerId = String(body?.partnerId || '').trim()
    const forcePartner = body?.forcePartner === true
    const processNow = body?.processNow === true
    if (!partnerId) return json({ error: 'partnerId is required' }, 400)

    const { data: row, error: rowErr } = await admin
      .from('partner_agreements')
      .select('*')
      .eq('partner_id', partnerId)
      .maybeSingle()
    if (rowErr) return json({ error: rowErr.message }, 500)
    if (!row) return json({ error: 'Agreement not found' }, 404)
    if (!row.generated_pdf_path) return json({ error: 'No generated agreement PDF is stored for this partner' }, 422)

    const { data: signed, error: signErr } = await admin.storage
      .from('partner-agreements')
      .createSignedUrl(row.generated_pdf_path, 60 * 60 * 24 * 365)
    if (signErr) return json({ error: signErr.message }, 500)

    const amountNum = Math.max(0, Math.floor(Number(row.partnership_amount) || 0))
    const payoutSummary = row.payout_mode !== 'momo'
      ? [row.bank_name, row.bank_account_number].filter(Boolean).join(' ') || 'Bank Transfer'
      : [row.momo_provider, row.momo_number].filter(Boolean).join(' ') || 'Mobile Money'

    // Resolve the partner's real ROI% from their most recent portfolio so
    // partners on non-default rates (e.g. 20%) never see a hardcoded 15%.
    let monthlyReturnLabel = '15%'
    try {
      const { data: portfolio } = await admin
        .from('investor_portfolios')
        .select('roi_percentage, created_at, status')
        .eq('investor_id', partnerId)
        .not('roi_percentage', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const pct = Number(portfolio?.roi_percentage)
      if (Number.isFinite(pct) && pct > 0) {
        monthlyReturnLabel = `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/\.?0+$/, '')}%`
      }
    } catch (e) {
      console.warn('roi_percentage lookup failed, falling back to 15%:', e)
    }

    const templateData = {
      partner_name: row.full_name || 'Partner',
      partner_email: row.email || '',
      partner_reference: row.reference || `PA-${partnerId.slice(0, 8).toUpperCase()}`,
      partnership_amount: `UGX ${amountNum.toLocaleString('en-US')}`,
      partnership_amount_words: row.partnership_amount_words || numberToWords(amountNum),
      monthly_return: monthlyReturnLabel,
      payout_summary: payoutSummary,
      agreement_download_url: signed?.signedUrl || 'https://welileapp.com',
      company_name: 'WELILE TECHNOLOGIES LTD',
    }

    const results: Record<string, unknown> = {}

    if (row.email) {
      const normalized = String(row.email).toLowerCase()
      if (forcePartner) {
        await admin.from('suppressed_emails').delete().eq('email', normalized)
        await admin.from('email_unsubscribe_tokens').update({ used_at: null }).eq('email', normalized)
      }

      const { data, error } = await admin.functions.invoke('send-transactional-email', {
        body: {
          templateName: 'tenant-partnership-agreement',
          recipientEmail: row.email,
          idempotencyKey: `partner-agreement-resend-${row.id}-${crypto.randomUUID()}`,
          templateData,
        },
      })
      results.partner = error ? { error: error.message } : data
    }

    const partnershipTemplateData = {
      ...templateData,
      original_partner_email: row.email || null,
      audit_copy_reason: forcePartner ? 'forced_partner_resend' : 'partner_agreement_resend',
    }
    const subject = typeof tenantPartnershipAgreementTemplate.subject === 'function'
      ? tenantPartnershipAgreementTemplate.subject(partnershipTemplateData)
      : tenantPartnershipAgreementTemplate.subject
    const html = await renderAsync(React.createElement(tenantPartnershipAgreementTemplate.component, partnershipTemplateData))
    const text = await renderAsync(React.createElement(tenantPartnershipAgreementTemplate.component, partnershipTemplateData), { plainText: true })
    const directMessageId = crypto.randomUUID()

    await admin.from('email_send_log').insert({
      message_id: directMessageId,
      template_name: 'tenant-partnership-agreement',
      recipient_email: PARTNERSHIP_EMAIL,
      status: 'pending',
      metadata: {
        subject,
        template_data: partnershipTemplateData,
        from: PARTNER_FROM,
        reply_to: PARTNERSHIP_EMAIL,
        bcc: PARTNERSHIP_EMAIL,
        direct_resend: true,
      },
    })

    try {
      await sendDirectMailgun({
        to: PARTNERSHIP_EMAIL,
        from: PARTNER_FROM,
        replyTo: PARTNERSHIP_EMAIL,
        bcc: PARTNERSHIP_EMAIL,
        subject,
        html,
        text,
      })
      await admin.from('email_send_log').insert({
        message_id: directMessageId,
        template_name: 'tenant-partnership-agreement',
        recipient_email: PARTNERSHIP_EMAIL,
        status: 'sent',
        metadata: {
          subject,
          template_data: partnershipTemplateData,
          from: PARTNER_FROM,
          reply_to: PARTNERSHIP_EMAIL,
          bcc: PARTNERSHIP_EMAIL,
          direct_resend: true,
        },
      })
      results.partnership = { success: true, direct: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await admin.from('email_send_log').insert({
        message_id: directMessageId,
        template_name: 'tenant-partnership-agreement',
        recipient_email: PARTNERSHIP_EMAIL,
        status: 'failed',
        error_message: message.slice(0, 1000),
        metadata: {
          subject,
          template_data: partnershipTemplateData,
          from: PARTNER_FROM,
          reply_to: PARTNERSHIP_EMAIL,
          bcc: PARTNERSHIP_EMAIL,
          direct_resend: true,
        },
      })
      results.partnership = { success: false, error: message }
    }

    if (processNow) {
      const processRes = await fetch(`${supabaseUrl}/functions/v1/process-email-queue`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'partner_agreement_resend' }),
      })
      results.processed = await processRes.json().catch(() => ({ ok: processRes.ok }))
    }

    return json({ ok: true, partnerEmail: row.email || null, partnershipEmail: PARTNERSHIP_EMAIL, results })
  } catch (error) {
    console.error('resend-partner-agreement-email error:', error)
    return json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500)
  }
})