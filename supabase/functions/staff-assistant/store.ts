// The ONLY file in `staff-assistant/` that touches SUPABASE_SERVICE_ROLE_KEY or writes to tables.
// Every `assistant_staff_*` data tool RPC is called from `index.ts` with the caller's own JWT (`userClient`).
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { kampalaToday } from "./dates.ts";
import { validateZoeNoteText } from "./guards.ts";
import {
  buildRollingConversationSummary,
  ConversationMemorySummary,
  MAX_ZOE_NOTES_PER_USER,
  parseConversationMemory,
  ZoeNoteRecord,
} from "./memory.ts";
import { MSG } from "./messages.ts";
import {
  ChatMessage,
  DEFAULT_CHAT_MAX_TOKENS,
  DEFAULT_CHAT_TEMPERATURE,
  DEFAULT_MAX_COST_USD_PER_QUESTION,
  DEFAULT_ZOE_MODEL_DEEP,
  DEFAULT_ZOE_MODEL_FAST,
  MAX_DEEP_MODEL_ROUNDS,
  MAX_DEEP_TOOL_CALLS,
  ZoeModelTierConfig,
} from "./openai.ts";
import type { ClientContext } from "./schemas.ts";


const MAX_MESSAGES_PER_MINUTE = 10;
/** Prompt 3 item (6): Send the last 20 turns (40 messages) verbatim; summarise older turns. */
export const RECENT_HISTORY_MESSAGES = 40;
export const MAX_LOADED_HISTORY_MESSAGES = 80;
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

export const ZOE_ERROR_CODES = {
  ERR_DB_HEALTH_BEHIND: "ERR_DB_HEALTH_BEHIND",
  ERR_DB_CONFIG_MISSING: "ERR_DB_CONFIG_MISSING",
  ERR_DB_RATE_LIMIT_RPC_MISSING: "ERR_DB_RATE_LIMIT_RPC_MISSING",
  ERR_DB_CONVERSATION_SCHEMA_BEHIND: "ERR_DB_CONVERSATION_SCHEMA_BEHIND",
  ERR_DB_HISTORY_READ_FAILED: "ERR_DB_HISTORY_READ_FAILED",
  ERR_DB_NOTES_MISSING: "ERR_DB_NOTES_MISSING",
  ERR_DB_GLOSSARY_MISSING: "ERR_DB_GLOSSARY_MISSING",
  ERR_DB_HIDE_HISTORY_MISSING: "ERR_DB_HIDE_HISTORY_MISSING",
  ERR_DB_SAVE_DRAFT_MISSING: "ERR_DB_SAVE_DRAFT_MISSING",
  ERR_DB_CAN_READ_REPORT_MISSING: "ERR_DB_CAN_READ_REPORT_MISSING",
  ERR_DB_ANALYST_CATALOG_MISSING: "ERR_DB_ANALYST_CATALOG_MISSING",
  ERR_DB_ANALYST_QUERY_MISSING: "ERR_DB_ANALYST_QUERY_MISSING",
  ERR_DB_TOOL_RPC_FAILED: "ERR_DB_TOOL_RPC_FAILED",
  ERR_DB_MORNING_BRIEF_FAILED: "ERR_DB_MORNING_BRIEF_FAILED",
  ERR_DB_RECORD_TURN_FAILED: "ERR_DB_RECORD_TURN_FAILED",
  ERR_WEB_RESEARCH_FAILED: "ERR_WEB_RESEARCH_FAILED",
  ERR_AI_GATEWAY_UNREACHABLE: "ERR_AI_GATEWAY_UNREACHABLE",
} as const;

export type ZoeErrorCode = (typeof ZOE_ERROR_CODES)[keyof typeof ZOE_ERROR_CODES] | string;

export interface StaffAssistantHealthStatus {
  ok: boolean;
  status: "ok" | "zoe_database_behind";
  missingObjects: string[];
  missingFunctions: string[];
  missingTables: string[];
  missingColumns: string[];
  missingViews: string[];
  checkedAtMs: number;
}

const HEALTH_CACHE_TTL_MS = 60_000;
let cachedHealthStatus: StaffAssistantHealthStatus | null = null;
let cachedHealthExpiresAtMs = 0;

export function resetStaffAssistantHealthCache(): void {
  cachedHealthStatus = null;
  cachedHealthExpiresAtMs = 0;
}

