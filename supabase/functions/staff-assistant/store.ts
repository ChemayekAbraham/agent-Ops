// The ONLY file in `staff-assistant/` that touches SUPABASE_SERVICE_ROLE_KEY or writes to tables.
// Every `assistant_staff_*` data tool RPC is called from `index.ts` with the caller's own JWT (`userClient`).
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { kampalaToday } from "./dates.ts";
import { ConversationMemorySummary, parseConversationMemory } from "./memory.ts";
import type { ChatMessage } from "./openai.ts";
import type { ClientContext } from "./schemas.ts";

const MAX_MESSAGES_PER_MINUTE = 10;
/** Prompt 3 item (2): Send the last 20 turns (40 messages). */
export const RECENT_HISTORY_MESSAGES = 40;
const DEFAULT_MAX_QUESTIONS_PER_DAY = 50;

export type TurnOutcome =
  | "answered"
  | "clarify"
  | "out_of_scope"
  | "not_staff"
  | "unmatched"
  | "rate_limited"
  | "blocked"
  | "error";

export type UnansweredReason =
  | "unmatched"
  | "missing_tool"
  | "role_restricted"
  | "out_of_scope"
  | "error";

export interface SessionMeta {
  ipAddress: string | null;
  userAgent: string | null;
  clientContext?: ClientContext;
}

export interface StaffAssistantConfig {
  enabled: boolean;
  maxQuestionsPerDay: number;
  maxEmailsPerDay: number;
  maxModelRounds: number;
  maxToolCalls: number;
  historyDays: number;
}

export interface ConversationListItem {
  id: string;
  title: string;
  message_count: number;
  last_active_at: string;
  created_at: string;
}

function parseUserAgent(ua: string | null, ctx?: ClientContext): {
  deviceClass: string;
  browser: string;
  os: string;
} {
  const s = ua ?? "";
  const w = ctx?.device?.screen_w;
  const deviceClass = /ipad|tablet/i.test(s) || (w && w >= 600 && w < 1024 && ctx?.device?.touch)
    ? "tablet"
    : /mobi|android|iphone|ipod/i.test(s) || (w && w < 600)
    ? "mobile"
    : s
    ? "desktop"
    : "unknown";

  const browser = /edg\//i.test(s)
    ? "Edge"
    : /opr\/|opera/i.test(s)
    ? "Opera"
    : /samsungbrowser/i.test(s)
    ? "Samsung Internet"
    : /ucbrowser/i.test(s)
    ? "UC Browser"
    : /chrome\/|crios\//i.test(s)
    ? "Chrome"
    : /firefox\/|fxios\//i.test(s)
    ? "Firefox"
    : /safari\//i.test(s) && !/chrome|crios|android/i.test(s)
    ? "Safari"
    : "Other";

  const os = /android/i.test(s)
    ? "Android"
    : /iphone|ipad|ipod/i.test(s)
    ? "iOS"
    : /windows nt/i.test(s)
    ? "Windows"
    : /mac os x|macintosh/i.test(s)
    ? "macOS"
    : /cros/i.test(s)
    ? "ChromeOS"
    : /linux/i.test(s)
    ? "Linux"
    : "Other";

  return { deviceClass, browser, os };
}

