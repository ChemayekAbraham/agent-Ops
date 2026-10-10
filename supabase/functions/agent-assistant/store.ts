/**
 * Conversation log for the CRM. This is the ONLY module in the function that uses the service
 * role, and it only touches assistant_* tables. Everything that reads the agent's own data goes
 * through the user's JWT in index.ts, so RLS and auth.uid() apply to it.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { ClientContext } from "./schemas.ts";

/** A conversation idle this long, or this long in messages, is closed and a new one starts. */
export const IDLE_MS = 30 * 60 * 1000;
export const MAX_MESSAGES_PER_CONVERSATION = 60;
export const HISTORY_LIMIT = 10;
export const RATE_PER_MINUTE = 10;
export const RATE_PER_DAY = 200;

export type Outcome =
  | "answered"
  | "clarify"
  | "out_of_scope"
  | "not_an_agent"
  | "unmatched"
  | "rate_limited"
  | "blocked"
  | "error";

const FAILURE_OUTCOMES: Outcome[] = ["unmatched", "blocked", "error"];

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface Conversation {
  id: string;
  messageCount: number;
}

/**
 * What we know about where a request came from. `ip`, `userAgent` and `device` are observed by
 * the server; `clientDevice` and `geo` are reported by the client and are stored as hints only.
 */
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  device: { deviceClass: string; browser: string; os: string };
  clientDevice?: NonNullable<ClientContext["device"]>;
  geo?: NonNullable<ClientContext["geo"]>;
}

// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/g;
const clip = (s: string | null | undefined, max: number) => (s ? s.replace(CONTROL, "").slice(0, max) : null);

/** Fields the client may refresh mid-conversation (GPS moves, permission is granted later). */
function reportedFields(ctx: RequestContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ctx.clientDevice && Object.keys(ctx.clientDevice).length) out.client_device = ctx.clientDevice;
  if (ctx.geo) {
    out.geo_lat = Math.round(ctx.geo.lat * 1e6) / 1e6;
    out.geo_lng = Math.round(ctx.geo.lng * 1e6) / 1e6;
    out.geo_accuracy_m = ctx.geo.accuracy_m !== undefined ? Math.round(ctx.geo.accuracy_m * 10) / 10 : null;
    out.geo_captured_at = new Date().toISOString();
  }
  return out;
}

/**
 * Server-owned session. The client may SUGGEST a conversation id but it is only honoured if the
 * row belongs to this user, is still open, is recent and not full. Anything else (someone
 * else's id, a stale id, a made-up id) quietly becomes a fresh conversation.
 *
 * A new conversation records IP / user agent / device (server-observed) plus any client-reported
 * device details and GPS. A reused one only refreshes the client-reported fields.
 */