/**
 * Maps a missing database function name to its canonical Zoe error code.
 */
export function mapMissingFunctionToErrorCode(fnName: string): ZoeErrorCode {
  const clean = fnName.replace(/^public\./i, "").replace(/\([^)]*\)$/, "").trim().toLowerCase();
  if (clean === "staff_assistant_get_config") return ZOE_ERROR_CODES.ERR_DB_CONFIG_MISSING;
  if (clean === "staff_assistant_can_user_read_report") {
    return ZOE_ERROR_CODES.ERR_DB_CAN_READ_REPORT_MISSING;
  }
  if (clean === "staff_assistant_save_draft") return ZOE_ERROR_CODES.ERR_DB_SAVE_DRAFT_MISSING;
  if (clean === "assistant_staff_get_glossary") return ZOE_ERROR_CODES.ERR_DB_GLOSSARY_MISSING;
  if (clean === "staff_assistant_hide_my_history") {
    return ZOE_ERROR_CODES.ERR_DB_HIDE_HISTORY_MISSING;
  }
  if (clean === "assistant_staff_run_query") return ZOE_ERROR_CODES.ERR_DB_ANALYST_QUERY_MISSING;
  if (
    clean === "assistant_staff_get_data_catalog" ||
    clean === "assistant_staff_data_catalog"
  ) {
    return ZOE_ERROR_CODES.ERR_DB_ANALYST_CATALOG_MISSING;
  }
  if (clean === "staff_assistant_check_question_rate_limit") {
    return ZOE_ERROR_CODES.ERR_DB_RATE_LIMIT_RPC_MISSING;
  }
  return ZOE_ERROR_CODES.ERR_DB_TOOL_RPC_FAILED;
}

/**
 * Startup parity health check (cached 60 seconds).
 * Calls read-only `staff_assistant_health` RPC and returns `"zoe_database_behind"`
 * with any missing object names when the database is behind the code.
 */
export async function checkStaffAssistantHealth(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpcClient?: any,
  forceRefresh = false,
): Promise<StaffAssistantHealthStatus> {
  const nowMs = Date.now();
  if (!forceRefresh && cachedHealthStatus && nowMs < cachedHealthExpiresAtMs) {
    return cachedHealthStatus;
  }

  try {
    const client =
      rpcClient ??
      (typeof Deno !== "undefined" && Deno.env?.get("SUPABASE_URL") ? admin() : null);
    if (!client || typeof client.rpc !== "function") {
      return {
        ok: true,
        status: "ok",
        missingObjects: [],
        missingFunctions: [],
        missingTables: [],
        missingColumns: [],
        missingViews: [],
        checkedAtMs: nowMs,
      };
    }

    const { data, error } = await client.rpc("staff_assistant_health");
    if (error) {
      const behindStatus: StaffAssistantHealthStatus = {
        ok: false,
        status: "zoe_database_behind",
        missingObjects: ["function:staff_assistant_health"],
        missingFunctions: ["staff_assistant_health"],
        missingTables: [],
        missingColumns: [],
        missingViews: [],
        checkedAtMs: nowMs,
      };
      cachedHealthStatus = behindStatus;
      cachedHealthExpiresAtMs = nowMs + HEALTH_CACHE_TTL_MS;
      return behindStatus;
    }

    const payload = (data ?? {}) as Record<string, unknown>;
    const missingFunctions = Array.isArray(payload.missing_functions)
      ? payload.missing_functions.map((x) => String(x))
      : [];
    const missingTables = Array.isArray(payload.missing_tables)
      ? payload.missing_tables.map((x) => String(x))
      : [];
    const missingColumns = Array.isArray(payload.missing_columns)
      ? payload.missing_columns.map((x) => String(x))
      : [];
    const missingViews = Array.isArray(payload.missing_views)
      ? payload.missing_views.map((x) => String(x))
      : [];
    const missingObjects = Array.isArray(payload.missing_objects)
      ? payload.missing_objects.map((x) => String(x))
      : [
          ...missingTables.map((t) => `table:${t}`),
          ...missingColumns.map((c) => `column:${c}`),
          ...missingViews.map((v) => `view:${v}`),
          ...missingFunctions.map((f) => `function:${f}`),
        ];

    const isBehind =
      payload.status === "zoe_database_behind" ||
      payload.ok === false ||
      missingObjects.length > 0;

    const statusObj: StaffAssistantHealthStatus = {
      ok: !isBehind,
      status: isBehind ? "zoe_database_behind" : "ok",
      missingObjects,
      missingFunctions,
      missingTables,
      missingColumns,
      missingViews,
      checkedAtMs: nowMs,
    };
    cachedHealthStatus = statusObj;
    cachedHealthExpiresAtMs = nowMs + HEALTH_CACHE_TTL_MS;
    return statusObj;
  } catch {
    const fallbackStatus: StaffAssistantHealthStatus = {
      ok: false,
      status: "zoe_database_behind",
      missingObjects: ["function:staff_assistant_health"],
      missingFunctions: ["staff_assistant_health"],
      missingTables: [],
      missingColumns: [],
      missingViews: [],
      checkedAtMs: nowMs,
    };
    cachedHealthStatus = fallbackStatus;
    cachedHealthExpiresAtMs = nowMs + HEALTH_CACHE_TTL_MS;
    return fallbackStatus;
  }
}

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
  modelFast: string;
  modelDeep: string;
  temperature: number;
  maxTokens: number;
  maxDeepModelRounds: number;
  maxDeepToolCalls: number;
  maxCostUsdPerQuestion: number;
  webResearchEnabled: boolean;
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

