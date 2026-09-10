// Stage 6: channel router.
//
// One business event, one call site, channel-specific rendering decided by
// policy -- not by each sender re-implementing "should this go by push too".
//
//   Business Event -> routeTenantNotification() -> policy lookup
//                                                 -> SMS  (existing notifyTenant, unchanged)
//                                                 -> Push (webPushSend, per active device)
//                                                 -> In-app (notifications inbox)
//
// SMS is deliberately still sent through notifyTenant() from tenantNotify.ts
// rather than reimplemented here: that path already owns the frequency
// governor, episode idempotency and sms_delivery_log linkage, all proven
// across Stage 1-5, and duplicating it would reopen exactly the kind of
// drift this codebase keeps getting bitten by. This module ONLY adds what
// did not exist before: policy lookup and push/in-app dispatch, tied back to
// the same logical event id notifyTenant (or, when SMS is skipped by
// routing, record_tenant_notification directly) returns.
import { notifyTenant } from "./tenantNotify.ts";
import { loadEvent, renderTemplate, type NotificationEvent } from "./tenantTemplates.ts";
import { sendPushToSubscription, cleanupGoneSubscription, type PushPayload } from "./webPushSend.ts";

export interface RouteNotificationArgs {
  admin: any;
  tenantId: string;
  eventKey: string;
  episodeKey?: string | null;
  /** Template variables shared by every channel's copy. */
  vars: Record<string, string | number | null | undefined>;
  /** Required only if SMS may fire for this event/tenant. */
  phone?: string | null;
  tenantName?: string | null;
  payload?: Record<string, unknown>;
  /** Where an in-app entry (and a push tap) should take the tenant. */
  linkPath?: string | null;
}

export interface RouteNotificationResult {
  notificationLogId: string | null;
  smsSent: boolean;
  pushAttempted: number;
  pushSent: number;
  inAppCreated: boolean;
  reason: string | null;
}

interface ChannelPolicy {
  event_key: string;
  sms_enabled: boolean;
  push_enabled: boolean;
  in_app_enabled: boolean;
  push_preferred: boolean;
  sms_fallback: boolean;
  critical: boolean;
}

/** Fail safe: an event with no policy row gets SMS only, matching pre-Stage-6 behaviour. */
const DEFAULT_POLICY: Omit<ChannelPolicy, "event_key"> = {
  sms_enabled: true,
  push_enabled: false,
  in_app_enabled: false,
  push_preferred: false,
  sms_fallback: false,
  critical: true,
};

async function loadPolicy(admin: any, eventKey: string): Promise<ChannelPolicy> {
  const { data, error } = await admin
    .from("tenant_notification_channel_policy")
    .select("event_key, sms_enabled, push_enabled, in_app_enabled, push_preferred, sms_fallback, critical")
    .eq("event_key", eventKey)
    .maybeSingle();

  if (error) {
    console.error(`[tenantChannelRouter] policy load failed for ${eventKey}:`, error.message);
  }
  return (data as ChannelPolicy | null) ?? { event_key: eventKey, ...DEFAULT_POLICY };
}

interface PushSubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

async function loadActiveDevices(admin: any, tenantId: string): Promise<PushSubRow[]> {
  const { data, error } = await admin.rpc("get_tenant_active_push_subscriptions", {
    p_tenant_id: tenantId,
  });
  if (error) {
    console.error(`[tenantChannelRouter] device load failed for ${tenantId}:`, error.message);
    return [];
  }
  return (data ?? []) as PushSubRow[];
}

interface Preference {
  push_enabled: boolean;
  marketing_push_opt_out: boolean;
}

async function loadPreference(admin: any, tenantId: string): Promise<Preference> {
  const { data } = await admin
    .from("tenant_notification_preferences")
    .select("push_enabled, marketing_push_opt_out")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  // No row = defaults: push on, not opted out of marketing push.
  return (data as Preference | null) ?? { push_enabled: true, marketing_push_opt_out: false };
}