export async function resolveConversation(
  userId: string,
  requestedId: string | undefined,
  ctx: RequestContext,
): Promise<Conversation> {
  const db = admin();

  if (requestedId) {
    const { data } = await db
      .from("assistant_conversations")
      .select("id, status, last_active_at, message_count")
      .eq("id", requestedId)
      .eq("user_id", userId)
      .maybeSingle();
    if (
      data &&
      data.status === "open" &&
      Date.now() - Date.parse(data.last_active_at) < IDLE_MS &&
      data.message_count < MAX_MESSAGES_PER_CONVERSATION
    ) {
      const refresh = reportedFields(ctx);
      if (Object.keys(refresh).length) {
        const { error } = await db.from("assistant_conversations").update(refresh).eq("id", data.id);
        if (error) console.error("[agent-assistant] failed to refresh context", error.message);
      }
      return { id: data.id, messageCount: data.message_count };
    }
  }

  await db
    .from("assistant_conversations")
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("status", "open")
    .lt("last_active_at", new Date(Date.now() - IDLE_MS).toISOString());

  const { data, error } = await db
    .from("assistant_conversations")
    .insert({
      user_id: userId,
      persona: "agent",
      ip_address: clip(ctx.ip, 64),
      user_agent: clip(ctx.userAgent, 512),
      device_class: clip(ctx.device.deviceClass, 32),
      device_browser: clip(ctx.device.browser, 64),
      device_os: clip(ctx.device.os, 64),
      ...reportedFields(ctx),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`could not start conversation: ${error?.message}`);
  return { id: data.id, messageCount: 0 };
}

/** Ownership-checked fetch, used by the escalate action. */
export async function getOwnedConversation(userId: string, conversationId: string) {
  const { data } = await admin()
    .from("assistant_conversations")
    .select("id, status")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  return data ?? null;
}

/** Previous turns only; rebuilt from our own table, never from the client. */
export async function loadHistory(conversationId: string): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const { data } = await admin()
    .from("assistant_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  return (data ?? []).reverse().map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string }));
}

export async function logMessage(m: {
  conversationId: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
  outcome?: Outcome;
  toolsCalled?: string[];
  model?: string;
  latencyMs?: number;
}): Promise<string | null> {
  const { data, error } = await admin()
    .from("assistant_messages")
    .insert({
      conversation_id: m.conversationId,
      user_id: m.userId,
      role: m.role,
      content: m.content.slice(0, 4000),
      outcome: m.outcome ?? null,
      tools_called: m.toolsCalled ?? [],
      model: m.model ?? null,
      latency_ms: m.latencyMs ?? null,
    })
    .select("id")
    .single();
  if (error) {
    // The answer is still delivered; the gap is visible in the function logs.
    console.error("[agent-assistant] failed to log message", error.message);
    return null;
  }
  return data.id;
}

export async function touchConversation(
  conversationId: string,
  opts: { messageCount?: number; escalated?: boolean } = {},
) {
  const now = new Date().toISOString();
  await admin()
    .from("assistant_conversations")
    .update({
      last_active_at: now,
      ...(opts.messageCount !== undefined ? { message_count: opts.messageCount } : {}),
      ...(opts.escalated ? { status: "escalated", escalated_at: now } : {}),
    })
    .eq("id", conversationId);
}

/** Rate limit on user turns: returns true when the user is over either limit. */
export async function isRateLimited(userId: string): Promise<boolean> {
  const db = admin();
  const since = (ms: number) => new Date(Date.now() - ms).toISOString();
  const count = async (ms: number) => {
    const { count } = await db
      .from("assistant_messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("role", "user")
      .gte("created_at", since(ms));
    return count ?? 0;
  };
  const [minute, day] = await Promise.all([count(60_000), count(24 * 60 * 60_000)]);
  return minute >= RATE_PER_MINUTE || day >= RATE_PER_DAY;
}

export async function createEscalation(
  userId: string,
  conversationId: string,
  note: string | undefined,
): Promise<{ created: boolean }> {
  const db = admin();

  const { data: existing } = await db
    .from("assistant_escalations")
    .select("id")
    .eq("conversation_id", conversationId)
    .in("status", ["open", "in_progress"])
    .limit(1);
  if (existing && existing.length) return { created: false };

  const { data: recent } = await db
    .from("assistant_messages")
    .select("id, role, outcome")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(8);
  const rows = recent ?? [];
  const failed = rows.find((r) => r.role === "assistant" && FAILURE_OUTCOMES.includes(r.outcome as Outcome));
  const outOfScope = rows.filter((r) => r.role === "assistant" && r.outcome === "out_of_scope").length;
  const lastUser = rows.find((r) => r.role === "user");

  const reason = failed ? "unanswered" : outOfScope >= 2 ? "out_of_scope_repeated" : "user_requested";
  const { error } = await db.from("assistant_escalations").insert({
    conversation_id: conversationId,
    user_id: userId,
    trigger_message_id: (failed ?? lastUser)?.id ?? null,
    reason,
    user_note: note || null,
  });
  if (error) throw new Error(`could not create escalation: ${error.message}`);
  return { created: true };
}