export const DEFAULT_STAFF_ASSISTANT_CONFIG: StaffAssistantConfig = {
  enabled: true,
  maxQuestionsPerDay: DEFAULT_MAX_QUESTIONS_PER_DAY,
  maxEmailsPerDay: 30,
  maxModelRounds: 4,
  maxToolCalls: 6,
  historyDays: 90,
  modelFast: DEFAULT_ZOE_MODEL_FAST,
  modelDeep: DEFAULT_ZOE_MODEL_DEEP,
  temperature: DEFAULT_CHAT_TEMPERATURE,
  maxTokens: DEFAULT_CHAT_MAX_TOKENS,
  maxDeepModelRounds: MAX_DEEP_MODEL_ROUNDS,
  maxDeepToolCalls: MAX_DEEP_TOOL_CALLS,
  maxCostUsdPerQuestion: DEFAULT_MAX_COST_USD_PER_QUESTION,
  webResearchEnabled: false,
};

export async function loadStaffAssistantConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpcClient?: any,
  onDegraded?: (errorCode: ZoeErrorCode, errorDetail: string) => void,
): Promise<StaffAssistantConfig> {
  if (!rpcClient && (typeof Deno === "undefined" || !Deno.env?.get("SUPABASE_URL"))) {
    return { ...DEFAULT_STAFF_ASSISTANT_CONFIG };
  }
  try {
    const db =
      rpcClient ??
      (typeof Deno !== "undefined" && Deno.env?.get("SUPABASE_URL") ? admin() : null);
    if (!db) {
      return { ...DEFAULT_STAFF_ASSISTANT_CONFIG };
    }

    let rowData: Record<string, unknown> | null = null;
    if (typeof db.rpc === "function") {
      const rpcRes = await db.rpc("staff_assistant_get_config");
      if (rpcRes?.error) {
        onDegraded?.(
          ZOE_ERROR_CODES.ERR_DB_CONFIG_MISSING,
          `staff_assistant_get_config: ${rpcRes.error.message || rpcRes.error.code || "missing"}`,
        );
      } else if (rpcRes?.data && typeof rpcRes.data === "object" && !Array.isArray(rpcRes.data)) {
        rowData = rpcRes.data as Record<string, unknown>;
      }
    }

    if (!rowData && typeof db.from === "function") {
      const fullRes = await db
        .from("staff_assistant_config")
        .select(
          "enabled, max_questions_per_day, max_emails_per_day, max_model_rounds, max_tool_calls, history_days, model_fast, model_deep, temperature, max_tokens, max_deep_model_rounds, max_deep_tool_calls, max_cost_usd_per_question, web_research_enabled",
        )
        .eq("id", true)
        .maybeSingle();

      if (fullRes?.error) {
        onDegraded?.(
          ZOE_ERROR_CODES.ERR_DB_CONFIG_MISSING,
          `staff_assistant_config columns: ${fullRes.error.message || fullRes.error.code || "missing_columns"}`,
        );
        const minimalRes = await db
          .from("staff_assistant_config")
          .select("enabled, max_questions_per_day, max_emails_per_day, history_days")
          .eq("id", true)
          .maybeSingle();
        if (minimalRes?.data && typeof minimalRes.data === "object") {
          rowData = minimalRes.data as Record<string, unknown>;
        }
      } else if (fullRes?.data && typeof fullRes.data === "object") {
        rowData = fullRes.data as Record<string, unknown>;
      }
    }

    const row = (rowData ?? {}) as Record<string, unknown>;
    return {
      enabled: typeof row.enabled === "boolean" ? row.enabled : DEFAULT_STAFF_ASSISTANT_CONFIG.enabled,
      maxQuestionsPerDay:
        typeof row.max_questions_per_day === "number"
          ? row.max_questions_per_day
          : DEFAULT_MAX_QUESTIONS_PER_DAY,
      maxEmailsPerDay:
        typeof row.max_emails_per_day === "number"
          ? row.max_emails_per_day
          : DEFAULT_STAFF_ASSISTANT_CONFIG.maxEmailsPerDay,
      maxModelRounds:
        typeof row.max_model_rounds === "number"
          ? row.max_model_rounds
          : DEFAULT_STAFF_ASSISTANT_CONFIG.maxModelRounds,
      maxToolCalls:
        typeof row.max_tool_calls === "number"
          ? row.max_tool_calls
          : DEFAULT_STAFF_ASSISTANT_CONFIG.maxToolCalls,
      historyDays:
        typeof row.history_days === "number"
          ? row.history_days
          : DEFAULT_STAFF_ASSISTANT_CONFIG.historyDays,
      modelFast:
        typeof row.model_fast === "string" && row.model_fast.trim()
          ? row.model_fast.trim()
          : DEFAULT_ZOE_MODEL_FAST,
      modelDeep:
        typeof row.model_deep === "string" && row.model_deep.trim()
          ? row.model_deep.trim()
          : DEFAULT_ZOE_MODEL_DEEP,
      temperature:
        typeof row.temperature === "number" || typeof row.temperature === "string"
          ? Number(row.temperature)
          : DEFAULT_CHAT_TEMPERATURE,
      maxTokens: typeof row.max_tokens === "number" ? row.max_tokens : DEFAULT_CHAT_MAX_TOKENS,
      maxDeepModelRounds:
        typeof row.max_deep_model_rounds === "number"
          ? row.max_deep_model_rounds
          : MAX_DEEP_MODEL_ROUNDS,
      maxDeepToolCalls:
        typeof row.max_deep_tool_calls === "number" ? row.max_deep_tool_calls : MAX_DEEP_TOOL_CALLS,
      maxCostUsdPerQuestion:
        typeof row.max_cost_usd_per_question === "number" ||
        typeof row.max_cost_usd_per_question === "string"
          ? Number(row.max_cost_usd_per_question)
          : DEFAULT_MAX_COST_USD_PER_QUESTION,
      webResearchEnabled: row.web_research_enabled === true,
    };
  } catch (err) {
    onDegraded?.(
      ZOE_ERROR_CODES.ERR_DB_CONFIG_MISSING,
      err instanceof Error ? err.message : String(err),
    );
    return { ...DEFAULT_STAFF_ASSISTANT_CONFIG };
  }
}