function admin(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Provides the service-role client strictly to `requireStaffAal2` in `index.ts`
 * so `SUPABASE_SERVICE_ROLE_KEY` is never referenced outside `store.ts`.
 */
export function getAdminClientForMfa(): SupabaseClient {
  return admin();
}

export async function loadStaffAssistantConfig(): Promise<StaffAssistantConfig> {
  const db = admin();
  const { data } = await db
    .from("staff_assistant_config")
    .select(
      "enabled, max_questions_per_day, max_emails_per_day, max_model_rounds, max_tool_calls, history_days",
    )
    .eq("id", true)
    .maybeSingle();

  return {
    enabled: data?.enabled ?? true,
    maxQuestionsPerDay: data?.max_questions_per_day ?? DEFAULT_MAX_QUESTIONS_PER_DAY,
    maxEmailsPerDay: data?.max_emails_per_day ?? 30,
    maxModelRounds: data?.max_model_rounds ?? 4,
    maxToolCalls: data?.max_tool_calls ?? 6,
    historyDays: data?.history_days ?? 90,
  };
}

export type BudgetCheckResult =
  | {
      allowed: true;
      remainingToday: number;
      maxQuestionsPerDay: number;
      maxModelRounds: number;
      maxToolCalls: number;
    }
  | { allowed: false; reason: "burst" | "daily_budget"; maxQuestionsPerDay: number };

/**
 * Enforces both:
 *  1. Burst rate limit (max 10 messages per minute per staff member).
 *  2. Daily question budget (`max_questions_per_day` from `staff_assistant_config`,
 *     counted across the current Africa/Kampala day).
 * Uses `staff_assistant_check_question_rate_limit` (transaction advisory lock) first so
 * parallel requests cannot race the counter, with a fallback to direct queries.
 */
export async function checkQuestionBudget(userId: string): Promise<BudgetCheckResult> {
  const db = admin();
  const { data: atomicRes, error: atomicErr } = await db.rpc(
    "staff_assistant_check_question_rate_limit",
    { p_user_id: userId },
  );

  if (!atomicErr && atomicRes && typeof atomicRes === "object") {
    const r = atomicRes as Record<string, unknown>;
    const limitToday =
      typeof r.limit_today === "number" ? r.limit_today : DEFAULT_MAX_QUESTIONS_PER_DAY;
    const usedToday = typeof r.used_today === "number" ? r.used_today : 0;
    const maxModelRounds = typeof r.max_model_rounds === "number" ? r.max_model_rounds : 4;
    const maxToolCalls = typeof r.max_tool_calls === "number" ? r.max_tool_calls : 6;
    if (r.allowed === false) {
      return {
        allowed: false,
        reason: r.reason === "rate_limited" ? "burst" : "daily_budget",
        maxQuestionsPerDay: limitToday,
      };
    }
    return {
      allowed: true,
      remainingToday: Math.max(limitToday - usedToday - 1, 0),
      maxQuestionsPerDay: limitToday,
      maxModelRounds,
      maxToolCalls,
    };
  }

  const cfg = await loadStaffAssistantConfig();

  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  const { count: burstCount } = await db
    .from("staff_assistant_messages")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("role", "user")
    .gte("created_at", oneMinuteAgo);

  if ((burstCount ?? 0) >= MAX_MESSAGES_PER_MINUTE) {
    return { allowed: false, reason: "burst", maxQuestionsPerDay: cfg.maxQuestionsPerDay };
  }

  const todayKampalaStart = `${kampalaToday()}T00:00:00+03:00`;
  const { count: todayCount } = await db
    .from("staff_assistant_messages")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("role", "user")
    .gte("created_at", todayKampalaStart);

  const usedToday = todayCount ?? 0;
  if (usedToday >= cfg.maxQuestionsPerDay) {
    return { allowed: false, reason: "daily_budget", maxQuestionsPerDay: cfg.maxQuestionsPerDay };
  }

  return {
    allowed: true,
    remainingToday: Math.max(cfg.maxQuestionsPerDay - usedToday - 1, 0),
    maxQuestionsPerDay: cfg.maxQuestionsPerDay,
    maxModelRounds: cfg.maxModelRounds,
    maxToolCalls: cfg.maxToolCalls,
  };
}

export async function getOrCreateConversation(
  userId: string,
  conversationId: string | undefined,
  meta: SessionMeta,
): Promise<{ id: string; status: string; memory?: ConversationMemorySummary }> {
  const db = admin();
  const ua = parseUserAgent(meta.userAgent, meta.clientContext);
  const sessionPatch = {
    ip_address: meta.ipAddress?.slice(0, 64) ?? null,
    user_agent: meta.userAgent?.slice(0, 512) ?? null,
    device_class: ua.deviceClass,
    device_browser: ua.browser,
    device_os: ua.os,
  };

  if (conversationId) {
    let { data, error: selErr } = await db
      .from("staff_assistant_conversations")
      .select("id, status, conversation_summary")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .maybeSingle();
    if (selErr) {
      const fallback = await db
        .from("staff_assistant_conversations")
        .select("id, status")
        .eq("id", conversationId)
        .eq("user_id", userId)
        .maybeSingle();
      data = fallback.data ? { ...fallback.data, conversation_summary: null } : null;
    }
    if (data) {
      await db.from("staff_assistant_conversations").update(sessionPatch).eq("id", data.id);
      return {
        id: data.id,
        status: data.status,
        memory: parseConversationMemory(
          (data as Record<string, unknown>).conversation_summary ?? null,
        ),
      };
    }
  }

  let { data, error } = await db
    .from("staff_assistant_conversations")
    .insert({ user_id: userId, persona: "staff", ...sessionPatch })
    .select("id, status, conversation_summary")
    .single();
  if (error) {
    const fallback = await db
      .from("staff_assistant_conversations")
      .insert({ user_id: userId, persona: "staff", ...sessionPatch })
      .select("id, status")
      .single();
    data = fallback.data ? { ...fallback.data, conversation_summary: null } : null;
    error = fallback.error;
  }
  if (error || !data) throw new Error(`could not create conversation: ${error?.message}`);
  return {
    id: data.id,
    status: data.status,
    memory: parseConversationMemory(
      (data as Record<string, unknown>).conversation_summary ?? null,
    ),
  };
}

export async function loadRecentTurns(userId: string, conversationId: string): Promise<ChatMessage[]> {
  const db = admin();
  let { data, error } = await db
    .from("staff_assistant_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .eq("hidden_by_user", false)
    .order("created_at", { ascending: false })
    .limit(RECENT_HISTORY_MESSAGES);

  if (error) {
    const fallback = await db
      .from("staff_assistant_messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(RECENT_HISTORY_MESSAGES);
    data = fallback.data;
  }

  return (data ?? [])
    .reverse()
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

export async function loadLatestReportPayload(
  userId: string,
  conversationId: string,
): Promise<Record<string, unknown> | null> {
  const db = admin();
  let { data, error } = await db
    .from("staff_assistant_messages")
    .select("report_payload")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .eq("role", "assistant")
    .eq("hidden_by_user", false)
    .not("report_payload", "is", null)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    const fallback = await db
      .from("staff_assistant_messages")
      .select("report_payload")
      .eq("conversation_id", conversationId)
      .eq("user_id", userId)
      .eq("role", "assistant")
      .not("report_payload", "is", null)
      .order("created_at", { ascending: false })
      .limit(5);
    data = fallback.data;
  }

  for (const row of data ?? []) {
    const rp = row?.report_payload;
    if (rp && typeof rp === "object" && !Array.isArray(rp)) {
      const obj = rp as Record<string, unknown>;
      if (typeof obj.tool === "string" && typeof obj.rpc === "string") {
        return obj;
      }
    }
  }
  return null;
}

export async function recordTurn(
  args: {
    conversationId: string;
    userId: string;
    userMessage: string;
    assistantMessage: string;
    outcome: TurnOutcome;
    toolsCalled?: string[];
    sourceLabel?: string | null;
    periodLabel?: string | null;
    reportPayload?: Record<string, unknown> | null;
    conversationSummary?: ConversationMemorySummary | null;
    model?: string;
    latencyMs?: number;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbOverride?: any,
): Promise<{ userMessageId: string | null; assistantMessageId: string | null }> {
  const db = dbOverride ?? admin();
  const userRow = {
    conversation_id: args.conversationId,
    user_id: args.userId,
    role: "user" as const,
    content: args.userMessage.slice(0, 8000),
    outcome: null,
    tools_called: [] as string[],
    source_label: null,
    period_label: null,
    report_payload: null,
    model: null,
    latency_ms: null,
  };
  const assistantRow = {
    conversation_id: args.conversationId,
    user_id: args.userId,
    role: "assistant" as const,
    content: args.assistantMessage.slice(0, 8000),
    outcome: args.outcome,
    tools_called: args.toolsCalled ?? [],
    source_label: args.sourceLabel ? args.sourceLabel.slice(0, 240) : null,
    period_label: args.periodLabel ? args.periodLabel.slice(0, 120) : null,
    report_payload: args.reportPayload ?? null,
    model: args.model ? args.model.slice(0, 120) : null,
    latency_ms: args.latencyMs ?? null,
  };

  let { data: inserted, error: insertErr } = await db
    .from("staff_assistant_messages")
    .insert([userRow, assistantRow])
    .select("id, role");

  if (insertErr || !inserted || inserted.length === 0) {
    const uRes = await db.from("staff_assistant_messages").insert(userRow).select("id, role");
    const aRes = await db.from("staff_assistant_messages").insert(assistantRow).select("id, role");
    inserted = [...(uRes.data ?? []), ...(aRes.data ?? [])];
  }

  const { data: conv } = await db
    .from("staff_assistant_conversations")
    .select("message_count, title")
    .eq("id", args.conversationId)
    .maybeSingle();

  const nextTitle = conv?.title ?? args.userMessage.slice(0, 120);
  const nowIso = new Date().toISOString();
  const { error: convUpdateErr } = await db
    .from("staff_assistant_conversations")
    .update({
      last_active_at: nowIso,
      last_message_at: nowIso,
      message_count: (conv?.message_count ?? 0) + 2,
      title: nextTitle,
      ...(args.conversationSummary ? { conversation_summary: args.conversationSummary } : {}),
    })
    .eq("id", args.conversationId);

  if (convUpdateErr) {
    await db
      .from("staff_assistant_conversations")
      .update({
        last_active_at: nowIso,
        message_count: (conv?.message_count ?? 0) + 2,
        title: nextTitle,
      })
      .eq("id", args.conversationId);
  }

  const userMsg = (inserted ?? []).find((r) => r.role === "user");
  const assistantMsg = (inserted ?? []).find((r) => r.role === "assistant");
  return {
    userMessageId: userMsg?.id ?? null,
    assistantMessageId: assistantMsg?.id ?? null,
  };
}

export async function recordUnanswered(args: {
  conversationId: string;
  messageId: string | null;
  userId: string;
  callerRoles: readonly string[];
  questionText: string;
  reason: UnansweredReason;
}): Promise<void> {
  const db = admin();
  await db.from("staff_assistant_unanswered").insert({
    conversation_id: args.conversationId,
    message_id: args.messageId,
    user_id: args.userId,
    caller_roles: [...args.callerRoles],
    question_text: args.questionText.slice(0, 2000),
    reason: args.reason,
    status: "open",
  });
}

export async function saveFeedback(args: {
  conversationId: string;
  messageId: string;
  userId: string;
  rating: "up" | "down";
  comment?: string;
}): Promise<{ ok: boolean }> {
  const db = admin();
  const { data: msg } = await db
    .from("staff_assistant_messages")
    .select("id")
    .eq("id", args.messageId)
    .eq("conversation_id", args.conversationId)
    .eq("user_id", args.userId)
    .maybeSingle();

  if (!msg) return { ok: false };

  const { error } = await db.from("staff_assistant_feedback").upsert(
    {
      conversation_id: args.conversationId,
      message_id: args.messageId,
      user_id: args.userId,
      rating: args.rating,
      comment: args.comment ? args.comment.slice(0, 1000) : null,
    },
    { onConflict: "message_id,user_id" },
  );
  return { ok: !error };
}

export async function loadConversationHistory(
  userId: string,
  conversationId?: string,
  limit = 40,
): Promise<{
  conversation_id: string | null;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    outcome: string | null;
    tools_called?: string[];
    source_label: string | null;
    period_label: string | null;
    report_payload: Record<string, unknown> | null;
    created_at: string;
  }>;
}> {
  const db = admin();
  let targetId = conversationId ?? null;

  if (!targetId) {
    let { data: conv, error: convErr } = await db
      .from("staff_assistant_conversations")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "open")
      .eq("hidden_by_user", false)
      .order("last_active_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (convErr) {
      const fallback = await db
        .from("staff_assistant_conversations")
        .select("id")
        .eq("user_id", userId)
        .eq("status", "open")
        .order("last_active_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      conv = fallback.data;
    }
    targetId = conv?.id ?? null;
  }

  if (!targetId) return { conversation_id: null, messages: [] };

  let { data: rows, error: rowsErr } = await db
    .from("staff_assistant_messages")
    .select(
      "id, role, content, outcome, tools_called, source_label, period_label, report_payload, created_at",
    )
    .eq("conversation_id", targetId)
    .eq("user_id", userId)
    .eq("hidden_by_user", false)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 50));

  if (rowsErr) {
    const fallback = await db
      .from("staff_assistant_messages")
      .select(
        "id, role, content, outcome, tools_called, source_label, period_label, report_payload, created_at",
      )
      .eq("conversation_id", targetId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 50));
    rows = fallback.data;
  }

  return {
    conversation_id: targetId,
    messages: (rows ?? []).reverse(),
  };
}

