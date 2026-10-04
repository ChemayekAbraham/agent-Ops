// Single entry point for every tenant behaviour notification.
//
// Every tenant-facing SMS driven by payment or engagement behaviour goes
// through notifyTenant(), so the frequency rules from the 2026-09-06 and
// 2026-09-09 tenant-ops meetings are enforced in one place rather than
// re-implemented per sender:
//
//   * transactional events (payment received/partial/missed, five-day
//     default) are event-driven and may fire daily
//   * marketing events (relocation, rent-access progress, dashboard link)
//     are globally capped at twice per rolling 7 days
//
// Delivery itself stays in sendSmsMultiProvider (provider fallback, the
// support footer, the phone-collection gate, opt-out/blocked-number
// suppression and sms_delivery_log). This module adds only the event layer:
// "may I send this, to this tenant, right now" and "record that I did".

import { sendSMS } from "./sendSmsMultiProvider.ts";

export type TenantNotificationChannel = "sms" | "push" | "in_app";

export interface NotifyTenantArgs {
  admin: any;
  tenantId: string;
  /** Must exist in public.tenant_notification_events. */
  eventKey: string;
  /**
   * Identifies the occasion this message belongs to, making the send
   * idempotent. Use the obligation date for daily events
   * ("missed:2026-09-08") and the run start for a default episode
   * ("default:2026-09-02"). Null means "no episode dedupe" and relies on the
   * event's per-day/per-week caps alone.
   */
  episodeKey?: string | null;
  phone: string;
  message: string;
  tenantName?: string | null;
  /** Recorded on the log row for later auditing of what the tenant was told. */
  payload?: Record<string, unknown>;
  channel?: TenantNotificationChannel;
}

export interface NotifyTenantResult {
  sent: boolean;
  /** Set when the send did not happen: why the governor or provider refused. */
  reason: string | null;
  logId: string | null;
}

/**
 * Governor-gated tenant notification.
 *
 * Never throws for an ordinary refusal — a capped or duplicate message is a
 * normal outcome, and a batch sender must be able to keep going. Only a
 * genuine infrastructure failure propagates.
 */
export async function notifyTenant(args: NotifyTenantArgs): Promise<NotifyTenantResult> {
  const {
    admin,
    tenantId,
    eventKey,
    episodeKey = null,
    phone,
    message,
    tenantName = null,
    payload = {},
    channel = "sms",
  } = args;

  const { data: verdict, error: verdictError } = await admin.rpc(
    "can_send_tenant_notification",
    { p_tenant_id: tenantId, p_event_key: eventKey, p_episode_key: episodeKey },
  );

  if (verdictError) {
    // A governor failure must not become an uncapped send.
    console.error(`[tenantNotify] governor failed for ${eventKey}:`, verdictError.message);
    return { sent: false, reason: `governor_error: ${verdictError.message}`, logId: null };
  }

  if (!verdict?.allowed) {
    const reason = String(verdict?.reason ?? "not_allowed");
    // Skips are logged too: "why did this tenant not get the SMS" is an
    // operational question Tenant Ops needs answered from data.
    const { data: skipId } = await admin.rpc("record_tenant_notification", {
      p_tenant_id: tenantId,
      p_event_key: eventKey,
      p_episode_key: episodeKey,
      p_channel: channel,
      p_phone: phone || null,
      p_status: "skipped",
      p_skip_reason: reason,
      p_provider: null,
      p_sms_log_id: null,
      p_payload: payload,
    });
    return { sent: false, reason, logId: skipId ?? null };
  }

  // Scope the idempotency key to the event+episode so a redeploy or a cron
  // double-fire reserves the same key and the provider layer drops the second
  // attempt, even if the governor read a stale log.
  const idempotencyKey = episodeKey
    ? `tenant_notify:${eventKey}:${tenantId}:${episodeKey}`
    : null;

  const delivered = await sendSMS(phone, message, {
    admin,
    source: `tenant_notify:${eventKey}`,
    reference_id: episodeKey,
    recipient_user_id: tenantId,
    recipient_name: tenantName,
    idempotencyKey,
  });

  // sendSMS owns the sms_delivery_log row; link it rather than duplicating
  // delivery state. Looked up by the idempotency key we just reserved.
  let smsLogId: string | null = null;
  let provider: string | null = null;
  if (idempotencyKey) {
    const { data: smsRow } = await admin
      .from("sms_delivery_log")
      .select("id, provider")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    smsLogId = smsRow?.id ?? null;
    provider = smsRow?.provider ?? null;
  }

  const { data: logId, error: logError } = await admin.rpc("record_tenant_notification", {
    p_tenant_id: tenantId,
    p_event_key: eventKey,
    p_episode_key: episodeKey,
    p_channel: channel,
    p_phone: phone || null,
    p_status: delivered ? "sent" : "failed",
    p_skip_reason: null,
    p_provider: provider,
    p_sms_log_id: smsLogId,
    p_payload: payload,
  });

  if (logError) {
    console.error(`[tenantNotify] log write failed for ${eventKey}:`, logError.message);
  }

  return {
    sent: delivered,
    reason: delivered ? null : "provider_failed",
    logId: logId ?? null,
  };
}
