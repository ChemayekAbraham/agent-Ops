// Send a ready-built MIME message through the Mailgun API
// (POST {MAILGUN_API_BASE}/v3/{MAILGUN_DOMAIN}/messages.mime).
//
// Used by the functions that used to post the same MIME to Lovable's Gmail
// connector gateway. The Gmail connector does not carry over to our own
// Supabase project, so every outbound email goes through Mailgun instead
// (same secrets as process-email-queue: MAILGUN_API_KEY, MAILGUN_DOMAIN,
// MAILGUN_API_BASE).
//
// `recipients` is the delivery envelope: Mailgun's .mime endpoint delivers only
// to the addresses passed here, so Cc/Bcc addresses must be included too.
// A From header is added when the MIME has none (Gmail used to fill it in).

export const DEFAULT_MAILGUN_FROM = 'Welile Reports <reports@welile.com>'

export interface MailgunSendResult {
  ok: boolean
  status: number
  raw: string
}

export async function sendMimeViaMailgun(
  recipients: string | string[],
  mime: string,
  from: string = DEFAULT_MAILGUN_FROM,
): Promise<MailgunSendResult> {
  const apiKey = Deno.env.get('MAILGUN_API_KEY')
  const domain = Deno.env.get('MAILGUN_DOMAIN')
  const base = Deno.env.get('MAILGUN_API_BASE') || 'https://api.mailgun.net'
  if (!apiKey || !domain) {
    return { ok: false, status: 0, raw: 'MAILGUN_API_KEY / MAILGUN_DOMAIN not configured' }
  }

  const to = (Array.isArray(recipients) ? recipients : [recipients])
    .map((r) => r.trim())
    .filter(Boolean)
  if (to.length === 0) return { ok: false, status: 0, raw: 'no recipients' }

  const headerEnd = mime.indexOf('\r\n\r\n')
  const headers = headerEnd >= 0 ? mime.slice(0, headerEnd) : mime
  const message = /^from:/im.test(headers) ? mime : `From: ${from}\r\n${mime}`

  const form = new FormData()
  form.append('to', to.join(','))
  form.append('message', new Blob([message], { type: 'message/rfc822' }), 'message.mime')

  const res = await fetch(`${base}/v3/${domain}/messages.mime`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`api:${apiKey}`)}` },
    body: form,
  })
  return { ok: res.ok, status: res.status, raw: await res.text() }
}