async function dispatchPush(
  admin: any,
  tenantId: string,
  notificationLogId: string,
  devices: PushSubRow[],
  event: NotificationEvent,
  vars: RouteNotificationArgs["vars"],
  linkPath: string | null,
): Promise<{ attempted: number; sent: number }> {
  if (!event.push_title_template || !event.push_body_template) return { attempted: 0, sent: 0 };

  const title = renderTemplate(event.push_title_template, vars);
  const body = renderTemplate(event.push_body_template, vars);
  const payload: PushPayload = {
    title,
    body,
    url: linkPath ?? undefined,
    notificationId: notificationLogId,
  };

  let sent = 0;
  for (const device of devices) {
    try {
      const result = await sendPushToSubscription(device, payload);
      await admin.rpc("record_push_delivery", {
        p_notification_log_id: notificationLogId,
        p_push_subscription_id: device.id,
        p_status: result.ok ? "sent" : "failed",
        p_error: result.ok ? null : "push_send_failed",
      });
      if (result.ok) sent++;
      else if (result.gone) await cleanupGoneSubscription(admin, device.endpoint);
    } catch (err) {
      console.error(`[tenantChannelRouter] push failed for device ${device.id}:`, err);
      await admin.rpc("record_push_delivery", {
        p_notification_log_id: notificationLogId,
        p_push_subscription_id: device.id,
        p_status: "failed",
        p_error: err instanceof Error ? err.message : "unknown_error",
      });
    }
  }

  return { attempted: devices.length, sent };
}

async function dispatchInApp(
  admin: any,
  tenantId: string,
  eventKey: string,
  notificationLogId: string,
  event: NotificationEvent,
  vars: RouteNotificationArgs["vars"],
  linkPath: string | null,
  payload: Record<string, unknown>,
): Promise<boolean> {
  if (!event.in_app_title_template || !event.in_app_body_template) return false;

  const title = renderTemplate(event.in_app_title_template, vars);
  const body = renderTemplate(event.in_app_body_template, vars);

  const { error } = await admin.rpc("create_tenant_in_app_notification", {
    p_notification_log_id: notificationLogId,
    p_tenant_id: tenantId,
    p_event_key: eventKey,
    p_title: title,
    p_body: body,
    p_link_path: linkPath,
    p_metadata: payload ?? {},
    p_expires_at: null,
  });

  if (error) {
    console.error(`[tenantChannelRouter] in-app create failed for ${tenantId}:`, error.message);
    return false;
  }
  return true;
}

/**
 * Routes one business event to SMS, push and/or in-app per the event's
 * channel policy and the tenant's active devices and preferences.
 *
 * Never throws for an ordinary outcome (no eligible channel, governor
 * refusal, a device push failure) -- a batch sender must keep going. Only a
 * genuine infrastructure failure propagates.
 */
