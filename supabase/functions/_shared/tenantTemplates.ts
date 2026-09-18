// Template and configuration loading for tenant notifications.
//
// Keeps the catalogue's governing rule enforceable in code: the SMS engine
// only communicates what the system already knows. Copy comes from
// tenant_notification_events.body_template, merchant codes come from
// payment_channels, and a sender supplies only values it was given by the
// business logic upstream.
//
// No sender should build message text by string concatenation — if a message
// needs new wording, it needs a new placeholder, not inline copy.

export interface NotificationEvent {
  event_key: string;
  label: string;
  message_class: "transactional" | "marketing";
  active: boolean;
  link_path: string | null;
  body_template: string | null;
  // Stage 6: push/in-app copy. Null for events with no push/in-app content —
  // the channel router treats a missing template as "channel not usable for
  // this event", not "render an empty message".
  push_title_template: string | null;
  push_body_template: string | null;
  in_app_title_template: string | null;
  in_app_body_template: string | null;
}

export interface PaymentChannels {
  mtn: string | null;
  airtel: string | null;
}

/** Returns null when the event has no catalog row at all. */
export async function loadEvent(
  admin: any,
  eventKey: string,
): Promise<NotificationEvent | null> {
  const { data, error } = await admin
    .from("tenant_notification_events")
    .select(
      "event_key, label, message_class, active, link_path, body_template, " +
      "push_title_template, push_body_template, in_app_title_template, in_app_body_template",
    )
    .eq("event_key", eventKey)
    .maybeSingle();

  if (error) {
    console.error(`[tenantTemplates] event load failed for ${eventKey}:`, error.message);
    return null;
  }
  return (data ?? null) as NotificationEvent | null;
}

/**
 * Active merchant codes. Returns nulls rather than throwing when a provider
 * is missing or deactivated, so a sender can decide whether its message still
 * makes sense without one.
 */
export async function loadPaymentChannels(admin: any): Promise<PaymentChannels> {
  const { data, error } = await admin
    .from("payment_channels")
    .select("provider, merchant_code, active")
    .eq("active", true);

  if (error) {
    console.error("[tenantTemplates] payment_channels load failed:", error.message);
    return { mtn: null, airtel: null };
  }

  const byProvider = new Map<string, string>(
    (data ?? []).map((r: { provider: string; merchant_code: string }) => [r.provider, r.merchant_code]),
  );
  return {
    mtn: byProvider.get("mtn") ?? null,
    airtel: byProvider.get("airtel") ?? null,
  };
}

export function formatUGX(n: unknown): string {
  return `UGX ${Math.round(Number(n) || 0).toLocaleString()}`;
}

export function firstName(fullName: string | null | undefined): string {
  return String(fullName || "").trim().split(/\s+/)[0] || "there";
}

/**
 * Renders {{placeholder}} against vars.
 *
 * A placeholder with no value is removed rather than left in the message —
 * an SMS reading "View: {{dashboard_link}}" is worse than one with no link at
 * all, and the per-tenant dashboard link does not exist yet. Whitespace and
 * stranded punctuation left behind by a removal are then tidied.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | number | null | undefined>,
): string {
  let out = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === null || value === undefined || value === "") return "";
    return String(value);
  });

  // Only whitespace tidying. Anything that could render badly when a value is
  // absent must be supplied as a whole fragment instead (see agentCta,
  // payDirectSentence, payChannelsPhrase, dashboardSuffix) -- trying to repair
  // a broken sentence after the fact produced worse copy than preventing it:
  // stripping the colon from "Start here: {{link}}" just left "Start here".
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();

  return out;
}

// ---------------------------------------------------------------------------
// Atomic optional fragments.
//
// Any sentence that only makes sense when a value is present is built here as
// a whole unit, so an absent value removes the entire sentence rather than
// leaving a stump. Templates must reference these as a single placeholder and
// never spell the surrounding words out themselves.
// ---------------------------------------------------------------------------

/**
 * Trailing dashboard link for the payment and rent-limit templates. Returns ""
 * until per-tenant dashboard links exist, so those messages end at the balance.
 */
export function dashboardSuffix(link: string | null | undefined): string {
  return link ? ` View: ${link}` : "";
}

/** Whole status-based paragraph appended to tenant SMS copy. */
export function statusAppendix(text: string | null | undefined): string {
  const cleaned = String(text ?? "").trim();
  return cleaned ? ` ${cleaned}` : "";
}

export async function loadTenantStatusAppendices(
  admin: any,
  tenantIds: Array<string | null | undefined>,
  domainName = "welileapp.com",
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(tenantIds.filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return new Map();

  const { data, error } = await admin.rpc("get_tenant_status_appendices", {
    p_tenant_ids: ids,
    p_domain_name: domainName,
  });

  if (error) {
    console.error("[tenantTemplates] status appendix load failed:", error.message);
    return new Map();
  }

  const rows = (data ?? []) as Array<{ tenant_id: string; status_appendix: string | null }>;
  return new Map(rows.map((row) => [row.tenant_id, statusAppendix(row.status_appendix)]));
}

/** Call to action for the agent-opportunity message. */
export function agentCta(link: string | null | undefined): string {
  return link ? ` Start here: ${link}` : "";
}

/**
 * "MTN 090777 or Airtel 4380664", degrading to a single provider, or "" when
 * no channel is configured. Never emits a provider name without its code.
 */
export function payChannelsPhrase(channels: PaymentChannels): string {
  const parts: string[] = [];
  if (channels.mtn) parts.push(`MTN ${channels.mtn}`);
  if (channels.airtel) parts.push(`Airtel ${channels.airtel}`);
  return parts.join(" or ");
}

/** Whole direct-payment sentence, or "" when no merchant code is available. */
export function payDirectSentence(channels: PaymentChannels): string {
  const phrase = payChannelsPhrase(channels);
  return phrase ? ` Pay directly via ${phrase}.` : "";
}