export async function listUserConversations(
  userId: string,
  limit = 25,
): Promise<ConversationListItem[]> {
  const db = admin();
  let { data, error } = await db
    .from("staff_assistant_conversations")
    .select("id, title, message_count, last_active_at, started_at, created_at")
    .eq("user_id", userId)
    .eq("hidden_by_user", false)
    .order("last_active_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 40));

  if (error) {
    const fallback = await db
      .from("staff_assistant_conversations")
      .select("id, title, message_count, last_active_at, started_at")
      .eq("user_id", userId)
      .order("last_active_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 40));
    data = (fallback.data ?? []).map((r) => ({ ...r, created_at: r.started_at }));
  }

  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const createdAt =
      (typeof r.created_at === "string" && r.created_at) ||
      (typeof r.started_at === "string" && r.started_at) ||
      (typeof r.last_active_at === "string" && r.last_active_at) ||
      new Date().toISOString();
    return {
      id: r.id as string,
      title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : "New chat",
      message_count: typeof r.message_count === "number" ? r.message_count : 0,
      last_active_at: (r.last_active_at as string) ?? createdAt,
      created_at: createdAt,
    };
  });
}

export async function createNewConversation(
  userId: string,
  meta: SessionMeta,
  title?: string,
): Promise<ConversationListItem> {
  const db = admin();
  const ua = parseUserAgent(meta.userAgent, meta.clientContext);
  const nowIso = new Date().toISOString();
  const cleanTitle = title?.trim() ? title.trim().slice(0, 120) : "New chat";
  let { data, error } = await db
    .from("staff_assistant_conversations")
    .insert({
      user_id: userId,
      persona: "staff",
      title: cleanTitle,
      last_active_at: nowIso,
      last_message_at: nowIso,
      ip_address: meta.ipAddress?.slice(0, 64) ?? null,
      user_agent: meta.userAgent?.slice(0, 512) ?? null,
      device_class: ua.deviceClass,
      device_browser: ua.browser,
      device_os: ua.os,
    })
    .select("id, title, message_count, last_active_at, started_at, created_at")
    .single();
  if (error) {
    const fallback = await db
      .from("staff_assistant_conversations")
      .insert({
        user_id: userId,
        persona: "staff",
        title: cleanTitle,
        last_active_at: nowIso,
        ip_address: meta.ipAddress?.slice(0, 64) ?? null,
        user_agent: meta.userAgent?.slice(0, 512) ?? null,
        device_class: ua.deviceClass,
        device_browser: ua.browser,
        device_os: ua.os,
      })
      .select("id, title, message_count, last_active_at, started_at")
      .single();
    data = fallback.data ? { ...fallback.data, created_at: fallback.data.started_at } : null;
    error = fallback.error;
  }
  if (error || !data) throw new Error(`could not create conversation: ${error?.message}`);
  const row = data as Record<string, unknown>;
  const createdAt =
    (typeof row.created_at === "string" && row.created_at) ||
    (typeof row.started_at === "string" && row.started_at) ||
    nowIso;
  return {
    id: row.id as string,
    title: (row.title as string) ?? cleanTitle,
    message_count: (row.message_count as number) ?? 0,
    last_active_at: (row.last_active_at as string) ?? nowIso,
    created_at: createdAt,
  };
}

