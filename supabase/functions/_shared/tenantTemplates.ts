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

// ---------------------------------------------------------------------------
// Payment-confirmation figures (added 2026-09-21).
//
// Everything below renders EXACT money amounts. Percentages are deliberately
// never published to tenants: the eligibility rule is a percentage internally,
// but the message must always say "pay UGX X more to access up to UGX Y".
// Figures come from get_tenant_payment_message_vars, which reads the same
// authoritative plan/collection data and the same configurable thresholds as
// the Top-Up Eligibility report.
// ---------------------------------------------------------------------------

export interface TenantPaymentMessageVars {
  tenant_id: string;
  rent_amount: number;
  total_expected: number;
  paid_to_date: number;
  remaining: number;
  term_end: string | null;
  days_left_in_cycle: number | null;
  days_after_cycle: number | null;
  tier_key: string;
  current_access: number;
  current_topup: number;
  next_level_required: number | null;
  next_level_access: number | null;
  next_level_deadline: string | null;
}

export interface SupportContact {
  label: string;
  phone: string;
}

export async function loadTenantPaymentMessageVars(
  admin: any,
  tenantIds: Array<string | null | undefined>,
): Promise<Map<string, TenantPaymentMessageVars>> {
  const ids = Array.from(new Set(tenantIds.filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return new Map();

  const { data, error } = await admin.rpc("get_tenant_payment_message_vars", {
    p_tenant_ids: ids,
  });
  if (error) {
    console.error("[tenantTemplates] payment message vars load failed:", error.message);
    return new Map();
  }
  const rows = (data ?? []) as TenantPaymentMessageVars[];
  return new Map(rows.map((row) => [row.tenant_id, row]));
}

/** Active customer-care numbers, in configured order. */
export async function loadSupportContacts(admin: any): Promise<SupportContact[]> {
  const { data, error } = await admin
    .from("tenant_support_contacts")
    .select("label, phone, active, sort_order")
    .eq("active", true)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("[tenantTemplates] support contacts load failed:", error.message);
    return [];
  }
  return (data ?? []) as SupportContact[];
}

/** Whole care-line sentence, or "" when no number is configured. */
export function careSentence(contacts: SupportContact[]): string {
  const numbers = contacts.map((c) => String(c.phone || "").trim()).filter(Boolean);
  if (numbers.length === 0) return "";
  return ` Need help? Call Welile customer care on ${numbers.join(" or ")}.`;
}

/** "You have now paid UGX X of UGX Y. UGX Z remains." */
export function progressSentence(vars: TenantPaymentMessageVars | undefined): string {
  if (!vars || !(Number(vars.total_expected) > 0)) return "";
  const paid = formatUGX(vars.paid_to_date);
  const expected = formatUGX(vars.total_expected);
  if (Number(vars.remaining) <= 0) {
    return ` You have now paid ${paid} of ${expected} — nothing remains on this Rent Plan.`;
  }
  return ` You have now paid ${paid} of ${expected}, leaving ${formatUGX(vars.remaining)} to pay.`;
}

/** Cycle timing, in days rather than dates where the tenant is still inside it. */
export function cycleSentence(vars: TenantPaymentMessageVars | undefined): string {
  if (!vars) return "";
  const left = Number(vars.days_left_in_cycle ?? 0);
  if (left > 0) {
    return ` Your payment cycle ends in ${left} day${left === 1 ? "" : "s"}.`;
  }
  const after = Number(vars.days_after_cycle ?? 0);
  if (after > 0) {
    return ` Your payment cycle ended ${after} day${after === 1 ? "" : "s"} ago.`;
  }
  return "";
}

/** What the tenant has already earned the right to take. */
export function accessSentence(vars: TenantPaymentMessageVars | undefined): string {
  if (!vars) return "";
  const access = Number(vars.current_access ?? 0);
  if (!(access > 0)) return "";
  const topup = Number(vars.current_topup ?? 0);
  if (topup > 0) {
    return ` You have qualified for rent of up to ${formatUGX(access)} next time — that is ${formatUGX(topup)} more than your current ${formatUGX(vars.rent_amount)}.`;
  }
  return ` You have qualified for rent of up to ${formatUGX(access)} next time, the same as your current rent.`;
}

/**
 * The programme ceiling, read from system_config.rent_access_limit_params
 * (max_limit_ugx). Returns null when the config row is missing so senders can
 * simply omit the growth line rather than state a stale figure.
 */
export async function loadRentAccessCap(admin: any): Promise<number | null> {
  const { data, error } = await admin
    .from("system_config")
    .select("value")
    .eq("key", "rent_access_limit_params")
    .maybeSingle();
  if (error) {
    console.error("[tenantTemplates] rent access cap load failed:", error.message);
    return null;
  }
  const cap = Number((data as any)?.value?.max_limit_ugx);
  return cap > 0 ? cap : null;
}

/**
 * Whole marketing sentence telling the tenant that paying on time every day
 * grows their rent access up to the programme ceiling. "" when the cap is
 * unknown — never state a figure the system did not supply.
 */
export function growthSentence(cap: number | null | undefined): string {
  if (!cap || !(Number(cap) > 0)) return "";
  return ` Keep paying on time every day and your rent access can grow up to ${formatUGX(cap)}.`;
}

/** The exact amount to the next level and what it unlocks. */
export function nextLevelSentence(vars: TenantPaymentMessageVars | undefined): string {
  if (!vars) return "";
  const required = Number(vars.next_level_required ?? 0);
  const access = Number(vars.next_level_access ?? 0);
  if (!(required > 0) || !(access > 0)) return "";
  const deadline = vars.next_level_deadline
    ? ` Pay it by ${vars.next_level_deadline} to keep this.`
    : "";
  return ` Pay ${formatUGX(required)} more to qualify for rent of up to ${formatUGX(access)}.${deadline}`;
}