export type BudgetCheckResult =
  | {
      allowed: true;
      remainingToday: number;
      maxQuestionsPerDay: number;
      maxModelRounds: number;
      maxToolCalls: number;
      modelConfig?: ZoeModelTierConfig;
      webResearchEnabled?: boolean;
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
export async function checkQuestionBudget(
  userId: string,
  onDegraded?: (errorCode: ZoeErrorCode, errorDetail: string) => void,
): Promise<BudgetCheckResult> {
  const cfg = await loadStaffAssistantConfig(undefined, onDegraded);
  const modelConfig: ZoeModelTierConfig = {
    modelFast: cfg.modelFast,
    modelDeep: cfg.modelDeep,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    maxCostUsdPerQuestion: cfg.maxCostUsdPerQuestion,
    maxFastModelRounds: cfg.maxModelRounds,
    maxFastToolCalls: cfg.maxToolCalls,
    maxDeepModelRounds: cfg.maxDeepModelRounds,
    maxDeepToolCalls: cfg.maxDeepToolCalls,
  };

  try {
    const db = admin();
    const { data: atomicRes, error: atomicErr } = await db.rpc(
      "staff_assistant_check_question_rate_limit",
      { p_user_id: userId },
    );

    if (!atomicErr && atomicRes && typeof atomicRes === "object") {
      const r = atomicRes as Record<string, unknown>;
      const limitToday =
        typeof r.limit_today === "number" ? r.limit_today : cfg.maxQuestionsPerDay;
      const usedToday = typeof r.used_today === "number" ? r.used_today : 0;
      const maxModelRounds =
        typeof r.max_model_rounds === "number" ? r.max_model_rounds : cfg.maxModelRounds;
      const maxToolCalls =
        typeof r.max_tool_calls === "number" ? r.max_tool_calls : cfg.maxToolCalls;
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
        modelConfig,
        webResearchEnabled: cfg.webResearchEnabled,
      };
    }

    if (atomicErr) {
      onDegraded?.(
        ZOE_ERROR_CODES.ERR_DB_RATE_LIMIT_RPC_MISSING,
        `staff_assistant_check_question_rate_limit: ${atomicErr.message || atomicErr.code || "missing"}`,
      );
    }

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
      modelConfig,
      webResearchEnabled: cfg.webResearchEnabled,
    };
  } catch (err) {
    onDegraded?.(
      ZOE_ERROR_CODES.ERR_DB_RATE_LIMIT_RPC_MISSING,
      err instanceof Error ? err.message : String(err),
    );
    return {
      allowed: true,
      remainingToday: cfg.maxQuestionsPerDay - 1,
      maxQuestionsPerDay: cfg.maxQuestionsPerDay,
      maxModelRounds: cfg.maxModelRounds,
      maxToolCalls: cfg.maxToolCalls,
      modelConfig,
      webResearchEnabled: cfg.webResearchEnabled,
    };
  }
}