export async function renameUserConversation(
  userId: string,
  conversationId: string,
  title: string,
): Promise<{ ok: boolean; title: string }> {
  const db = admin();
  const cleanTitle = title.trim().slice(0, 120);
  const { data, error } = await db
    .from("staff_assistant_conversations")
    .update({ title: cleanTitle })
    .eq("id", conversationId)
    .eq("user_id", userId)
    .select("id, title")
    .maybeSingle();

  if (error || !data) {
    return { ok: false, title: cleanTitle };
  }
  return { ok: true, title: (data.title as string) ?? cleanTitle };
}

/**
 * Soft-hides the user's conversation history (`hidden_by_user = true`) rather than deleting rows,
 * preserving the 90-day server audit trail for CRM review.
 */
export async function clearUserHistory(userId: string, conversationId?: string): Promise<void> {
  const db = admin();
  const nowIso = new Date().toISOString();

  await db.rpc("staff_assistant_hide_my_history", {
    p_user_id: userId,
    p_conversation_id: conversationId ?? null,
  });

  if (conversationId) {
    await db
      .from("staff_assistant_messages")
      .update({ hidden_by_user: true, hidden_at: nowIso })
      .eq("conversation_id", conversationId)
      .eq("user_id", userId);
    await db
      .from("staff_assistant_conversations")
      .update({ hidden_by_user: true, hidden_at: nowIso })
      .eq("id", conversationId)
      .eq("user_id", userId);
    return;
  }

  await db
    .from("staff_assistant_messages")
    .update({ hidden_by_user: true, hidden_at: nowIso })
    .eq("user_id", userId);
  await db
    .from("staff_assistant_conversations")
    .update({ hidden_by_user: true, hidden_at: nowIso })
    .eq("user_id", userId);
}
