// Neexa Integration API (https://developers.neexa.co, spec at /openapi.yaml).
// Shared by neexa-webhook (inbound events) and neexa-api (staff proxy).
//
// Secrets: NEEXA_API_KEY (bearer key from Neexa → Workspace → Developers) and
// NEEXA_WEBHOOK_SECRET (the webhook signing secret from the same page).

// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export const NEEXA_API_BASE = "https://api.neexa.co";

export class NeexaError extends Error {
  constructor(public status: number, message: string, public body: unknown = null) {
    super(message);
  }
}

/** Calls the Neexa API with the workspace key. Throws NeexaError on any non-2xx. */
export async function neexaFetch(
  path: string,
  init: { method?: string; query?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<any> {
  const key = Deno.env.get("NEEXA_API_KEY")?.trim();
  if (!key) throw new NeexaError(500, "NEEXA_API_KEY is not set");

  const url = new URL(path, NEEXA_API_BASE);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });

  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    // Neexa answers an unauthenticated call with 500, not 401, so a bad key looks like
    // a server error. Say so rather than letting it pass as an outage.
    const msg = parsed?.message ?? `Neexa returned ${res.status}`;
    throw new NeexaError(res.status, res.status === 500 ? `${msg} (check NEEXA_API_KEY)` : msg, parsed);
  }
  return parsed;
}

// ---------------------------------------------------------------------------------------
// Webhook signature: HMAC-SHA256(raw body, signing secret) in X-Neexa-Signature.
// The docs do not state the encoding, so hex (optionally "sha256=" prefixed, any case)
// and base64 are both accepted. Both are the same HMAC, so this is no weaker.
// ---------------------------------------------------------------------------------------
export async function hmacSha256(secret: string, body: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyNeexaSignature(secret: string, raw: string, header: string): Promise<boolean> {
  const sig = header.trim().replace(/^sha256=/i, "");
  if (!sig) return false;
  const mac = await hmacSha256(secret, raw);
  const hex = Array.from(mac).map((b) => b.toString(16).padStart(2, "0")).join("");
  const b64 = btoa(String.fromCharCode(...mac));
  // Evaluate both, so timing does not reveal which encoding matched.
  const hexOk = timingSafeEqual(sig.toLowerCase(), hex);
  const b64Ok = timingSafeEqual(sig, b64);
  return hexOk || b64Ok;
}

// ---------------------------------------------------------------------------------------
// Mirror writes
// ---------------------------------------------------------------------------------------
export interface IngestMessage {
  message_id: string;
  conversation_id: string;
  direction: "inbound" | "outbound";
  source: "customer" | "echo" | "api" | "sync";
  body: string | null;
  sent_at: string | null;
  channel?: string | null;
  creator_type?: string | null;
  status?: string | null;
  message_type?: string | null;
  platform_message_id?: string | null;
  platform_id?: string | null;
  customer_address?: string | null;
  template_public_id?: string | null;
  sent_by?: string | null;
}

export async function ingestMessage(admin: SupabaseClient, m: IngestMessage): Promise<void> {
  const { error } = await admin.rpc("neexa_ingest_message", {
    _message_id: m.message_id,
    _conversation_id: m.conversation_id,
    _direction: m.direction,
    _source: m.source,
    _body: m.body,
    _sent_at: m.sent_at,
    _channel: m.channel ?? null,
    _creator_type: m.creator_type ?? null,
    _status: m.status ?? null,
    _message_type: m.message_type ?? null,
    _platform_message_id: m.platform_message_id ?? null,
    _platform_id: m.platform_id ?? null,
    _customer_address: m.customer_address ?? null,
    _template_public_id: m.template_public_id ?? null,
    _sent_by: m.sent_by ?? null,
  });
  if (error) throw new Error(`neexa_ingest_message: ${error.message}`);
}

/** A JSON:API conversation resource (type ai_human_conversations) → mirror row. */
export function conversationRow(r: any) {
  const a = r?.attributes ?? {};
  return {
    id: String(r.id),
    platform: a.platform ?? null,
    title: a.title ?? null,
    label: a.label ?? null,
    sentiment: a.sentiment ?? null,
    description: a.description ?? null,
    neexa_created_at: a.created_at ?? null,
    neexa_updated_at: a.updated_at ?? null,
    details_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Upserts conversation details (title, label, sentiment, ...). Leaves the
 * last-message fields alone, because neexa_ingest_message owns those.
 */
export async function upsertConversations(admin: SupabaseClient, resources: any[]): Promise<void> {
  const rows = resources.filter((r) => r?.id != null).map(conversationRow);
  if (!rows.length) return;
  const { error } = await admin.from("neexa_conversations").upsert(rows, { onConflict: "id" });
  if (error) throw new Error(`neexa_conversations upsert: ${error.message}`);
}

/** A JSON:API message resource (type widget_messages) → ingest call. */
export function messageFromResource(r: any, conversationId: string, source: IngestMessage["source"]): IngestMessage {
  const a = r?.attributes ?? {};
  return {
    message_id: String(r.id),
    conversation_id: String(a.ai_human_conversation_id ?? conversationId),
    direction: a.message_creator_type === "client" ? "inbound" : "outbound",
    source,
    body: a.message ?? null,
    sent_at: a.created_at ?? null,
    channel: a.channel ?? null,
    creator_type: a.message_creator_type ?? null,
    status: a.status ?? null,
    message_type: a.message_type ?? null,
  };
}