export async function routeTenantNotification(
  args: RouteNotificationArgs,
): Promise<RouteNotificationResult> {
  const {
    admin,
    tenantId,
    eventKey,
    episodeKey = null,
    vars,
    phone = null,
    tenantName = null,
    payload = {},
    linkPath = null,
  } = args;

  const event = await loadEvent(admin, eventKey);
  if (!event || !event.active) {
    return {
      notificationLogId: null, smsSent: false, pushAttempted: 0, pushSent: 0,
      inAppCreated: false, reason: "event_missing_or_inactive",
    };
  }

  const policy = await loadPolicy(admin, eventKey);
  const devices = policy.push_enabled ? await loadActiveDevices(admin, tenantId) : [];
  const preference = await loadPreference(admin, tenantId);

  // A tenant's marketing opt-out can only suppress non-critical push/in-app.
  // Stage 6L is explicit: critical/contractual communication must not become
  // suppressible because promotional push is off.
  const marketingSuppressed = !policy.critical && preference.marketing_push_opt_out;
  const pushDeviceEligible = policy.push_enabled && preference.push_enabled
    && !marketingSuppressed && devices.length > 0;

  // "conditional" SMS from the brief: push_preferred + an eligible device
  // present means SMS is skipped in favour of push+in-app. Critical events
  // and events with no push_preferred always attempt SMS when sms_enabled.
  const wantSmsInitially = policy.sms_enabled
    && (policy.critical || !policy.push_preferred || !pushDeviceEligible);
  // Distinct from wantSmsInitially: a phone-less tenant with wantSmsInitially
  // true must NOT be treated the same as "policy chose SMS" -- there is
  // simply no number to send to. Both cases skip the SMS call itself, but
  // only this flag decides whether notifyTenant runs; a tenant with no phone
  // but an active push device (or in-app enabled) must still be reachable.
  const willAttemptSms = wantSmsInitially && !!phone;

  let notificationLogId: string | null = null;
  let smsSent = false;
  let reason: string | null = null;

  if (policy.sms_enabled && !event.body_template) {
    // Guards BOTH the primary SMS path and the sms_fallback path below —
    // sms_fallback can fire even when wantSmsInitially is false, so the
    // check cannot be scoped to that flag alone. Every seeded event has SMS
    // copy; a missing body_template is a configuration error, not something
    // to paper over with an empty send.
    throw new Error(`${eventKey} has sms_enabled policy but no body_template configured`);
  }

  if (willAttemptSms) {
    const message = renderTemplate(event.body_template!, vars);
    const outcome = await notifyTenant({
      admin, tenantId, eventKey, episodeKey, phone: phone!, tenantName, message, payload,
    });
    notificationLogId = outcome.logId;
    smsSent = outcome.sent;
    reason = outcome.reason;

    // A governor refusal (frequency cap, duplicate episode) applies to the
    // WHOLE event, not just the SMS channel -- no push/in-app either.
    if (!outcome.sent && outcome.reason && outcome.reason !== "provider_failed") {
      return {
        notificationLogId, smsSent: false, pushAttempted: 0, pushSent: 0,
        inAppCreated: false, reason: outcome.reason,
      };
    }
  } else {
    // Either routed away from SMS by policy (push preferred and a device
    // exists), or SMS was wanted but there is no phone to send to -- either
    // way, still governed and still logged, so idempotency/frequency caps
    // apply exactly as they would for an SMS-only event, and Stage 5
    // attribution has a real log row to attach push/in-app deliveries to.
    const { data: verdict, error: verdictError } = await admin.rpc(
      "can_send_tenant_notification",
      { p_tenant_id: tenantId, p_event_key: eventKey, p_episode_key: episodeKey },
    );
    if (verdictError) {
      console.error(`[tenantChannelRouter] governor failed for ${eventKey}:`, verdictError.message);
      return {
        notificationLogId: null, smsSent: false, pushAttempted: 0, pushSent: 0,
        inAppCreated: false, reason: `governor_error: ${verdictError.message}`,
      };
    }
    if (!verdict?.allowed) {
      const skipReason = String(verdict?.reason ?? "not_allowed");
      await admin.rpc("record_tenant_notification", {
        p_tenant_id: tenantId, p_event_key: eventKey, p_episode_key: episodeKey,
        p_channel: "push", p_phone: phone, p_status: "skipped",
        p_skip_reason: skipReason, p_provider: null, p_sms_log_id: null, p_payload: payload,
      });
      return {
        notificationLogId: null, smsSent: false, pushAttempted: 0, pushSent: 0,
        inAppCreated: false, reason: skipReason,
      };
    }

    const { data: logId, error: logError } = await admin.rpc("record_tenant_notification", {
      p_tenant_id: tenantId, p_event_key: eventKey, p_episode_key: episodeKey,
      p_channel: "push", p_phone: phone, p_status: "sent",
      p_skip_reason: null, p_provider: null, p_sms_log_id: null, p_payload: payload,
    });
    if (logError) {
      console.error(`[tenantChannelRouter] log write failed for ${eventKey}:`, logError.message);
    }
    notificationLogId = logId ?? null;
    reason = wantSmsInitially ? "no_phone" : "routed_to_push";
  }

  if (!notificationLogId) {
    // No episode was reserved (e.g. SMS wanted but no phone, and push not
    // eligible either) -- nothing left to attach a delivery to.
    return {
      notificationLogId: null, smsSent, pushAttempted: 0, pushSent: 0,
      inAppCreated: false, reason: reason ?? "no_channel_eligible",
    };
  }

  let pushAttempted = 0;
  let pushSent = 0;
  if (pushDeviceEligible) {
    const result = await dispatchPush(admin, tenantId, notificationLogId, devices, event, vars, linkPath);
    pushAttempted = result.attempted;
    pushSent = result.sent;
  }

  // sms_fallback: only relevant when SMS was skipped in favour of push and
  // every device attempt failed. Sent once, synchronously -- Web Push has no
  // async delivery-failure callback, so failure is already known here.
  if (!smsSent && !wantSmsInitially && policy.sms_fallback
      && pushAttempted > 0 && pushSent === 0 && phone) {
    const message = renderTemplate(event.body_template!, vars);
    const fallbackOutcome = await notifyTenant({
      admin, tenantId, eventKey, episodeKey: episodeKey ? `${episodeKey}:push_fallback` : "push_fallback",
      phone, tenantName, message, payload: { ...payload, fallback_reason: "all_push_devices_failed" },
    });
    smsSent = fallbackOutcome.sent;
  }

  let inAppCreated = false;
  const inAppEligible = policy.in_app_enabled && !marketingSuppressed;
  if (inAppEligible) {
    inAppCreated = await dispatchInApp(
      admin, tenantId, eventKey, notificationLogId, event, vars, linkPath, payload,
    );
  }

  return { notificationLogId, smsSent, pushAttempted, pushSent, inAppCreated, reason };
}