export async function getOrCreateConversation(
  userId: string,
  conversationId: string | undefined,
  meta: SessionMeta,
  onDegraded?: (errorCode: ZoeErrorCode, errorDetail: string) => void,
): Promise<{
  id: string;
  status: string;
  memory?: ConversationMemorySummary;
  rollingSummary?: string;
}> {
  try {
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
        .select("id, status, conversation_summary, rolling_summary")
        .eq("id", conversationId)
        .eq("user_id", userId)
        .maybeSingle();
      if (selErr) {
        onDegraded?.(
          ZOE_ERROR_CODES.ERR_DB_CONVERSATION_SCHEMA_BEHIND,
          `staff_assistant_conversations select: ${selErr.message || selErr.code || "missing_columns"}`,
        );
        const fallback = await db
          .from("staff_assistant_conversations")
          .select("id, status, conversation_summary")
          .eq("id", conversationId)
          .eq("user_id", userId)
          .maybeSingle();
        if (fallback.error) {
          const minimal = await db
            .from("staff_assistant_conversations")
            .select("id, status")
            .eq("id", conversationId)
            .eq("user_id", userId)
            .maybeSingle();
          data = minimal.data
            ? { ...minimal.data, conversation_summary: null, rolling_summary: "" }
            : null;
        } else {
          data = fallback.data ? { ...fallback.data, rolling_summary: "" } : null;
        }
      }
      if (data) {
        await db.from("staff_assistant_conversations").update(sessionPatch).eq("id", data.id);
        const rec = data as Record<string, unknown>;
        return {
          id: data.id,
          status: data.status,
          memory: parseConversationMemory(rec.conversation_summary ?? null),
          rollingSummary: typeof rec.rolling_summary === "string" ? rec.rolling_summary : "",
        };
      }
    }

    let { data, error } = await db
      .from("staff_assistant_conversations")
      .insert({ user_id: userId, persona: "staff", ...sessionPatch })
      .select("id, status, conversation_summary, rolling_summary")
      .single();
    if (error) {
      onDegraded?.(
        ZOE_ERROR_CODES.ERR_DB_CONVERSATION_SCHEMA_BEHIND,
        `staff_assistant_conversations insert: ${error.message || error.code || "missing_columns"}`,
      );
      const fallback = await db
        .from("staff_assistant_conversations")
        .insert({ user_id: userId, persona: "staff", ...sessionPatch })
        .select("id, status")
        .single();
      data = fallback.data
        ? { ...fallback.data, conversation_summary: null, rolling_summary: "" }
        : null;
      error = fallback.error;
    }
    if (error || !data) {
      onDegraded?.(
        ZOE_ERROR_CODES.ERR_DB_CONVERSATION_SCHEMA_BEHIND,
        `could not create conversation: ${error?.message || "unknown"}`,
      );
      return {
        id: conversationId ?? crypto.randomUUID(),
        status: "open",
        rollingSummary: "",
      };
    }
    const rec = data as Record<string, unknown>;
    return {
      id: data.id,
      status: data.status,
      memory: parseConversationMemory(rec.conversation_summary ?? null),
      rollingSummary: typeof rec.rolling_summary === "string" ? rec.rolling_summary : "",
    };
  } catch (err) {
    onDegraded?.(
      ZOE_ERROR_CODES.ERR_DB_CONVERSATION_SCHEMA_BEHIND,
      err instanceof Error ? err.message : String(err),
    );
    return {
      id: conversationId ?? crypto.randomUUID(),
      status: "open",
      rollingSummary: "",
    };
  }
}


