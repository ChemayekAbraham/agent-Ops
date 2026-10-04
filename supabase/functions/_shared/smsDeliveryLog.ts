// Shared SMS delivery-status logger for withdrawal claim & payout SMS.
// Writes one auditable row per SMS attempt-chain into `sms_delivery_log`,
// capturing the winning provider, the full per-provider response trail,
// retry count, and any failure reason so Financial Ops has a complete
// delivery audit for every claim and payout text.
//
// The table already exists with:
//   recipient_phone, recipient_user_id, recipient_name, message, status,
//   provider, provider_message_id, provider_response (jsonb), cost,
//   reference_id, source, error
//
// This helper is intentionally fire-and-forget: a logging failure must NEVER
// block or fail the SMS / payout flow.

export interface SmsAttemptRecord {
  provider: string; // 'yoola' | 'africastalking' | 'lana'
  ok: boolean;
  error?: string | null;
  response?: unknown; // raw provider response (parsed JSON or text)
  attempt?: number; // 1-based retry index within the chain
}

export interface SmsDeliveryLogInput {
  recipient_phone: string;
  recipient_user_id?: string | null;
  recipient_name?: string | null;
  message?: string | null;
  status: "sent" | "failed" | "queued";
  provider?: string | null; // winning provider (or last tried)
  provider_message_id?: string | null;
  attempts: SmsAttemptRecord[];
  retries?: number; // number of full-chain retries performed
  cost?: string | null;
  reference_id?: string | null; // e.g. withdrawal_id
  source: string; // 'withdrawal_claim' | 'withdrawal_payout' | 'merchant_commission' | 'proxy_payout'
  error?: string | null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function extractProviderFields(attempt?: SmsAttemptRecord): { messageId: string | null; cost: string | null } {
  const response = (attempt?.response ?? null) as any;
  if (!response || typeof response !== "object") return { messageId: null, cost: null };

  const recipient = Array.isArray(response?.per_recipient)
    ? response.per_recipient[0]
    : Array.isArray(response?.SMSMessageData?.Recipients)
      ? response.SMSMessageData.Recipients[0]
      : null;

  const messageId = firstString(
    response?.message_id,
    response?.messageId,
    response?.id,
    recipient?.message_id,
    recipient?.messageId,
    // Yoola also returns a YOOLA-* per-recipient reference; keep it only when
    // the numeric message id is absent so audit rows still have a provider id.
    recipient?.reference,
  );
  const cost = firstString(
    recipient?.cost,
    response?.amount_charged,
    response?.credits_used,
    recipient?.credits,
  );

  return { messageId, cost };
}

// Minimal shape of the supabase-js client we rely on.
type AdminLike = {
  from: (table: string) => {
    insert: (rows: unknown) => Promise<{ error: unknown }>;
  };
};

export async function logSmsDelivery(
  admin: AdminLike,
  input: SmsDeliveryLogInput,
): Promise<void> {
  try {
    const winning = input.attempts.find((a) => a.ok);
    const provider =
      input.provider ??
      winning?.provider ??
      input.attempts[input.attempts.length - 1]?.provider ??
      "none";
    const combinedError =
      input.error ??
      (input.status === "sent"
        ? null
        : input.attempts
            .filter((a) => !a.ok && a.error)
            .map((a) => `${a.provider}: ${a.error}`)
            .join(" | ") || null);

    const providerFields = extractProviderFields(winning ?? input.attempts[input.attempts.length - 1]);

    await admin.from("sms_delivery_log").insert({
      recipient_phone: input.recipient_phone || "unknown",
      recipient_user_id: input.recipient_user_id ?? null,
      recipient_name: input.recipient_name ?? null,
      message: input.message ?? null,
      status: input.status,
      provider,
      provider_message_id: input.provider_message_id ?? providerFields.messageId,
      provider_response: {
        attempts: input.attempts,
        retries: input.retries ?? 0,
        total_provider_calls: input.attempts.length,
      },
      cost: input.cost ?? providerFields.cost,
      reference_id: input.reference_id ?? null,
      source: input.source,
      error: combinedError,
    });
  } catch (e) {
    // Never let auditing break the SMS flow.
    console.warn("[smsDeliveryLog] failed to record delivery status:", e);
  }
}

// ── Idempotency: reserve-before-send ──────────────────────────────────────
// Prevents a retried claim/payout action from sending the SAME SMS twice.
// The unique index on sms_delivery_log(idempotency_key) is the source of
// truth: whichever concurrent caller inserts the reservation row first "owns"
// the send; every other caller sees the existing row and skips.

type ReserveClient = {
  from: (table: string) => any;
};

export interface ReserveInput {
  idempotency_key: string;
  recipient_phone: string;
  recipient_user_id?: string | null;
  recipient_name?: string | null;
  message?: string | null;
  reference_id?: string | null;
  source: string;
}

export interface ReserveResult {
  proceed: boolean; // true → caller should send the SMS now
  alreadySent: boolean; // true → a prior attempt already delivered it
  logId: string | null; // row id to finalize when proceed=true
  reason: string;
}

/**
 * Claim the right to send one SMS for `idempotency_key`.
 * - No prior row  → inserts a `queued` reservation and returns proceed=true.
 * - Prior `sent`  → returns proceed=false, alreadySent=true (never resend).
 * - Prior `queued`→ another send is in flight → proceed=false (avoid double).
 * - Prior `failed`→ returns proceed=true reusing the row so a genuine failure
 *   can be retried without creating duplicate audit rows.
 */
export async function reserveSmsIdempotency(
  admin: ReserveClient,
  input: ReserveInput,
): Promise<ReserveResult> {
  try {
    const { data, error } = await admin
      .from("sms_delivery_log")
      .insert({
        idempotency_key: input.idempotency_key,
        recipient_phone: input.recipient_phone || "unknown",
        recipient_user_id: input.recipient_user_id ?? null,
        recipient_name: input.recipient_name ?? null,
        message: input.message ?? null,
        status: "queued",
        provider: "pending",
        reference_id: input.reference_id ?? null,
        source: input.source,
      })
      .select("id")
      .single();

    if (!error && data?.id) {
      return { proceed: true, alreadySent: false, logId: data.id, reason: "reserved" };
    }

    // Unique violation (23505) → a reservation already exists for this key.
    if (error && (error as any).code === "23505") {
      const { data: existing } = await admin
        .from("sms_delivery_log")
        .select("id, status")
        .eq("idempotency_key", input.idempotency_key)
        .maybeSingle();
      const status = String(existing?.status || "").toLowerCase();
      if (status === "sent") {
        return { proceed: false, alreadySent: true, logId: existing?.id ?? null, reason: "already_sent" };
      }
      if (status === "failed") {
        // Allow retrying a genuine prior failure; reuse the same audit row.
        return { proceed: true, alreadySent: false, logId: existing?.id ?? null, reason: "retry_after_failure" };
      }
      // queued / pending → another send is in flight; do not double-send.
      return { proceed: false, alreadySent: false, logId: existing?.id ?? null, reason: "in_flight" };
    }

    // Any other insert error: fail open (send without idempotency guarantee)
    // but log so the SMS itself is never blocked by an auditing hiccup.
    console.warn("[smsDeliveryLog] reserve insert error, proceeding without guard:", error);
    return { proceed: true, alreadySent: false, logId: null, reason: "reserve_error" };
  } catch (e) {
    console.warn("[smsDeliveryLog] reserve threw, proceeding without guard:", e);
    return { proceed: true, alreadySent: false, logId: null, reason: "reserve_threw" };
  }
}

/**
 * Finalize a previously reserved row (from reserveSmsIdempotency) with the
 * real send outcome: winning provider, attempt trail, retries and error.
 */
export async function finalizeSmsDelivery(
  admin: ReserveClient,
  logId: string,
  input: {
    status: "sent" | "failed";
    attempts: SmsAttemptRecord[];
    retries?: number;
    provider?: string | null;
    provider_message_id?: string | null;
    cost?: string | null;
    error?: string | null;
  },
): Promise<void> {
  try {
    const winning = input.attempts.find((a) => a.ok);
    const provider =
      input.provider ??
      winning?.provider ??
      input.attempts[input.attempts.length - 1]?.provider ??
      "none";
    const combinedError =
      input.error ??
      (input.status === "sent"
        ? null
        : input.attempts
            .filter((a) => !a.ok && a.error)
            .map((a) => `${a.provider}: ${a.error}`)
            .join(" | ") || null);

    const providerFields = extractProviderFields(winning ?? input.attempts[input.attempts.length - 1]);

    await admin
      .from("sms_delivery_log")
      .update({
        status: input.status,
        provider,
        provider_message_id: input.provider_message_id ?? providerFields.messageId,
        provider_response: {
          attempts: input.attempts,
          retries: input.retries ?? 0,
          total_provider_calls: input.attempts.length,
        },
        cost: input.cost ?? providerFields.cost,
        error: combinedError,
      })
      .eq("id", logId);
  } catch (e) {
    console.warn("[smsDeliveryLog] finalize failed:", e);
  }
}