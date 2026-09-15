import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  isPlaceholderRecipient,
  PLACEHOLDER_SUPPRESSION_REASON,
} from '../_shared/recipientMailbox.ts'

const DEFAULT_MAX_ATTEMPTS = 1
const WALLET_CONFIRMATION_MAX_ATTEMPTS = 5
const WALLET_CONFIRMATION_RETRY_DELAYS_SECONDS = [60, 120, 300, 600]
// A suppressed recipient is not a failure — put the message back and try again
// in 2 minutes instead of burning a retry.
const SUPPRESSION_RETRY_SECONDS = 120
const DEFAULT_BATCH_SIZE = 10
const DEFAULT_SEND_DELAY_MS = 200
const DEFAULT_AUTH_TTL_MINUTES = 15
const DEFAULT_TRANSACTIONAL_TTL_MINUTES = 60

// Default sender for any email enqueued without an explicit `from`.
// Non-partner mail (landlord, agent, tenant, receipts, reports, etc.) MUST
// go out from the noreply mailbox. Partner/funder emails always set their own
// `from` (Welile Partnerships <partnership@welile.com>) upstream, so this
// fallback never overrides them.
const FROM_DOMAIN = 'welile.com'
const DEFAULT_FROM = `Welile <noreply@${FROM_DOMAIN}>`

// Check if an error is a rate-limit (429) response.
// Uses EmailAPIError.status when available (email-js >=0.x with structured errors),
// falls back to parsing the error message for older versions.
function isRateLimited(error: unknown): boolean {
  if (error && typeof error === 'object' && 'status' in error) {
    return (error as { status: number }).status === 429
  }
  return error instanceof Error && error.message.includes('429')
}

// Check if an error is a forbidden (403) response, which means emails are
// disabled for this project. Retrying won't help — move straight to DLQ.
function isForbidden(error: unknown): boolean {
  if (error && typeof error === 'object' && 'status' in error) {
    return (error as { status: number }).status === 403
  }
  return error instanceof Error && error.message.includes('403')
}

function getErrorStatus(error: unknown): number | null {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = Number((error as { status: unknown }).status)
    return Number.isFinite(status) ? status : null
  }
  return null
}

function isRetryableDeliveryFailure(error: unknown): boolean {
  const status = getErrorStatus(error)
  if (status !== null) return status >= 500
  // Network and transport failures do not carry an HTTP status. These are
  // transient, unlike provider 4xx responses such as an invalid recipient.
  return error instanceof TypeError ||
    (error instanceof Error && /network|fetch|timeout|connection/i.test(error.message))
}

function maxAttemptsFor(payload: Record<string, unknown>): number {
  return payload.label === 'cash-deposit-wallet-confirmation'
    ? WALLET_CONFIRMATION_MAX_ATTEMPTS
    : DEFAULT_MAX_ATTEMPTS
}

function retryDelayFor(failedAttempts: number): number {
  const delayIndex = Math.min(
    Math.max(failedAttempts, 0),
    WALLET_CONFIRMATION_RETRY_DELAYS_SECONDS.length - 1,
  )
  return WALLET_CONFIRMATION_RETRY_DELAYS_SECONDS[delayIndex]
}

// 401 = Mailgun credential problem (disabled/rotated/wrong-region API key).
// This is an infrastructure outage, NOT a bad message: never DLQ these, or a
// single expired key silently destroys every queued email platform-wide.
function isAuthFailure(error: unknown): boolean {
  if (error && typeof error === 'object' && 'status' in error) {
    return (error as { status: number }).status === 401
  }
  return error instanceof Error && error.message.includes('[401]')
}



// Extract Retry-After seconds from a structured EmailAPIError, or default to 60s.
function getRetryAfterSeconds(error: unknown): number {
  if (error && typeof error === 'object' && 'retryAfterSeconds' in error) {
    return (error as { retryAfterSeconds: number | null }).retryAfterSeconds ?? 60
  }
  return 60
}

// ---------------------------------------------------------------------------
// Mailgun transport (US region).
// All queued email (auth + transactional) is delivered through Mailgun's
// HTTP API using the verified sending domain. Errors are thrown with a
// `.status` property so the existing 429/403 handling below still applies.
// ---------------------------------------------------------------------------
interface MailgunConfig {
  apiKey: string
  domain: string
  baseUrl: string
}