export async function loadRecentTurns(
  userId: string,
  conversationId: string,
  onDegraded?: (errorCode: ZoeErrorCode, errorDetail: string) => void,
): Promise<ChatMessage[]> {
  try {
    const db = admin();
    let { data, error } = await db
      .from("staff_assistant_messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .eq("user_id", userId)
      .eq("hidden_by_user", false)
      .order("created_at", { ascending: false })
      .limit(MAX_LOADED_HISTORY_MESSAGES);

    if (error) {
      onDegraded?.(
        ZOE_ERROR_CODES.ERR_DB_HISTORY_READ_FAILED,
        `staff_assistant_messages recent turns: ${error.message || error.code || "missing_columns"}`,
      );
      const fallback = await db
        .from("staff_assistant_messages")
        .select("role, content")
        .eq("conversation_id", conversationId)
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(MAX_LOADED_HISTORY_MESSAGES);
      data = fallback.data;
    }

    return (data ?? [])
      .reverse()
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  } catch (err) {
    onDegraded?.(
      ZOE_ERROR_CODES.ERR_DB_HISTORY_READ_FAILED,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

export async function loadLatestReportPayload(
  userId: string,
  conversationId: string,
): Promise<Record<string, unknown> | null> {
  try {
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
  } catch {
    return null;
  }
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
    rollingSummary?: string | null;
    model?: string;
    latencyMs?: number;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbOverride?: any,
): Promise<{ userMessageId: string | null; assistantMessageId: string | null }> {
  try {
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
        ...(typeof args.rollingSummary === "string" && args.rollingSummary.trim()
          ? { rolling_summary: args.rollingSummary.trim().slice(0, 2000) }
          : {}),
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
  } catch (err) {
    console.warn("[staff-assistant] recordTurn failed:", err);
    return { userMessageId: null, assistantMessageId: null };
  }
}

export async function recordUnanswered(
  args: {
    conversationId: string;
    messageId: string | null;
    userId: string;
    callerRoles: readonly string[];
    questionText: string;
    reason: UnansweredReason;
    errorCode?: ZoeErrorCode | null;
    errorDetail?: string | null;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbOverride?: any,
): Promise<void> {
  if (!dbOverride && (typeof Deno === "undefined" || !Deno.env?.get("SUPABASE_URL"))) {
    return;
  }
  try {
    const db = dbOverride ?? admin();
    const cleanCode =
      typeof args.errorCode === "string" && args.errorCode.trim()
        ? args.errorCode.trim().slice(0, 80)
        : null;
    const cleanDetail =
      typeof args.errorDetail === "string" && args.errorDetail.trim()
        ? args.errorDetail.trim().slice(0, 1000)
        : null;

    const baseRow = {
      conversation_id: args.conversationId || null,
      message_id: args.messageId || null,
      user_id: args.userId,
      caller_roles: [...args.callerRoles],
      question_text: (args.questionText || "unanswered").slice(0, 2000),
      reason: args.reason,
      status: "open",
    };

    const { error } = await db.from("staff_assistant_unanswered").insert({
      ...baseRow,
      ...(cleanCode ? { error_code: cleanCode } : {}),
      ...(cleanDetail ? { error_detail: cleanDetail } : {}),
    });

    if (error && (cleanCode || cleanDetail)) {
      // Fallback if error_code / error_detail columns are not yet deployed live
      await db.from("staff_assistant_unanswered").insert({
        ...baseRow,
        review_note: `${cleanCode ? `[${cleanCode}] ` : ""}${cleanDetail ?? ""}`
          .trim()
          .slice(0, 500) || null,
      });
    }
  } catch (err) {
    console.warn("[staff-assistant] recordUnanswered failed:", err);
  }
}

export async function saveFeedback(args: {
  conversationId: string;
  messageId: string;
  userId: string;
  rating: "up" | "down";
  reportKind?: "rating" | "problem_report";
  comment?: string;
}): Promise<{ ok: boolean }> {
  const db = admin();
  const { data: msg } = await db
    .from("staff_assistant_messages")
    .select("id, created_at")
    .eq("id", args.messageId)
    .eq("conversation_id", args.conversationId)
    .eq("user_id", args.userId)
    .maybeSingle();

  if (!msg) return { ok: false };

  const reportKind = args.reportKind === "problem_report" ? "problem_report" : "rating";
  let { error } = await db.from("staff_assistant_feedback").upsert(
    {
      conversation_id: args.conversationId,
      message_id: args.messageId,
      user_id: args.userId,
      rating: args.rating,
      report_kind: reportKind,
      comment: args.comment ? args.comment.slice(0, 1000) : null,
    },
    { onConflict: "message_id,user_id" },
  );

  if (error) {
    const fallback = await db.from("staff_assistant_feedback").upsert(
      {
        conversation_id: args.conversationId,
        message_id: args.messageId,
        user_id: args.userId,
        rating: args.rating,
        comment: args.comment ? args.comment.slice(0, 1000) : null,
      },
      { onConflict: "message_id,user_id" },
    );
    error = fallback.error;
  }

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
export async function clearUserHistory(
  userId: string,
  conversationId?: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpcClient?: any,
  onDegraded?: (errorCode: ZoeErrorCode, errorDetail: string) => void,
): Promise<void> {
  const nowIso = new Date().toISOString();
  try {
    const client =
      rpcClient ??
      (typeof Deno !== "undefined" && Deno.env?.get("SUPABASE_URL") ? admin() : null);

    if (client && typeof client.rpc === "function") {
      const rpcRes = await client.rpc("staff_assistant_hide_my_history", {
        p_user_id: userId,
        p_conversation_id: conversationId ?? null,
      });
      if (rpcRes?.error) {
        onDegraded?.(
          ZOE_ERROR_CODES.ERR_DB_HIDE_HISTORY_MISSING,
          `staff_assistant_hide_my_history: ${rpcRes.error.message || rpcRes.error.code || "missing"}`,
        );
      }
    }

    if (typeof Deno === "undefined" || !Deno.env?.get("SUPABASE_URL")) {
      return;
    }

    const db = admin();
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
  } catch (err) {
    onDegraded?.(
      ZOE_ERROR_CODES.ERR_DB_HIDE_HISTORY_MISSING,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Lists up to 20 active "Zoe notes" (`staff_assistant_notes`) for the signed-in staff member.
 */
export async function listUserNotes(
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbOverride?: any,
  onDegraded?: (errorCode: ZoeErrorCode, errorDetail: string) => void,
): Promise<ZoeNoteRecord[]> {
  if (!dbOverride && (typeof Deno === "undefined" || !Deno.env?.get("SUPABASE_URL"))) {
    return [];
  }
  try {
    const db = dbOverride ?? admin();
    const { data, error } = await db
      .from("staff_assistant_notes")
      .select("id, note_text, created_at")
      .eq("user_id", userId)
      .eq("is_deleted", false)
      .order("created_at", { ascending: false })
      .limit(MAX_ZOE_NOTES_PER_USER);

    if (error || !Array.isArray(data)) {
      if (error) {
        onDegraded?.(
          ZOE_ERROR_CODES.ERR_DB_NOTES_MISSING,
          `staff_assistant_notes: ${error.message || error.code || "missing"}`,
        );
      }
      return [];
    }

    return data
      .filter((r) => r && typeof r.note_text === "string" && validateZoeNoteText(r.note_text).ok)
      .map((r) => ({
        id: String(r.id),
        note_text: String(r.note_text).trim(),
        created_at: typeof r.created_at === "string" ? r.created_at : new Date().toISOString(),
      }));
  } catch (err) {
    onDegraded?.(
      ZOE_ERROR_CODES.ERR_DB_NOTES_MISSING,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * Adds a short preference note to `staff_assistant_notes` for the signed-in staff member,
 * enforcing:
 *   1. Deterministic guard (`validateZoeNoteText`) — blocks business figures and PII.
 *   2. Maximum of 20 active notes per person (`MAX_ZOE_NOTES_PER_USER`).
 */
export async function addUserNote(
  userId: string,
  noteText: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbOverride?: any,
): Promise<
  | { ok: true; note: ZoeNoteRecord; notes: ZoeNoteRecord[] }
  | { ok: false; reason: string; error: string }
> {
  const check = validateZoeNoteText(noteText);
  if (!check.ok) {
    return {
      ok: false,
      reason: check.reason,
      error: MSG.noteRejectedPiiOrFigures,
    };
  }

  const db = dbOverride ?? admin();
  const existing = await listUserNotes(userId, db);
  if (existing.length >= MAX_ZOE_NOTES_PER_USER) {
    return {
      ok: false,
      reason: "limit_reached",
      error: MSG.noteLimitReached,
    };
  }

  const duplicate = existing.find(
    (n) => n.note_text.toLowerCase() === check.cleaned.toLowerCase(),
  );
  if (duplicate) {
    return { ok: true, note: duplicate, notes: existing };
  }

  const nowIso = new Date().toISOString();
  const { data: inserted, error } = await db
    .from("staff_assistant_notes")
    .insert({
      user_id: userId,
      note_text: check.cleaned,
      is_deleted: false,
      updated_at: nowIso,
    })
    .select("id, note_text, created_at")
    .single();

  if (error || !inserted) {
    return {
      ok: false,
      reason: "db_error",
      error: "Could not save Zoe note right now.",
    };
  }

  const newNote: ZoeNoteRecord = {
    id: String(inserted.id),
    note_text: String(inserted.note_text),
    created_at: typeof inserted.created_at === "string" ? inserted.created_at : nowIso,
  };
  return {
    ok: true,
    note: newNote,
    notes: [newNote, ...existing].slice(0, MAX_ZOE_NOTES_PER_USER),
  };
}

/**
 * Soft-deletes a user's Zoe note (`is_deleted = true`) so `.delete()` is never called in `store.ts`.
 */
export async function deleteUserNote(
  userId: string,
  noteId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbOverride?: any,
): Promise<{ ok: boolean; notes: ZoeNoteRecord[] }> {
  const db = dbOverride ?? admin();
  const nowIso = new Date().toISOString();
  await db
    .from("staff_assistant_notes")
    .update({ is_deleted: true, updated_at: nowIso })
    .eq("id", noteId)
    .eq("user_id", userId);

  const notes = await listUserNotes(userId, db);
  return { ok: true, notes };
}

/**
 * Append-only audit logger for Prompt 3 (`public.staff_assistant_queries`).
 * Records caller, question, SQL, executed SQL, role areas, row count, and duration_ms.
 */
export async function logAnalystQuery(
  args: {
    userId: string;
    question: string;
    sqlText: string;
    executedSql: string;
    roleAreas: readonly string[];
    rowCount: number;
    truncated: boolean;
    durationMs: number;
    status: "ok" | "refused" | "error";
    errorMessage?: string | null;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbOverride?: any,
): Promise<void> {
  if (!dbOverride && (typeof Deno === "undefined" || !Deno.env?.get("SUPABASE_URL"))) {
    return;
  }
  try {
    const db = dbOverride ?? admin();
    await db.from("staff_assistant_queries").insert({
      user_id: args.userId,
      question: (args.question ?? "").trim().slice(0, 1000),
      sql_text: (args.sqlText ?? "").trim().slice(0, 4000),
      executed_sql: (args.executedSql ?? args.sqlText ?? "").trim().slice(0, 4500),
      role_areas: [...args.roleAreas],
      row_count: Math.min(Math.max(Math.round(args.rowCount || 0), 0), 500),
      truncated: Boolean(args.truncated),
      duration_ms: Math.max(Math.round(args.durationMs || 0), 0),
      status: args.status,
      error_message: args.errorMessage ? args.errorMessage.slice(0, 500) : null,
    });
  } catch (err) {
    console.warn("[staff-assistant] logAnalystQuery failed:", err);
  }
}