class MailgunError extends Error {
  status: number
  retryAfterSeconds: number | null
  constructor(status: number, message: string, retryAfterSeconds: number | null = null) {
    super(message)
    this.name = 'MailgunError'
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

async function sendViaMailgun(
  payload: {
    to: string
    from: string
    reply_to?: string
    bcc?: string
    subject?: string
    html?: string
    text?: string
    idempotency_key?: string
    attachment?: {
      filename: string
      content_base64: string
      content_type?: string
    }
  },
  cfg: MailgunConfig
): Promise<void> {
  const hasAttachment = Boolean(payload.attachment?.content_base64 && payload.attachment.filename)
  let body: BodyInit
  const headers: Record<string, string> = {
    Authorization: `Basic ${btoa(`api:${cfg.apiKey}`)}`,
  }
  if (hasAttachment && payload.attachment) {
    const form = new FormData()
    form.set('from', payload.from)
    form.set('to', payload.to)
    form.set('subject', payload.subject ?? '')
    if (payload.html) form.set('html', payload.html)
    if (payload.text) form.set('text', payload.text)
    if (payload.reply_to) form.set('h:Reply-To', payload.reply_to)
    if (payload.bcc) form.set('bcc', payload.bcc)
    const binary = atob(payload.attachment.content_base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    form.set(
      'attachment',
      new File([bytes], payload.attachment.filename, { type: payload.attachment.content_type || 'application/pdf' }),
      payload.attachment.filename,
    )
    body = form
  } else {
    const form = new URLSearchParams()
    form.set('from', payload.from)
    form.set('to', payload.to)
    form.set('subject', payload.subject ?? '')
    if (payload.html) form.set('html', payload.html)
    if (payload.text) form.set('text', payload.text)
    if (payload.reply_to) form.set('h:Reply-To', payload.reply_to)
    if (payload.bcc) form.set('bcc', payload.bcc)
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    body = form
  }

  const res = await fetch(`${cfg.baseUrl}/v3/${cfg.domain}/messages`, {
    method: 'POST',
    headers,
    body,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const retryAfterHeader = res.headers.get('Retry-After')
    const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null
    throw new MailgunError(
      res.status,
      `Mailgun send failed [${res.status}]: ${body.slice(0, 500)}`,
      Number.isFinite(retryAfter as number) ? retryAfter : null
    )
  }

  // Consume the body to release the connection.
  await res.text().catch(() => '')
}

function parseJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length < 2) {
    return null
  }

  try {
    const payload = parts[1]
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=')

    return JSON.parse(atob(payload)) as Record<string, unknown>
  } catch {
    return null
  }
}

// Move a message to the dead letter queue and log the reason.
async function moveToDlq(
  supabase: any,
  queue: string,
  msg: { msg_id: number; message: Record<string, unknown> },
  reason: string
): Promise<void> {
  const payload = msg.message
  await supabase.from('email_send_log').insert({
    message_id: payload.message_id,
    template_name: (payload.label || queue) as string,
    recipient_email: payload.to,
    status: 'dlq',
    error_message: reason,
  })
  const { error } = await supabase.rpc('move_to_dlq', {
    source_queue: queue,
    dlq_name: `${queue}_dlq`,
    message_id: msg.msg_id,
    payload,
  })
  if (error) {
    console.error('Failed to move message to DLQ', { queue, msg_id: msg.msg_id, reason, error })
  }
}

Deno.serve(async (req) => {
  const mailgunApiKey = Deno.env.get('MAILGUN_API_KEY')
  const mailgunDomain = Deno.env.get('MAILGUN_DOMAIN')
  const mailgunBaseUrl = Deno.env.get('MAILGUN_API_BASE') || 'https://api.mailgun.net'
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!mailgunApiKey || !mailgunDomain || !supabaseUrl || !supabaseServiceKey) {
    console.error('Missing required environment variables')
    return new Response(
      JSON.stringify({ error: 'Server configuration error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const mailgunConfig: MailgunConfig = {
    apiKey: mailgunApiKey,
    domain: mailgunDomain,
    baseUrl: mailgunBaseUrl,
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // Defense in depth: verify_jwt=true already requires a valid JWT at the
  // gateway layer. This adds an explicit role check so only service-role
  // callers can trigger queue processing.
  const token = authHeader.slice('Bearer '.length).trim()
  const claims = parseJwtClaims(token)
  if (claims?.role !== 'service_role') {
    return new Response(
      JSON.stringify({ error: 'Forbidden' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // 1. Check rate-limit cooldown and read queue config
  const { data: state } = await supabase
    .from('email_send_state')
    .select('retry_after_until, batch_size, send_delay_ms, auth_email_ttl_minutes, transactional_email_ttl_minutes')
    .single()

  if (state?.retry_after_until && new Date(state.retry_after_until) > new Date()) {
    return new Response(
      JSON.stringify({ skipped: true, reason: 'rate_limited' }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  }

  const batchSize = state?.batch_size ?? DEFAULT_BATCH_SIZE
  const sendDelayMs = state?.send_delay_ms ?? DEFAULT_SEND_DELAY_MS
  const ttlMinutes: Record<string, number> = {
    auth_emails: state?.auth_email_ttl_minutes ?? DEFAULT_AUTH_TTL_MINUTES,
    transactional_emails: state?.transactional_email_ttl_minutes ?? DEFAULT_TRANSACTIONAL_TTL_MINUTES,
  }

  let totalProcessed = 0

  // 2. Process auth_emails first (priority), then transactional_emails
  for (const queue of ['auth_emails', 'transactional_emails']) {
    const { data: messages, error: readError } = await supabase.rpc('read_email_batch', {
      queue_name: queue,
      batch_size: batchSize,
      vt: 30,
    })

    if (readError) {
      console.error('Failed to read email batch', { queue, error: readError })
      continue
    }

    if (!messages?.length) continue

    // Retry budget is based on real send failures, not pgmq read_ct.
    // read_ct increments for every message in a claimed batch, including
    // messages not attempted when a 429 stops processing early.
    const messageIds = Array.from(
      new Set(
        messages
          .map((msg: any) =>
            msg?.message?.message_id && typeof msg.message.message_id === 'string'
              ? msg.message.message_id
              : null
          )
          .filter((id: any): id is string => Boolean(id))
      )
    )
    const failedAttemptsByMessageId = new Map<string, number>()
    if (messageIds.length > 0) {
      const { data: failedRows, error: failedRowsError } = await supabase
        .from('email_send_log')
        .select('message_id, error_message')
        .in('message_id', messageIds)
        .eq('status', 'failed')

      if (failedRowsError) {
        console.error('Failed to load failed-attempt counters', {
          queue,
          error: failedRowsError,
        })
      } else {
        for (const row of failedRows ?? []) {
          const messageId = row?.message_id
          if (typeof messageId !== 'string' || !messageId) continue
          // A credential outage (401) is not the message's fault. Counting it
          // against the retry budget makes every requeued email die instantly
          // once the key is fixed, so those rows are excluded.
          const reason = typeof row?.error_message === 'string' ? row.error_message : ''
          if (reason.includes('[401]') || reason.includes('Mailgun credential failure')) continue
          failedAttemptsByMessageId.set(
            messageId,
            (failedAttemptsByMessageId.get(messageId) ?? 0) + 1
          )
        }
      }
    }


    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      const payload = msg.message
      const failedAttempts =
        payload?.message_id && typeof payload.message_id === 'string'
          ? (failedAttemptsByMessageId.get(payload.message_id) ?? 0)
          : msg.read_ct ?? 0
      const maxAttempts = maxAttemptsFor(payload)

      // Drop expired messages (TTL exceeded).
      // Prefer payload.queued_at when present; fall back to PGMQ's enqueued_at
      // which is always set by the queue.
      const queuedAt = payload.queued_at ?? msg.enqueued_at
      if (queuedAt) {
        const ageMs = Date.now() - new Date(queuedAt).getTime()
        const maxAgeMs = ttlMinutes[queue] * 60 * 1000
        if (ageMs > maxAgeMs) {
          console.warn('Email expired (TTL exceeded)', {
            queue,
            msg_id: msg.msg_id,
            queued_at: queuedAt,
            ttl_minutes: ttlMinutes[queue],
          })
          await moveToDlq(supabase, queue, msg, `TTL exceeded (${ttlMinutes[queue]} minutes)`)
          continue
        }
      }

      // Move to DLQ if max failed send attempts reached.
      if (failedAttempts >= maxAttempts) {
        await moveToDlq(supabase, queue, msg, `Max attempts (${maxAttempts}) exceeded (attempted ${failedAttempts} times)`)
        continue
      }

      // Guard: skip if another worker already sent this message (VT expired race)
      if (payload.message_id) {
        const { data: alreadySent } = await supabase
          .from('email_send_log')
          .select('id')
          .eq('message_id', payload.message_id)
          .eq('status', 'sent')
          .maybeSingle()

        if (alreadySent) {
          console.warn('Skipping duplicate send (already sent)', {
            queue,
            msg_id: msg.msg_id,
            message_id: payload.message_id,
          })
          const { error: dupDelError } = await supabase.rpc('delete_email', {
            queue_name: queue,
            message_id: msg.msg_id,
          })
          if (dupDelError) {
            console.error('Failed to delete duplicate message from queue', { queue, msg_id: msg.msg_id, error: dupDelError })
          }
          continue
        }
      }

      // Suppressed recipient: do NOT fail the email. Put it back in the queue
      // and retry in 2 minutes (the address may be un-suppressed by then).
      // TTL above eventually retires it if suppression never clears.
      if (payload.to) {
        const { data: suppressedRow, error: suppressionError } = await supabase
          .from('suppressed_emails')
          .select('email')
          .eq('email', String(payload.to).toLowerCase())
          .maybeSingle()

        if (suppressionError) {
          console.error('Failed to verify suppression status', {
            queue,
            msg_id: msg.msg_id,
            error: suppressionError,
          })
        }

        if (suppressedRow) {
          console.warn('Recipient suppressed — deferring retry by 2 minutes', {
            queue,
            msg_id: msg.msg_id,
            to: payload.to,
          })
          const { error: deferError } = await supabase.rpc('defer_email', {
            queue_name: queue,
            message_id: msg.msg_id,
            delay_seconds: SUPPRESSION_RETRY_SECONDS,
          })
          if (deferError) {
            console.error('Failed to defer suppressed message', { queue, msg_id: msg.msg_id, error: deferError })
          }
          continue
        }
      }

      try {
        await sendViaMailgun(
          {
            to: payload.to,
            from: payload.from || DEFAULT_FROM,
            reply_to: payload.reply_to,
            bcc: payload.bcc,
            subject: payload.subject,
            html: payload.html,
            text: payload.text,
            idempotency_key: payload.idempotency_key,
            attachment: payload.attachment as {
              filename: string
              content_base64: string
              content_type?: string
            } | undefined,
          },
          mailgunConfig
        )

        // Log success
        // Carry forward the metadata (subject + template_data) that
        // send-transactional-email stored on the 'pending' row so the
        // CTO email-body viewer can render this row on its own.
        let sentMetadata: Record<string, unknown> | null = null
        if (payload.message_id) {
          const { data: pendingRow } = await supabase
            .from('email_send_log')
            .select('metadata')
            .eq('message_id', payload.message_id)
            .not('metadata', 'is', null)
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle()
          if (pendingRow?.metadata && typeof pendingRow.metadata === 'object') {
            sentMetadata = pendingRow.metadata as Record<string, unknown>
          }
        }
        if (!sentMetadata && payload.subject) {
          sentMetadata = { subject: payload.subject }
        }
        // Always record the actual BCC / from / reply_to used on this send so
        // the CTO Emails admin view can verify partner mail reached the BCC.
        sentMetadata = {
          ...(sentMetadata ?? {}),
          from: payload.from || DEFAULT_FROM,
          ...(payload.reply_to ? { reply_to: payload.reply_to } : {}),
          ...(payload.bcc ? { bcc: payload.bcc } : {}),
        }
        await supabase.from('email_send_log').insert({
          message_id: payload.message_id,
          template_name: payload.label || queue,
          recipient_email: payload.to,
          status: 'sent',
          metadata: sentMetadata,
        })

        // Delete from queue
        const { error: delError } = await supabase.rpc('delete_email', {
          queue_name: queue,
          message_id: msg.msg_id,
        })
        if (delError) {
          console.error('Failed to delete sent message from queue', { queue, msg_id: msg.msg_id, error: delError })
        }
        totalProcessed++
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        console.error('Email send failed', {
          queue,
          msg_id: msg.msg_id,
          read_ct: msg.read_ct,
          failed_attempts: failedAttempts,
          error: errorMsg,
        })

        if (isRateLimited(error)) {
          await supabase.from('email_send_log').insert({
            message_id: payload.message_id,
            template_name: payload.label || queue,
            recipient_email: payload.to,
            status: 'rate_limited',
            error_message: errorMsg.slice(0, 1000),
          })

          const retryAfterSecs = getRetryAfterSeconds(error)
          await supabase
            .from('email_send_state')
            .update({
              retry_after_until: new Date(
                Date.now() + retryAfterSecs * 1000
              ).toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', 1)

          // Stop processing — remaining messages stay in queue (VT expires, retried next cycle)
          return new Response(
            JSON.stringify({ processed: totalProcessed, stopped: 'rate_limited' }),
            { headers: { 'Content-Type': 'application/json' } }
          )
        }

        // 401 means the Mailgun API key is disabled/invalid. The message is
        // fine — the transport is down. Leave it in the queue (visibility
        // timeout returns it), park sending on a cooldown and stop the batch.
        if (isAuthFailure(error)) {
          await supabase.from('email_send_log').insert({
            message_id: payload.message_id,
            template_name: payload.label || queue,
            recipient_email: payload.to,
            status: 'failed',
            error_message: `Mailgun credential failure (not resent, still queued): ${errorMsg.slice(0, 900)}`,
          })
          await supabase
            .from('email_send_state')
            .update({
              retry_after_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', 1)
          return new Response(
            JSON.stringify({ processed: totalProcessed, stopped: 'mailgun_auth_failure' }),
            { headers: { 'Content-Type': 'application/json' } }
          )
        }

        // 403 means emails are disabled for this project — retrying won't help.
        // Move straight to DLQ and stop processing the rest of the batch.
        if (isForbidden(error)) {
          await moveToDlq(supabase, queue, msg, 'Emails disabled for this project')
          return new Response(
            JSON.stringify({ processed: totalProcessed, stopped: 'emails_disabled' }),
            { headers: { 'Content-Type': 'application/json' } }
          )
        }



        // Log non-429 failures to track real retry attempts.
        await supabase.from('email_send_log').insert({
          message_id: payload.message_id,
          template_name: payload.label || queue,
          recipient_email: payload.to,
          status: 'failed',
          error_message: errorMsg.slice(0, 1000),
        })
        if (payload?.message_id && typeof payload.message_id === 'string') {
          failedAttemptsByMessageId.set(payload.message_id, failedAttempts + 1)
        }

        const nextFailedAttempts = failedAttempts + 1
        const shouldRetryWalletConfirmation =
          payload.label === 'cash-deposit-wallet-confirmation' &&
          isRetryableDeliveryFailure(error) &&
          nextFailedAttempts < maxAttempts

        if (shouldRetryWalletConfirmation) {
          const delaySeconds = retryDelayFor(failedAttempts)
          const { error: deferError } = await supabase.rpc('defer_email', {
            queue_name: queue,
            message_id: msg.msg_id,
            delay_seconds: delaySeconds,
          })
          if (deferError) {
            console.error('Failed to defer wallet confirmation retry', {
              queue,
              msg_id: msg.msg_id,
              attempt: nextFailedAttempts,
              error: deferError,
            })
          } else {
            console.warn('Wallet confirmation email deferred for retry', {
              queue,
              msg_id: msg.msg_id,
              attempt: nextFailedAttempts,
              max_attempts: maxAttempts,
              delay_seconds: delaySeconds,
            })
            continue
          }
        }

        // Non-retryable failures, exhausted retries, or a failed defer operation
        // are retired so they remain visible for operational follow-up.
        await moveToDlq(
          supabase,
          queue,
          msg,
          shouldRetryWalletConfirmation
            ? `Retry scheduling failed: ${errorMsg.slice(0, 300)}`
            : `Send failed${nextFailedAttempts >= maxAttempts ? ' — retries exhausted' : ' — not retryable'}: ${errorMsg.slice(0, 300)}`
        )
      }

      // Small delay between sends to smooth bursts
      if (i < messages.length - 1) {
        await new Promise((r) => setTimeout(r, sendDelayMs))
      }
    }
  }

  return new Response(
    JSON.stringify({ processed: totalProcessed }),
    { headers: { 'Content-Type': 'application/json' } }
  )
})
