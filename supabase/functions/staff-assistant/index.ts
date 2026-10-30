import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireStaffAal2 } from "../_shared/staffMfa.ts";
import {
   buildIdeaDraft,
  buildReminderDraft,
  buildReportScheduleDraft,
  buildStaffNotificationDraft,
} from "./actionDrafts.ts";
import {
  canCallerAccessZoeRoArea,
  ensureAdHocCertificationNotice,
  validateAnalystSqlQuery,
  type ZoeRoRoleArea as ZoeRoArea,
} from "./analyst.ts";
import { ComputeArgsSchema, runSafeCompute } from "./calculator.ts";
import {
  buildResearchModePlan,
  CONSULTANT_FORBIDDEN_TOOLS,
  executeConsultantReadWebPage,
  executeConsultantWebSearch,
  filterToolsForConsultantMode,
  isConsultantQuestion,
  MAX_RESEARCH_SOURCES_PER_QUESTION,
  MAX_WEB_SEARCHES_PER_QUESTION,
  ReadWebPageArgsSchema,
  SearchWebArgsSchema,
  WEB_RESEARCH_TOOL_NAMES,
} from "./consultant.ts";
import { formatPeriodLabel, kampalaToday } from "./dates.ts";
import {
  buildReportEmailDraft,
  extractRecipientQuery,
  isEmailFromToolData,
  normalizeStaffRecipients,
} from "./emailDraft.ts";
import {
  checkAnswer,
  checkDraftCardText,
  checkStreamedParagraph,
  isDirectPromptInjection,
  isWriteMutationIntent,
  UNVERIFIED_PARAGRAPH_REPLACEMENT,
  verifyAndSanitizeStreamedParagraphs,
} from "./guards.ts";
import {
  ensurePolicyDisclaimerWhenNeeded,
  isConversationalPromptAllowedWithoutTool,
  ManualHelpArgsSchema,
  searchStaffManualHelp,
} from "./manualHelp.ts";
import {
  appendMemoryEntries,
  buildFollowUpSuggestions,
  buildMemoryEntryFromToolResult,
  ConversationMemorySummary,
  extractChartFromReportPayload,
  formatConversationMemoryForPrompt,
  formatZoeNotesForPrompt,
  MemoryToolEntry,
  parseConversationMemory,
  PROMPT_ACTIVE_TURNS,
  splitTurnsForPromptMemory,
  statusLineForTool,
  synthesizePartialStepLimitReply,
  ZoeChartPayload,
  ZoeNoteRecord,
} from "./memory.ts";
import { formatWriteMutationRefusal, MSG } from "./messages.ts";
import { buildMorningBriefForCaller } from "./morningBrief.ts";
import {
  AiGatewayError,
  chatCompletion,
  chatCompletionStream,
  ChatMessage,
  ChatUsage,
  classifyText,
  MAX_DEEP_MODEL_ROUNDS,
  MAX_DEEP_TOOL_CALLS,
  OpenAiTool,
  selectModelTier,
} from "./openai.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { RequestSchema } from "./schemas.ts";
import {
  addUserNote,
  BudgetCheckResult,
  checkQuestionBudget,
  checkStaffAssistantHealth,
  clearUserHistory,
  ConversationListItem,
  createNewConversation,
  DEFAULT_STAFF_ASSISTANT_CONFIG,
  deleteUserNote,
  getAdminClientForMfa,
  getOrCreateConversation,
  listUserConversations,
  listUserNotes,
  loadConversationHistory,
  loadLatestReportPayload,
  loadRecentTurns,
  logAnalystQuery,
  mapMissingFunctionToErrorCode,
  recordTurn,
  recordUnanswered,
  renameUserConversation,
  saveFeedback,
  SessionMeta,
  TurnOutcome,
  UnansweredReason,
  ZOE_ERROR_CODES,
  ZoeErrorCode,
} from "./store.ts";

import {
  canUseTool,
  ClarificationArgsSchema,
  describeToolsForRoles,
  DraftIdeaArgsSchema,
  DraftReminderArgsSchema,
  DraftReportEmailArgsSchema,
  DraftReportScheduleArgsSchema,
  DraftStaffNotificationArgsSchema,
  findTool,
  isHistoryMessageAllowedForRoles,
  openAiToolsForRoles,
} from "./tools.ts";
import { prepareToolOutputForModel } from "./toolOutput.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MAX_MODEL_ROUNDS = 4;
const MAX_CALLS_PER_ROUND = 4;
const MAX_TOOL_CALLS = 6;
const MAX_TOOL_RESULT_CHARS = 16_000;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function splitTokensForStream(text: string): string[] {
  const parts = text.match(/\S+\s*|\n+/g);
  return parts && parts.length > 0 ? parts : [text];
}

interface LiveSseWriter {
  emit(event: string, data: unknown): void;
  close(): void;
  readonly response: Response;
}

function createLiveSseWriter(): LiveSseWriter {
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
    cancel() {
      closed = true;
    },
  });

  return {
    emit(event: string, data: unknown) {
      if (closed || !controllerRef) return;
      try {
        controllerRef.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      } catch {
        closed = true;
      }
    },
    close() {
      if (closed || !controllerRef) return;
      closed = true;
      try {
        controllerRef.close();
      } catch {
        /* ignore already closed */
      }
    },
    response: new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }),
  };
}

export interface StaffAssistantAiClient {
  classifyText?: (systemPrompt: string, userMessage: string) => Promise<string>;
  chatCompletion: (opts: {
    messages: ChatMessage[];
    tools?: OpenAiTool[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<{ message: ChatMessage; model: string; usage?: ChatUsage }>;
  chatCompletionStream?: (opts: {
    messages: ChatMessage[];
    tools?: OpenAiTool[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    onTokenDelta?: (delta: string, accumulated: string) => void;
  }) => Promise<{ message: ChatMessage; model: string; usage?: ChatUsage }>;
}

export interface StaffAssistantStoreDeps {
  checkQuestionBudget: (userId: string) => Promise<BudgetCheckResult>;
  getOrCreateConversation: (
    userId: string,
    conversationId: string | undefined,
    meta: SessionMeta,
  ) => Promise<{
    id: string;
    status: string;
    memory?: ConversationMemorySummary;
    rollingSummary?: string;
  }>;
  loadRecentTurns: (userId: string, conversationId: string) => Promise<ChatMessage[]>;
  loadLatestReportPayload: (
    userId: string,
    conversationId: string,
  ) => Promise<Record<string, unknown> | null>;
  recordTurn: typeof recordTurn;
  recordUnanswered: typeof recordUnanswered;
  saveFeedback: typeof saveFeedback;
  loadConversationHistory: typeof loadConversationHistory;
  clearUserHistory: typeof clearUserHistory;
  listUserConversations?: (userId: string, limit?: number) => Promise<ConversationListItem[]>;
  createNewConversation?: (
    userId: string,
    meta: SessionMeta,
    title?: string,
  ) => Promise<ConversationListItem>;
  renameUserConversation?: (
    userId: string,
    conversationId: string,
    title: string,
  ) => Promise<{ ok: boolean; title: string }>;
  listUserNotes?: (userId: string) => Promise<ZoeNoteRecord[]>;
  addUserNote?: (
    userId: string,
    noteText: string,
  ) => Promise<
    | { ok: true; note: ZoeNoteRecord; notes: ZoeNoteRecord[] }
    | { ok: false; reason: string; error: string }
  >;
  deleteUserNote?: (
    userId: string,
    noteId: string,
  ) => Promise<{ ok: boolean; notes: ZoeNoteRecord[] }>;
  logAnalystQuery?: typeof logAnalystQuery;
}

export interface StaffAssistantHandlerDeps {
  userClient?: SupabaseClient;
  aiClient?: StaffAssistantAiClient;
  store?: Partial<StaffAssistantStoreDeps>;
  checkMfaAal2?: (token: string, userId: string) => Promise<{ ok: boolean }>;
}

const DEFAULT_AI_CLIENT: StaffAssistantAiClient = {
  classifyText,
  chatCompletion,
  chatCompletionStream,
};

const DEFAULT_STORE_DEPS: StaffAssistantStoreDeps = {
  checkQuestionBudget,
  getOrCreateConversation,
  loadRecentTurns,
  loadLatestReportPayload,
  recordTurn,
  recordUnanswered,
  saveFeedback,
  loadConversationHistory,
  clearUserHistory,
  listUserConversations,
  createNewConversation,
  renameUserConversation,
  listUserNotes,
  addUserNote,
  deleteUserNote,
  logAnalystQuery,
};

const BUILTIN_GLOSSARY_FALLBACK_ROWS = [
  {
    term_key: "rent_plan",
    term_title: "Rent Plan",
    category: "terminology",
    plain_definition:
      "Welile's tenant rent support arrangement. Always say 'Rent Plan' (never 'loan'), 'Supporter' (never 'lender'), and 'Returns' (never 'ROI' or 'interest').",
    measurement_gotchas:
      "Active Rent Plans and repayment clocks are tracked via am_plan_clock and rent_requests.",
  },
  {
    term_key: "expected_vs_collected",
    term_title: "Expected vs Collected Rent",
    category: "collections",
    plain_definition:
      "Expected rent is the daily scheduled bill; collected rent is verified tenant repayments recorded over the period.",
    measurement_gotchas:
      "Distinguish capped on-schedule daily collections from uncapped total collections including arrears catch-up.",
  },
  {
    term_key: "treasury_cash_position",
    term_title: "Treasury Cash Position vs Agent Float",
    category: "treasury_ledger",
    plain_definition:
      "Treasury Cash Position (A1 + A5 via get_treasury_cash_position) is platform cash on hand and is distinct from Agent Float (A2).",
    measurement_gotchas:
      "Never mix user wallet withdrawable balances with platform treasury cash.",
  },
];

/**
 * Saves a draft server-side in `public.staff_assistant_drafts` (owner, kind, exact payload_hash,
 * 30-minute expiry, single-use `used_at`) using the caller's own JWT (`userClient`).
 * If `staff_assistant_save_draft` is missing live, logs `ERR_DB_SAVE_DRAFT_MISSING` and returns
 * a fallback draft UUID so the draft card still renders cleanly.
 */
async function saveServerDraft(
  userClient: SupabaseClient,
  kind: "email" | "reminder" | "notification" | "schedule" | "idea",
  payload: Record<string, unknown>,
  conversationId: string,
  onDegraded?: (code: ZoeErrorCode, detail: string) => Promise<void>,
): Promise<string | null> {
  try {
    const { data, error } = await userClient.rpc("staff_assistant_save_draft", {
      p_kind: kind,
      p_payload: payload,
      p_conversation_id: conversationId,
    });
    if (error) {
      await onDegraded?.(
        ZOE_ERROR_CODES.ERR_DB_SAVE_DRAFT_MISSING,
        `staff_assistant_save_draft: ${error.message}`,
      );
      return crypto.randomUUID();
    }
    if (!data || typeof data !== "object") {
      return crypto.randomUUID();
    }
    const rec = data as Record<string, unknown>;
    return typeof rec.draft_id === "string" && rec.draft_id.trim()
      ? rec.draft_id.trim()
      : crypto.randomUUID();
  } catch (err) {
    await onDegraded?.(
      ZOE_ERROR_CODES.ERR_DB_SAVE_DRAFT_MISSING,
      err instanceof Error ? err.message : "staff_assistant_save_draft failed",
    );
    return crypto.randomUUID();
  }
}

/**
 * Checks whether a recipient's own roles can read the given report RPC via
 * `public.staff_assistant_can_user_read_report(p_user_id, p_report_rpc)`.
 * If the database function is missing live, logs `ERR_DB_CAN_READ_REPORT_MISSING` and
 * falls back to `true` (because the caller already verified `canUseTool(reportToolDef, recipient_roles)`).
 */
async function checkRecipientCanReadReport(
  userClient: SupabaseClient,
  recipientUserId: string,
  reportRpc: string,
  onDegraded?: (code: ZoeErrorCode, detail: string) => Promise<void>,
): Promise<boolean> {
  try {
    const { data, error } = await userClient.rpc("staff_assistant_can_user_read_report", {
      p_user_id: recipientUserId,
      p_report_rpc: reportRpc,
    });
    if (error) {
      await onDegraded?.(
        ZOE_ERROR_CODES.ERR_DB_CAN_READ_REPORT_MISSING,
        `staff_assistant_can_user_read_report: ${error.message}`,
      );
      return true;
    }
    return data === true;
  } catch (err) {
    await onDegraded?.(
      ZOE_ERROR_CODES.ERR_DB_CAN_READ_REPORT_MISSING,
      err instanceof Error ? err.message : "staff_assistant_can_user_read_report failed",
    );
    return true;
  }
}

/**
 * Resolve the signed-in caller's enabled roles using ONLY the caller's own JWT (`userClient`).
 * Queries `user_roles` directly and falls back to `assistant_staff_my_profile` so role resolution
 * never touches the service role.
 */
async function resolveCallerRoles(userClient: SupabaseClient, userId: string): Promise<string[]> {
  const roles = new Set<string>();

  const { data: roleRows } = await userClient
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("enabled", true);

  for (const row of roleRows ?? []) {
    if (typeof row?.role === "string" && row.role.trim()) {
      roles.add(row.role.trim().toLowerCase());
    }
  }

  if (roles.size === 0) {
    const { data: profileData } = await userClient.rpc("assistant_staff_my_profile");
    const enabledRoles = (profileData as Record<string, unknown> | null)?.data as
      | Record<string, unknown>
      | undefined;
    const list = enabledRoles?.enabled_roles;
    if (Array.isArray(list)) {
      for (const r of list) {
        if (typeof r === "string" && r.trim()) roles.add(r.trim().toLowerCase());
      }
    }
  }

  return [...roles].sort();
}

/**
 * Real request handler for Zoe (`supabase/functions/staff-assistant`).
 * Accepts optional injected `aiClient`, `userClient`, `store`, and `checkMfaAal2` dependencies
 * so unit, integration, and live evaluation tests run against the exact production handler.
 */
export async function handleStaffAssistantRequest(
  req: Request,
  deps: StaffAssistantHandlerDeps = {},
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: MSG.invalidRequest });

  const startedAt = Date.now();
  const ai = deps.aiClient ?? DEFAULT_AI_CLIENT;
  const store: StaffAssistantStoreDeps = { ...DEFAULT_STORE_DEPS, ...(deps.store ?? {}) };

  // ---- 1. Authenticate caller from Authorization Bearer JWT only -----------------------------
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json(401, { error: MSG.unauthorized });
  }
  const token = authHeader.slice("Bearer ".length).trim();

  // This client carries the caller's own JWT. Every `assistant_staff_*` RPC is called on THIS
  // client so `auth.uid()` inside PostgreSQL is always the signed-in staff member.
  const userClient =
    deps.userClient ??
    createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

  const checkMfa =
    deps.checkMfaAal2 ??
    ((jwt: string, uid: string) => requireStaffAal2(getAdminClientForMfa(), jwt, uid));

  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) return json(401, { error: MSG.unauthorized });

  // ---- 2. Validate request body (strict: rejects user_id, role, history, system, etc.) -------
  const rawBody = await req.json().catch(() => null);
  const parsed = RequestSchema.safeParse(rawBody);
  if (!parsed.success) return json(400, { error: MSG.invalidRequest });
  const body = parsed.data;

  // ---- 3. Requirement (a): Refuse unless staff_assistant_has_access() is true ----------------
  const { data: hasAccess, error: accessErr } = await userClient.rpc("staff_assistant_has_access");
  if (body.action === "access") {
    if (accessErr || hasAccess !== true) {
      return json(200, { allowed: false, roles: [] });
    }
    const callerRoles = await resolveCallerRoles(userClient, user.id);
    return json(200, { allowed: true, roles: callerRoles });
  }

  if (accessErr || hasAccess !== true) {
    return json(403, { error: MSG.notStaff, outcome: "not_staff" });
  }

  // ---- 3b. Startup parity health check (cached 60s; force refresh for injected test clients) --
  const health = await checkStaffAssistantHealth(userClient, Boolean(deps.userClient));
  const degradedErrors: Array<{ errorCode: ZoeErrorCode; errorDetail: string }> = [];
  let activeConvId: string | null =
    "conversation_id" in body && typeof body.conversation_id === "string"
      ? body.conversation_id
      : null;
  let activeCallerRoles: string[] = [];
  const rawQuestionLabel =
    body.action === "message" ? body.message : `action:${body.action}`;

  const recordDegraded = async (
    errorCode: ZoeErrorCode,
    errorDetail: string,
    questionTextOverride?: string,
  ) => {
    if (!degradedErrors.some((d) => d.errorCode === errorCode)) {
      degradedErrors.push({ errorCode, errorDetail });
    }
    try {
      await store.recordUnanswered({
        conversationId: activeConvId,
        messageId: null,
        userId: user.id,
        callerRoles: activeCallerRoles.length > 0 ? activeCallerRoles : ["staff"],
        questionText: questionTextOverride || rawQuestionLabel,
        reason: "error",
        errorCode,
        errorDetail,
      });
    } catch {
      // Never fail a user request if logging to staff_assistant_unanswered fails
    }
  };

  if (health.status === "zoe_database_behind") {
    for (const missingFn of health.missingFunctions) {
      if (missingFn === "staff_assistant_health") continue;
      const mappedCode = mapMissingFunctionToErrorCode(missingFn);
      await recordDegraded(mappedCode, `Missing database function: ${missingFn}`);
    }
  }

  // ---- 4. Non-chat utility actions (history, conversations, new_conversation, rename, clear_history, feedback, morning_brief)
  if (body.action === "history") {
    const [callerRoles, history] = await Promise.all([
      resolveCallerRoles(userClient, user.id),
      store.loadConversationHistory(user.id, body.conversation_id, body.limit ?? 40).catch(
        async (err) => {
          await recordDegraded(
            ZOE_ERROR_CODES.ERR_DB_MEMORY_READ_FAILED,
            err instanceof Error ? err.message : "loadConversationHistory failed",
          );
          return { conversation_id: body.conversation_id ?? null, messages: [] };
        },
      ),
    ]);
    // Re-check the caller's current role before showing any historical answer or report_payload
    const roleFilteredMessages = history.messages.map((msg) => {
      if (!isHistoryMessageAllowedForRoles(msg, callerRoles)) {
        return {
          ...msg,
          content: MSG.historyRoleRestricted,
          report_payload: null,
        };
      }
      return msg;
    });
    return json(200, {
      conversation_id: history.conversation_id,
      messages: roleFilteredMessages,
    });
  }

  if (body.action === "conversations") {
    const list = store.listUserConversations
      ? await store.listUserConversations(user.id, body.limit ?? 25).catch(() => [])
      : [];
    return json(200, { ok: true, conversations: list });
  }

  if (body.action === "new_conversation") {
    const forwardedFor = req.headers.get("x-forwarded-for") ?? req.headers.get("cf-connecting-ip");
    const meta: SessionMeta = {
      ipAddress: forwardedFor ? forwardedFor.split(",")[0].trim() : null,
      userAgent: req.headers.get("user-agent"),
    };
    if (store.createNewConversation) {
      const created = await store.createNewConversation(user.id, meta, body.title);
      return json(200, { ok: true, conversation: created });
    }
    const conv = await store.getOrCreateConversation(user.id, undefined, meta);
    return json(200, {
      ok: true,
      conversation: {
        id: conv.id,
        title: body.title ?? "New chat",
        message_count: 0,
        last_active_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
    });
  }

  if (body.action === "rename_conversation") {
    if (store.renameUserConversation) {
      const res = await store.renameUserConversation(user.id, body.conversation_id, body.title);
      if (!res.ok) return json(404, { error: MSG.invalidRequest });
      return json(200, { ok: true, conversation_id: body.conversation_id, title: res.title });
    }
    return json(200, { ok: true, conversation_id: body.conversation_id, title: body.title });
  }

  if (body.action === "clear_history") {
    try {
      const { error: hideErr } = await userClient.rpc("staff_assistant_hide_my_history", {
        p_user_id: user.id,
        p_conversation_id: body.conversation_id ?? null,
      });
      if (hideErr) {
        await recordDegraded(
          ZOE_ERROR_CODES.ERR_DB_HIDE_HISTORY_MISSING,
          `staff_assistant_hide_my_history: ${hideErr.message}`,
        );
      }
    } catch (err) {
      await recordDegraded(
        ZOE_ERROR_CODES.ERR_DB_HIDE_HISTORY_MISSING,
        err instanceof Error ? err.message : "staff_assistant_hide_my_history failed",
      );
    }
    try {
      await store.clearUserHistory(user.id, body.conversation_id);
    } catch (err) {
      await recordDegraded(
        ZOE_ERROR_CODES.ERR_DB_HIDE_HISTORY_MISSING,
        err instanceof Error ? err.message : "clearUserHistory failed",
      );
    }
    return json(200, {
      ok: true,
      reply: MSG.historyCleared,
      degraded_error_codes: degradedErrors.map((d) => d.errorCode),
    });
  }

  if (body.action === "feedback") {
    const res = await store.saveFeedback({
      conversationId: body.conversation_id,
      messageId: body.message_id,
      userId: user.id,
      rating: body.rating,
      reportKind: body.report_kind,
      comment: body.comment,
    });
    if (!res.ok) return json(404, { error: MSG.invalidRequest });
    return json(200, { ok: true, reply: MSG.feedbackSaved });
  }

  if (body.action === "morning_brief") {
    const callerRoles = await resolveCallerRoles(userClient, user.id);
    activeCallerRoles = callerRoles;
    const brief = await buildMorningBriefForCaller({
      callerRoles,
      force: body.force,
      runTool: async (tool) => {
        if (!canUseTool(tool, callerRoles)) return null;
        if (tool.sensitive) {
          const mfaGate = await checkMfa(token, user.id);
          if (!mfaGate.ok) return null;
        }
        const parsedArgs = tool.schema.safeParse({});
        const rpcArgs = tool.toRpcArgs(parsedArgs.success ? parsedArgs.data : {});
        const { data, error } = await userClient.rpc(tool.rpc, rpcArgs);
        if (error || !data || typeof data !== "object" || Array.isArray(data)) {
          if (error && error.code !== "42501") {
            await recordDegraded(
              mapMissingFunctionToErrorCode(tool.rpc),
              `${tool.rpc}: ${error.message}`,
            );
          }
          return null;
        }
        return data as Record<string, unknown>;
      },
    });
    return json(200, { ok: true, morning_brief: brief });
  }

  // Prompt 2 item (5): Per-person "Zoe notes" (`staff_assistant_notes`, up to 20 preferences)
  if (body.action === "list_notes") {
    const notes = store.listUserNotes
      ? await store.listUserNotes(user.id).catch(async (err) => {
          await recordDegraded(
            ZOE_ERROR_CODES.ERR_DB_NOTES_UNAVAILABLE,
            err instanceof Error ? err.message : "listUserNotes failed",
          );
          return [];
        })
      : [];
    return json(200, { ok: true, notes });
  }

  if (body.action === "add_note") {
    if (!store.addUserNote) {
      return json(400, { ok: false, error: MSG.invalidRequest });
    }
    try {
      const res = await store.addUserNote(user.id, body.note_text);
      if (!res.ok) {
        return json(400, { ok: false, reason: res.reason, error: res.error });
      }
      return json(200, { ok: true, note: res.note, notes: res.notes });
    } catch (err) {
      await recordDegraded(
        ZOE_ERROR_CODES.ERR_DB_NOTES_UNAVAILABLE,
        err instanceof Error ? err.message : "addUserNote failed",
      );
      return json(200, {
        ok: false,
        degraded: true,
        error_code: ZOE_ERROR_CODES.ERR_DB_NOTES_UNAVAILABLE,
        notes: [],
      });
    }
  }

  if (body.action === "delete_note") {
    try {
      const res = store.deleteUserNote
        ? await store.deleteUserNote(user.id, body.note_id)
        : { ok: true, notes: [] };
      return json(200, { ok: res.ok, notes: res.notes });
    } catch (err) {
      await recordDegraded(
        ZOE_ERROR_CODES.ERR_DB_NOTES_UNAVAILABLE,
        err instanceof Error ? err.message : "deleteUserNote failed",
      );
      return json(200, { ok: true, notes: [] });
    }
  }

  // Prompt 2 item (6): Read-only Welile Glossary lookup (`assistant_staff_get_glossary`)
  if (body.action === "list_glossary") {
    try {
      const { data, error } = await userClient.rpc("assistant_staff_get_glossary", {
        p_search: body.search ?? null,
        p_category: body.category ?? null,
      });
      if (error) {
        await recordDegraded(
          ZOE_ERROR_CODES.ERR_DB_GLOSSARY_MISSING,
          `assistant_staff_get_glossary: ${error.message}`,
        );
        return json(200, {
          ok: true,
          degraded: true,
          error_code: ZOE_ERROR_CODES.ERR_DB_GLOSSARY_MISSING,
          source: "built_in_glossary_fallback",
          rows: BUILTIN_GLOSSARY_FALLBACK_ROWS,
        });
      }
      const payload = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
      return json(200, {
        ok: true,
        source: payload.source ?? "staff_assistant_glossary",
        rows: Array.isArray(payload.rows) ? payload.rows : BUILTIN_GLOSSARY_FALLBACK_ROWS,
      });
    } catch (err) {
      await recordDegraded(
        ZOE_ERROR_CODES.ERR_DB_GLOSSARY_MISSING,
        err instanceof Error ? err.message : "assistant_staff_get_glossary failed",
      );
      return json(200, {
        ok: true,
        degraded: true,
        error_code: ZOE_ERROR_CODES.ERR_DB_GLOSSARY_MISSING,
        source: "built_in_glossary_fallback",
        rows: BUILTIN_GLOSSARY_FALLBACK_ROWS,
      });
    }
  }

  // ---- 5. Requirement (d): Daily question budget, runtime config & burst rate limit -----------
  const callerRoles = await resolveCallerRoles(userClient, user.id);
  activeCallerRoles = callerRoles;

  // Read config via `staff_assistant_get_config` (wrapped: logs ERR_DB_CONFIG_MISSING and falls back to defaults)
  let rpcConfigRecord: Record<string, unknown> | null = null;
  try {
    const { data: cfgRpcData, error: cfgRpcErr } = await userClient.rpc(
      "staff_assistant_get_config",
    );
    if (cfgRpcErr) {
      await recordDegraded(
        ZOE_ERROR_CODES.ERR_DB_CONFIG_MISSING,
        `staff_assistant_get_config: ${cfgRpcErr.message}`,
      );
    } else if (cfgRpcData && typeof cfgRpcData === "object" && !Array.isArray(cfgRpcData)) {
      rpcConfigRecord = cfgRpcData as Record<string, unknown>;
    }
  } catch (err) {
    await recordDegraded(
      ZOE_ERROR_CODES.ERR_DB_CONFIG_MISSING,
      err instanceof Error ? err.message : "staff_assistant_get_config failed",
    );
  }

  let budget: BudgetCheckResult;
  try {
    budget = await store.checkQuestionBudget(user.id);
  } catch (err) {
    await recordDegraded(
      ZOE_ERROR_CODES.ERR_DB_RATE_LIMIT_MISSING,
      err instanceof Error ? err.message : "checkQuestionBudget failed",
    );
    budget = {
      allowed: true,
      remainingToday: DEFAULT_STAFF_ASSISTANT_CONFIG.maxQuestionsPerDay,
      maxQuestionsPerDay: DEFAULT_STAFF_ASSISTANT_CONFIG.maxQuestionsPerDay,
      maxModelRounds: DEFAULT_STAFF_ASSISTANT_CONFIG.maxModelRounds,
      maxToolCalls: DEFAULT_STAFF_ASSISTANT_CONFIG.maxToolCalls,
      webResearchEnabled: DEFAULT_STAFF_ASSISTANT_CONFIG.webResearchEnabled,
      modelConfig: { ...DEFAULT_STAFF_ASSISTANT_CONFIG.modelConfig },
    };
  }
  if (budget.errorCode) {
    await recordDegraded(
      budget.errorCode as ZoeErrorCode,
      budget.errorDetail ?? budget.errorCode,
    );
  }
  if (rpcConfigRecord && typeof rpcConfigRecord.web_research_enabled === "boolean") {
    budget = {
      ...budget,
      webResearchEnabled:
        budget.webResearchEnabled === true || rpcConfigRecord.web_research_enabled === true,
    };
  }

  if (!budget.allowed) {
    const reply = budget.reason === "daily_budget" ? MSG.dailyLimitReached : MSG.rateLimited;
    return json(429, {
      error: reply,
      reply,
      outcome: "rate_limited",
      reason: budget.reason,
      max_questions_per_day: budget.maxQuestionsPerDay,
    });
  }

  const forwardedFor = req.headers.get("x-forwarded-for") ?? req.headers.get("cf-connecting-ip");
  const sessionMeta: SessionMeta = {
    ipAddress: forwardedFor ? forwardedFor.split(",")[0].trim() : null,
    userAgent: req.headers.get("user-agent"),
    clientContext: body.client_context,
  };

  // ---- 6. Requirement (b): Resolve caller's roles & offer ONLY allowed tools -----------------
  const userText = body.message;
  const researchMode = body.research_mode === true;
  const consultantMode = isConsultantQuestion(userText);
  const isConsultantOrResearch = consultantMode || researchMode;
  const webResearchEnabled = isConsultantOrResearch && budget.webResearchEnabled === true;
  const researchPlan = researchMode ? buildResearchModePlan(userText) : [];
  const baseOpenAiTools = openAiToolsForRoles(callerRoles);
  const allowedOpenAiTools = isConsultantOrResearch
    ? filterToolsForConsultantMode(baseOpenAiTools, webResearchEnabled)
    : baseOpenAiTools;
  const toolDescriptions = describeToolsForRoles(callerRoles).filter(
    (line) => !isConsultantOrResearch || !line.startsWith("draft_"),
  );
  if (webResearchEnabled) {
    toolDescriptions.push(
      "search_web [Outside source]: Generic public web search via Brave Search (never include Welile names, phones, emails, or UGX figures). Label every external fact 'Outside source' with link and date.",
      "read_web_page [Outside source]: Read a public https:// page returned by search_web (wrapped in <UNTRUSTED_WEB_PAGE_DATA>). Label 'Outside source' with link and date; never mix with Welile totals.",
    );
  }

  let conv: {
    id: string;
    status: string;
    memory?: ConversationMemorySummary;
    rollingSummary?: string;
  };
  try {
    conv = await store.getOrCreateConversation(user.id, body.conversation_id, sessionMeta);
  } catch (err) {
    await recordDegraded(
      ZOE_ERROR_CODES.ERR_DB_MEMORY_READ_FAILED,
      err instanceof Error ? err.message : "getOrCreateConversation failed",
    );
    conv = {
      id: body.conversation_id ?? crypto.randomUUID(),
      status: "open",
      rollingSummary: "",
    };
  }
  activeConvId = conv.id;

  const existingMemory = parseConversationMemory(conv.memory);
  const newMemoryEntries: MemoryToolEntry[] = [];
  const statusSteps: string[] = [];
  const wantsStream = body.stream === true;
  const liveSse = wantsStream ? createLiveSseWriter() : null;
  let streamedTokensAlreadySent = false;
  let updatedRollingSummary = conv.rollingSummary ?? "";
  let totalQuestionCostUsd = 0;
  let cachedPromptTokens = 0;
  let webSearchesInQuestion = 0;
  let webSourcesReadInQuestion = 0;
  let webResearchSpentUsd = 0;
  const maxWebSourcesThisQuestion = researchMode
    ? MAX_RESEARCH_SOURCES_PER_QUESTION
    : MAX_WEB_SEARCHES_PER_QUESTION;

  const pushStatusStep = (stepText: string) => {
    if (!stepText) return;
    if (!statusSteps.includes(stepText)) {
      statusSteps.push(stepText);
    }
    liveSse?.emit("status", { text: stepText });
  };

  if (researchMode && researchPlan.length > 0) {
    liveSse?.emit("plan", { steps: researchPlan });
    pushStatusStep(researchPlan[0]);
  }

  const baseTier = selectModelTier(userText, {
    maxFastModelRounds: budget.maxModelRounds ?? MAX_MODEL_ROUNDS,
    maxFastToolCalls: budget.maxToolCalls ?? MAX_TOOL_CALLS,
    maxDeepModelRounds: budget.modelConfig?.maxDeepModelRounds ?? MAX_DEEP_MODEL_ROUNDS,
    maxDeepToolCalls: budget.modelConfig?.maxDeepToolCalls ?? MAX_DEEP_TOOL_CALLS,
    researchMode,
    ...(budget.modelConfig ?? {}),
  });
  const selectedTier = isConsultantOrResearch
    ? {
        ...baseTier,
        tier: "deep" as const,
        model: budget.modelConfig?.modelDeep ?? baseTier.model,
        maxModelRounds: budget.modelConfig?.maxDeepModelRounds ?? MAX_DEEP_MODEL_ROUNDS,
        maxToolCalls: budget.modelConfig?.maxDeepToolCalls ?? MAX_DEEP_TOOL_CALLS,
      }
    : baseTier;

  const finish = async (
    reply: string,
    outcome: TurnOutcome,
    opts?: {
      tools?: string[];
      model?: string;
      clarification?: { question: string; options: string[] };
      sourceLabel?: string | null;
      periodLabel?: string | null;
      reportPayload?: Record<string, unknown> | null;
      chart?: ZoeChartPayload | null;
      followUpSuggestions?: string[];
      unansweredReason?: UnansweredReason;
      errorCode?: ZoeErrorCode;
      errorDetail?: string;
      mfaRequired?: boolean;
    },
  ) => {
    const updatedMemory = appendMemoryEntries(existingMemory, newMemoryEntries);
    const chart =
      opts?.chart !== undefined
        ? opts.chart
        : outcome === "answered"
        ? extractChartFromReportPayload(opts?.reportPayload ?? null)
        : null;
    const followUpSuggestions =
      opts?.followUpSuggestions ??
      (outcome === "answered"
        ? buildFollowUpSuggestions({
            toolsCalled: opts?.tools ?? [],
            callerRoles,
          })
        : []);

    const enrichedReportPayload = opts?.reportPayload
      ? {
          ...opts.reportPayload,
          ...(consultantMode ? { consultant_mode: true } : {}),
          ...(chart ? { chart } : {}),
          ...(followUpSuggestions.length > 0
            ? { follow_up_suggestions: followUpSuggestions }
            : {}),
        }
      : chart
      ? {
          ...(consultantMode ? { consultant_mode: true } : {}),
          chart,
          follow_up_suggestions: followUpSuggestions,
        }
      : consultantMode
      ? { consultant_mode: true }
      : null;

    let assistantMessageId = crypto.randomUUID();
    try {
      const turnRes = await store.recordTurn({
        conversationId: conv.id,
        userId: user.id,
        userMessage: userText,
        assistantMessage: reply,
        outcome,
        toolsCalled: opts?.tools,
        sourceLabel: opts?.sourceLabel ?? null,
        periodLabel: opts?.periodLabel ?? null,
        reportPayload: enrichedReportPayload,
        conversationSummary: updatedMemory,
        rollingSummary: updatedRollingSummary,
        model: opts?.model,
        latencyMs: Date.now() - startedAt,
      });
      assistantMessageId = turnRes.assistantMessageId;
      if (turnRes.errorCode) {
        await recordDegraded(
          turnRes.errorCode as ZoeErrorCode,
          turnRes.errorDetail ?? turnRes.errorCode,
        );
      }
    } catch (err) {
      await recordDegraded(
        ZOE_ERROR_CODES.ERR_DB_USAGE_LOG_FAILED,
        err instanceof Error ? err.message : "recordTurn failed",
      );
    }

    if (opts?.unansweredReason) {
      try {
        await store.recordUnanswered({
          conversationId: conv.id,
          messageId: assistantMessageId,
          userId: user.id,
          callerRoles,
          questionText: userText,
          reason: opts.unansweredReason,
          errorCode: opts.errorCode ?? null,
          errorDetail: opts.errorDetail ?? null,
        });
      } catch {
        // best effort
      }
    }

    const responsePayload: Record<string, unknown> = {
      conversation_id: conv.id,
      message_id: assistantMessageId,
      reply,
      outcome,
      clarification: opts?.clarification ?? null,
      source: opts?.sourceLabel ?? null,
      period: opts?.periodLabel ?? null,
      report_payload: enrichedReportPayload,
      chart: chart ?? null,
      follow_up_suggestions: followUpSuggestions,
      status_steps: statusSteps,
      model_tier: selectedTier.tier,
      consultant_mode: consultantMode,
      research_mode: researchMode,
      ...(researchPlan.length > 0 ? { research_plan: researchPlan } : {}),
      estimated_cost_usd: Number(totalQuestionCostUsd.toFixed(6)),
      cached_prompt_tokens: cachedPromptTokens,
      mfa_required: opts?.mfaRequired ?? false,
      remaining_questions_today: budget.remainingToday,
      database_status: health.status,
      missing_db_objects: health.missingObjects,
      degraded_error_codes: degradedErrors.map((d) => d.errorCode),
    };

    if (wantsStream && liveSse) {
      if (!streamedTokensAlreadySent && typeof reply === "string" && reply.length > 0) {
        for (const chunk of splitTokensForStream(reply)) {
          liveSse.emit("token", { token: chunk });
        }
      }
      liveSse.emit("done", responsePayload);
      liveSse.close();
      return liveSse.response;
    }
    return json(200, responsePayload);
  };

  try {
    // ---- 7. Deterministic prompt-injection / write-mutation pre-check ------------------------
    if (isDirectPromptInjection(userText)) {
      return await finish(MSG.outOfScope, "out_of_scope", {
        unansweredReason: "out_of_scope",
      });
    }
    if (isWriteMutationIntent(userText)) {
      return await finish(formatWriteMutationRefusal(userText), "out_of_scope", {
        unansweredReason: "out_of_scope",
      });
    }

    // ---- 8. Tool-calling loop (20-turn memory, approved Zoe notes, safe calculator) ----------
    const [history, userNotes] = await Promise.all([
      store.loadRecentTurns(user.id, conv.id).catch(async (err) => {
        await recordDegraded(
          ZOE_ERROR_CODES.ERR_DB_MEMORY_READ_FAILED,
          err instanceof Error ? err.message : "loadRecentTurns failed",
        );
        return [] as ChatMessage[];
      }),
      store.listUserNotes
        ? store.listUserNotes(user.id).catch(async (err) => {
            await recordDegraded(
              ZOE_ERROR_CODES.ERR_DB_NOTES_UNAVAILABLE,
              err instanceof Error ? err.message : "listUserNotes failed",
            );
            return [] as ZoeNoteRecord[];
          })
        : Promise.resolve([] as ZoeNoteRecord[]),
    ]);
    const today = kampalaToday();
    const memoryBlock = formatConversationMemoryForPrompt(existingMemory);
    const zoeNotesBlock = formatZoeNotesForPrompt(userNotes);

    // Deliverable (6): Use the last 20 turns (40 messages) verbatim; summarise older turns
    const splitMemory = splitTurnsForPromptMemory(
      history,
      conv.rollingSummary ?? "",
      PROMPT_ACTIVE_TURNS,
    );
    const activeTurnWindow = splitMemory.activeTurnWindow;
    updatedRollingSummary = splitMemory.rollingSummaryText;
    const rollingSummaryBlock = splitMemory.rollingSummaryPromptBlock;

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(today, callerRoles, toolDescriptions, {
          conversationMemoryBlock: memoryBlock,
          zoeNotesBlock,
          rollingSummaryBlock,
          modelTier: selectedTier.tier,
          consultantMode,
          researchMode,
          webResearchEnabled,
        }),
      },
      ...activeTurnWindow,
      { role: "user", content: userText },
    ];

    const toolsCalled: string[] = [];
    // Seed rawToolOutputs with earlier conversation memory figures & assistant turns so
    // `compute` and "explain that" can reference earlier verified figures in this conversation.
    const rawToolOutputs: string[] = [];
    if (existingMemory.entries.length > 0) {
      rawToolOutputs.push(JSON.stringify(existingMemory.entries));
    }
    for (const h of history) {
      if (h.role === "assistant" && typeof h.content === "string" && h.content.trim()) {
        rawToolOutputs.push(h.content);
      }
    }

    const sourcesUsed: string[] = [];
    const periodsUsed: string[] = [];
    let lastReportPayload: Record<string, unknown> | null = null;
    let lastModel = selectedTier.model;
    let finalText: string | null = null;
    let hitStepOrCostLimit = false;

    const maxModelRounds = selectedTier.maxModelRounds;
    const maxToolCalls = selectedTier.maxToolCalls;
    const maxCostUsd = selectedTier.maxCostUsdPerQuestion;

    /**
     * Prompt 1 item (4): If a tool step fails because a database RPC or external dependency
     * is missing or errors, log the real `error_code` to `staff_assistant_unanswered`,
     * retry once with `tools: []`, and answer in plain text stating plainly what could not
     * be checked. `MSG.error` is reserved strictly for when the AI gateway itself is unreachable.
     */
    const retryPlainTextWhenToolUnavailable = async (
      failedToolName: string,
      failedRpc: string,
      errorDetail: string,
      overrideErrorCode?: ZoeErrorCode,
    ): Promise<Response> => {
      const errorCode = overrideErrorCode ?? mapMissingFunctionToErrorCode(failedRpc);
      await recordDegraded(errorCode, `${failedRpc}: ${errorDetail}`);

      const plainUnavailableNotice = `I could not check ${failedToolName} (${failedRpc}) right now because that database report or function is currently unavailable.`;
      let retryReplyText = "";
      let retryModel = lastModel;

      try {
        const retryMessages: ChatMessage[] = [
          {
            role: "system",
            content: `${buildSystemPrompt(today, callerRoles, [], {
              conversationMemoryBlock: memoryBlock,
              zoeNotesBlock,
              rollingSummaryBlock,
              modelTier: selectedTier.tier,
              consultantMode,
              webResearchEnabled: false,
            })}\n\nTOOL STEP FALLBACK (NO TOOLS AVAILABLE):
The database tool '${failedToolName}' (${failedRpc}) failed and could not be checked (${errorDetail}).
Answer the user's question in plain text without calling any tools:
- If the question is a general, conceptual, drafting, or explanation question, answer it directly in plain text.
- If the question asks for live Welile figures from '${failedToolName}' (${failedRpc}), state plainly that '${failedToolName}' (${failedRpc}) could not be checked right now because that database object is currently unavailable, and do not invent or guess any numbers.
- Always use mandatory Welile terminology: Rent Plan, Supporter, Returns.`,
          },
          ...activeTurnWindow,
          { role: "user", content: userText },
        ];

        const retryRes = await ai.chatCompletion({
          messages: retryMessages,
          tools: [],
          model: selectedTier.model,
          temperature: selectedTier.temperature,
          maxTokens: selectedTier.maxTokens,
          signal: req.signal,
        });
        retryModel = retryRes.model || lastModel;
        if (retryRes.usage) {
          totalQuestionCostUsd += retryRes.usage.estimatedCostUsd ?? 0;
          cachedPromptTokens += retryRes.usage.cachedTokens ?? 0;
        }
        retryReplyText = (retryRes.message.content ?? "").trim();
      } catch {
        // If retry call fails, fall through to deterministic plain-text explanation
      }

      const upperCandidate = retryReplyText.toUpperCase();
      const candidateValid =
        retryReplyText.length > 0 &&
        upperCandidate !== "UNMATCHED" &&
        upperCandidate !== "OUT_OF_SCOPE" &&
        upperCandidate !== "ROLE_RESTRICTED" &&
        retryReplyText !== MSG.error &&
        checkAnswer(retryReplyText, rawToolOutputs, userText).ok;

      if (candidateValid) {
        const mentionsUnavailable =
          /could not (check|read|verify)|unavailable|not available right now/i.test(
            retryReplyText,
          ) ||
          retryReplyText.toLowerCase().includes(failedToolName.toLowerCase()) ||
          retryReplyText.toLowerCase().includes(failedRpc.toLowerCase());

        const finalFallbackReply = mentionsUnavailable
          ? retryReplyText
          : `${retryReplyText}\n\nNote: ${plainUnavailableNotice}`;

        if (checkAnswer(finalFallbackReply, rawToolOutputs, userText).ok) {
          return await finish(finalFallbackReply, "answered", {
            tools: toolsCalled,
            model: retryModel,
            sourceLabel: null,
            periodLabel: null,
            reportPayload: null,
          });
        }
      }

      const manualMatch = searchStaffManualHelp(userText);
      const manualContext =
        manualMatch.topics.length > 0 ? `${manualMatch.topics[0].summary}\n\n` : "";
      const deterministicReply = `${manualContext}${plainUnavailableNotice} No live figures were read, so I will not guess any numbers. Please check the corresponding Welile workspace screen directly, or ask me a general or workflow question.`;

      return await finish(deterministicReply, "answered", {
        tools: toolsCalled,
        model: retryModel,
        sourceLabel: null,
        periodLabel: null,
        reportPayload: null,
      });
    };

    let verifiedParagraphsSoFar = 0;

    for (let round = 0; round < maxModelRounds; round++) {
      if (round > 0 && totalQuestionCostUsd >= maxCostUsd) {
        hitStepOrCostLimit = true;
        break;
      }

      verifiedParagraphsSoFar = 0;
      const onStreamTokenDelta = (delta: string, accumulated: string) => {
        if (!liveSse) return;
        streamedTokensAlreadySent = true;
        liveSse.emit("token", { token: delta });

        const paragraphs = accumulated.split(/\n\n+/);
        // Any paragraph before the last element has finished its `\n\n` boundary
        while (verifiedParagraphsSoFar < paragraphs.length - 1) {
          const pIdx = verifiedParagraphsSoFar;
          verifiedParagraphsSoFar += 1;
          const pCheck = checkStreamedParagraph(
            paragraphs[pIdx],
            rawToolOutputs,
            userText,
          );
          if (!pCheck.ok) {
            liveSse.emit("paragraph_replace", {
              paragraph_index: pIdx,
              replacement: UNVERIFIED_PARAGRAPH_REPLACEMENT,
              reason: pCheck.reason,
            });
          }
        }
      };

      const { message, model, usage } =
        wantsStream && typeof ai.chatCompletionStream === "function"
          ? await ai.chatCompletionStream({
              messages,
              tools: allowedOpenAiTools,
              model: selectedTier.model,
              temperature: selectedTier.temperature,
              maxTokens: selectedTier.maxTokens,
              signal: req.signal,
              onTokenDelta: onStreamTokenDelta,
            })
          : await ai.chatCompletion({
              messages,
              tools: allowedOpenAiTools,
              model: selectedTier.model,
              temperature: selectedTier.temperature,
              maxTokens: selectedTier.maxTokens,
              signal: req.signal,
            });

      lastModel = model;
      if (usage) {
        totalQuestionCostUsd += usage.estimatedCostUsd ?? 0;
        cachedPromptTokens += usage.cachedTokens ?? 0;
      }

      if (!message.tool_calls || message.tool_calls.length === 0) {
        finalText = (message.content ?? "").trim();
        if (wantsStream && !streamedTokensAlreadySent && finalText.length > 0) {
          let acc = "";
          for (const chunk of splitTokensForStream(finalText)) {
            acc += chunk;
            onStreamTokenDelta(chunk, acc);
          }
        }
        break;
      }

      const calls = message.tool_calls.slice(0, MAX_CALLS_PER_ROUND);
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });

      for (const call of calls) {
        if (toolsCalled.length >= maxToolCalls) {
          hitStepOrCostLimit = true;
          break;
        }

        const stepText = statusLineForTool(call.function.name);
        pushStatusStep(stepText);
        if (researchMode && researchPlan.length >= 2) {
          const nextPlanIdx = Math.min(toolsCalled.length + 1, researchPlan.length - 1);
          pushStatusStep(researchPlan[nextPlanIdx]);
        }

        const rawArgs = (() => {
          try {
            return JSON.parse(call.function.arguments || "{}");
          } catch {
            return null;
          }
        })();
        if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
          return await finish(MSG.unmatched, "unmatched", {
            tools: toolsCalled,
            model: lastModel,
            unansweredReason: "unmatched",
          });
        }

        // Pseudo-tool: ask_clarification
        if (call.function.name === "ask_clarification") {
          const c = ClarificationArgsSchema.safeParse(rawArgs);
          if (!c.success) {
            return await finish(MSG.unmatched, "unmatched", {
              tools: toolsCalled,
              model: lastModel,
              unansweredReason: "unmatched",
            });
          }
          const guard = checkAnswer(
            `${c.data.question} ${c.data.options.join(" ")}`,
            rawToolOutputs,
            userText,
          );
          if (!guard.ok) {
            return await finish(MSG.unmatched, "blocked", {
              tools: toolsCalled,
              model: lastModel,
              unansweredReason: "error",
            });
          }
          return await finish(c.data.question, "clarify", {
            tools: [...toolsCalled, "ask_clarification"],
            model: lastModel,
            clarification: c.data,
          });
        }

        // Prompt 3 item (3): Safe deterministic calculator (`compute`)
        if (call.function.name === "compute") {
          const parsedCompute = ComputeArgsSchema.safeParse(rawArgs);
          if (!parsedCompute.success) {
            return await finish(MSG.unmatched, "unmatched", {
              tools: toolsCalled,
              model: lastModel,
              unansweredReason: "unmatched",
            });
          }
          const computePeriod =
            periodsUsed.length > 0 ? periodsUsed.join(" vs ") : `as of ${today}`;
          const computeRes = runSafeCompute(parsedCompute.data, rawToolOutputs, computePeriod);
          if (!computeRes.ok) {
            return await finish(MSG.unmatched, "blocked", {
              tools: [...toolsCalled, "compute"],
              model: lastModel,
              unansweredReason: "error",
            });
          }
          toolsCalled.push("compute");
          const computeJson = JSON.stringify(computeRes.data);
          rawToolOutputs.push(computeJson);
          if (!sourcesUsed.includes("compute (Verified Conversation Calculator)")) {
            sourcesUsed.push("compute (Verified Conversation Calculator)");
          }
          const preparedCompute = prepareToolOutputForModel(computeRes.data, "compute", {
            maxChars: MAX_TOOL_RESULT_CHARS,
          });
          if (Array.isArray(computeRes.data.rows)) {
            lastReportPayload = {
              ...computeRes.data,
              tool: "compute",
              rpc: "compute",
              args: parsedCompute.data,
              source: "compute (Verified Conversation Calculator)",
              period: { as_of: today },
              row_count: (computeRes.data.rows as unknown[]).length,
              rows: computeRes.data.rows,
            };
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: preparedCompute.modelContent,
          });
          continue;
        }

        // Prompt 3 item (1): Staff manual & docs help (`get_staff_manual_help`)
        if (call.function.name === "get_staff_manual_help") {
          const parsedManual = ManualHelpArgsSchema.safeParse(rawArgs);
          if (!parsedManual.success) {
            return await finish(MSG.unmatched, "unmatched", {
              tools: toolsCalled,
              model: lastModel,
              unansweredReason: "unmatched",
            });
          }
          const helpRes = searchStaffManualHelp(parsedManual.data.topic);
          toolsCalled.push("get_staff_manual_help");
          const helpJson = JSON.stringify(helpRes);
          rawToolOutputs.push(helpJson);
          if (!sourcesUsed.includes(helpRes.source)) {
            sourcesUsed.push(helpRes.source);
          }
          if (!periodsUsed.includes(`as of ${today}`)) {
            periodsUsed.push(`as of ${today}`);
          }
          const preparedHelp = prepareToolOutputForModel(helpRes, "get_staff_manual_help", {
            maxChars: MAX_TOOL_RESULT_CHARS,
          });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: preparedHelp.modelContent,
          });
          continue;
        }

        // Consultant & Research modes block all write/action/export draft tools
        if (isConsultantOrResearch && CONSULTANT_FORBIDDEN_TOOLS.has(call.function.name)) {
          return await finish(MSG.outOfScope, "blocked", {
            tools: toolsCalled,
            model: lastModel,
            unansweredReason: "out_of_scope",
          });
        }

        // Deliverable (3) & (4): Admin-switched Web Research (`search_web`, `read_web_page`)
        if (WEB_RESEARCH_TOOL_NAMES.has(call.function.name)) {
          if (!isConsultantOrResearch || !webResearchEnabled) {
            return await finish(
              "Web research is currently disabled in staff_assistant_config (or outside Consultant / Research mode).",
              "blocked",
              {
                tools: toolsCalled,
                model: lastModel,
                unansweredReason: "role_restricted",
              },
            );
          }

          if (call.function.name === "search_web") {
            const parsedSearch = SearchWebArgsSchema.safeParse(rawArgs);
            if (!parsedSearch.success) {
              return await finish(MSG.unmatched, "unmatched", {
                tools: toolsCalled,
                model: lastModel,
                unansweredReason: "unmatched",
              });
            }
            const webRes = await executeConsultantWebSearch(
              parsedSearch.data.query,
              rawToolOutputs,
              fetch,
              {
                webResearchEnabled,
                searchesUsedInQuestion: webSearchesInQuestion,
                maxSearchesPerQuestion: maxWebSourcesThisQuestion,
                spentUsdInQuestion: webResearchSpentUsd,
                maxCostUsdPerQuestion: selectedTier.maxCostUsdPerQuestion,
                signal: req.signal,
              },
            );
            if (!webRes.ok) {
              return await finish(
                webRes.reason === "missing_api_key"
                  ? MSG.webResearchNotConfigured
                  : `I cannot run that web search: ${webRes.error}`,
                "blocked",
                {
                  tools: [...toolsCalled, "search_web"],
                  model: lastModel,
                  unansweredReason: "error",
                  errorCode: ZOE_ERROR_CODES.ERR_WEB_RESEARCH_FAILED,
                  errorDetail: webRes.error,
                },
              );
            }
            webSearchesInQuestion += 1;
            webSourcesReadInQuestion += 1;
            webResearchSpentUsd += webRes.costUsd;
            totalQuestionCostUsd += webRes.costUsd;
            toolsCalled.push("search_web");
            const webJson = JSON.stringify(webRes.payload);
            rawToolOutputs.push(webJson);
            if (!sourcesUsed.includes(webRes.payload.source)) {
              sourcesUsed.push(webRes.payload.source);
            }
            if (!periodsUsed.includes(webRes.payload.period)) {
              periodsUsed.push(webRes.payload.period);
            }
            const preparedWeb = prepareToolOutputForModel(webRes.payload, "search_web", {
              maxChars: MAX_TOOL_RESULT_CHARS,
            });
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: preparedWeb.modelContent,
            });
            continue;
          }

          if (call.function.name === "read_web_page") {
            const parsedPage = ReadWebPageArgsSchema.safeParse(rawArgs);
            if (!parsedPage.success) {
              return await finish(MSG.unmatched, "unmatched", {
                tools: toolsCalled,
                model: lastModel,
                unansweredReason: "unmatched",
              });
            }
            if (webSourcesReadInQuestion >= maxWebSourcesThisQuestion) {
              return await finish(
                `Per-question web source limit reached (${maxWebSourcesThisQuestion} sources).`,
                "blocked",
                {
                  tools: [...toolsCalled, "read_web_page"],
                  model: lastModel,
                  unansweredReason: "error",
                  errorCode: ZOE_ERROR_CODES.ERR_WEB_RESEARCH_FAILED,
                  errorDetail: "max_web_sources_reached",
                },
              );
            }
            const pageRes = await executeConsultantReadWebPage(
              parsedPage.data.url,
              rawToolOutputs,
              fetch,
              {
                webResearchEnabled,
                signal: req.signal,
              },
            );
            if (!pageRes.ok) {
              return await finish(
                `I cannot read that web page: ${pageRes.error}`,
                "blocked",
                {
                  tools: [...toolsCalled, "read_web_page"],
                  model: lastModel,
                  unansweredReason: "error",
                  errorCode: ZOE_ERROR_CODES.ERR_WEB_RESEARCH_FAILED,
                  errorDetail: pageRes.error,
                },
              );
            }
            webSourcesReadInQuestion += 1;
            toolsCalled.push("read_web_page");
            const pageJson = JSON.stringify(pageRes.payload);
            rawToolOutputs.push(pageJson);
            if (!sourcesUsed.includes(pageRes.payload.source)) {
              sourcesUsed.push(pageRes.payload.source);
            }
            if (!periodsUsed.includes(pageRes.payload.period)) {
              periodsUsed.push(pageRes.payload.period);
            }
            const preparedPage = prepareToolOutputForModel(pageRes.payload, "read_web_page", {
              maxChars: MAX_TOOL_RESULT_CHARS,
            });
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: preparedPage.modelContent,
            });
            continue;
          }
        }

        // Action tool: draft_report_email (NEVER sends; looks up recipient ONLY via staff_assistant_email_recipients)
        if (call.function.name === "draft_report_email") {
          const d = DraftReportEmailArgsSchema.safeParse(rawArgs);
          if (!d.success) {
            return await finish(MSG.unmatched, "unmatched", {
              tools: toolsCalled,
              model: lastModel,
              unansweredReason: "unmatched",
            });
          }

          if (isEmailFromToolData(d.data.recipient_search, rawToolOutputs, userText)) {
            return await finish(MSG.dataEmailForbidden, "blocked", {
              tools: [...toolsCalled, "draft_report_email"],
              model: lastModel,
              unansweredReason: "role_restricted",
            });
          }

          if (!lastReportPayload && d.data.report_tool) {
            const repTool = findTool(d.data.report_tool);
            if (!repTool) {
              return await finish(MSG.unmatched, "unmatched", {
                tools: toolsCalled,
                model: lastModel,
                unansweredReason: "missing_tool",
              });
            }
            if (!canUseTool(repTool, callerRoles)) {
              return await finish(MSG.roleRestricted, "not_staff", {
                tools: toolsCalled,
                model: lastModel,
                unansweredReason: "role_restricted",
              });
            }
            if (repTool.sensitive) {
              const mfaGate = await checkMfa(token, user.id);
              if (!mfaGate.ok) {
                return await finish(MSG.mfaRequired, "blocked", {
                  tools: toolsCalled,
                  model: lastModel,
                  mfaRequired: true,
                });
              }
            }
            const repArgs = repTool.schema.safeParse({});
            const repRpcArgs = repTool.toRpcArgs(repArgs.success ? repArgs.data : {});
            const { data: repData, error: repError } = await userClient.rpc(
              repTool.rpc,
              repRpcArgs,
            );
            if (repError) {
              if (repError.code === "42501") {
                return await finish(MSG.roleRestricted, "not_staff", {
                  tools: toolsCalled,
                  model: lastModel,
                  unansweredReason: "role_restricted",
                });
              }
              return await retryPlainTextWhenToolUnavailable(
                repTool.name,
                repTool.rpc,
                repError.message,
              );
            }
            toolsCalled.push(repTool.name);
            const preparedRep = prepareToolOutputForModel(repData ?? {}, repTool.name, {
              maxChars: MAX_TOOL_RESULT_CHARS,
            });
            rawToolOutputs.push(preparedRep.cleanJson);
            if (repData && typeof repData === "object" && !Array.isArray(repData)) {
              const payload = repData as Record<string, unknown>;
              if (typeof payload.source === "string" && payload.source.trim()) {
                if (!sourcesUsed.includes(payload.source)) sourcesUsed.push(payload.source);
              }
              const pLabel = formatPeriodLabel(payload.period);
              if (pLabel && !periodsUsed.includes(pLabel)) periodsUsed.push(pLabel);
              lastReportPayload = {
                ...payload,
                tool: repTool.name,
                rpc: repTool.rpc,
                args: repArgs.success ? repArgs.data : {},
                source: payload.source ?? repTool.rpc,
                period: payload.period ?? null,
                row_count: payload.row_count ?? null,
                rows: Array.isArray(payload.rows) ? payload.rows.slice(0, 200) : [],
                data: payload.data ?? null,
              };
            }
          }

          if (!lastReportPayload) {
            const candidatePayload = await store.loadLatestReportPayload(user.id, conv.id);
            if (
              candidatePayload &&
              isHistoryMessageAllowedForRoles(
                { role: "assistant", report_payload: candidatePayload },
                callerRoles,
              )
            ) {
              lastReportPayload = candidatePayload;
            }
          }

          if (!lastReportPayload) {
            return await finish(
              "Which report would you like me to draft an email for? Ask for the report first or specify the report and staff colleague.",
              "clarify",
              {
                tools: [...toolsCalled, "draft_report_email"],
                model: lastModel,
                clarification: {
                  question: "Which report would you like to email?",
                  options: ["My tasks and tickets", "My payslips"],
                },
              },
            );
          }

          const combinedRawOutputs = [
            ...rawToolOutputs,
            JSON.stringify(lastReportPayload),
            JSON.stringify({ period: today }),
          ];
          if (isEmailFromToolData(d.data.recipient_search, rawToolOutputs, userText)) {
            return await finish(MSG.dataEmailForbidden, "blocked", {
              tools: [...toolsCalled, "draft_report_email"],
              model: lastModel,
              unansweredReason: "role_restricted",
            });
          }

          const emailDraftGuard = checkDraftCardText(
            [d.data.subject, d.data.message],
            combinedRawOutputs,
            userText,
          );
          if (!emailDraftGuard.ok) {
            return await finish(MSG.unmatched, "blocked", {
              tools: [...toolsCalled, "draft_report_email"],
              model: lastModel,
              unansweredReason: "error",
            });
          }

          const recipientQuery = extractRecipientQuery(d.data.recipient_search);
          const { data: recipientRows, error: recipientErr } = await userClient.rpc(
            "staff_assistant_email_recipients",
            { p_search: recipientQuery },
          );
          if (recipientErr) {
            return await retryPlainTextWhenToolUnavailable(
              "draft_report_email",
              "staff_assistant_email_recipients",
              recipientErr.message,
            );
          }

          const resolvedPeriodLabel =
            periodsUsed[0] ?? formatPeriodLabel(lastReportPayload.period) ?? today;
          const draftOutcome = buildReportEmailDraft({
            recipientSearch: d.data.recipient_search,
            recipients: normalizeStaffRecipients(recipientRows),
            rawToolOutputs: combinedRawOutputs,
            userText,
            subject: d.data.subject,
            message: d.data.message,
            reportPayload: lastReportPayload,
            periodLabel: resolvedPeriodLabel,
            todayKampala: today,
          });

          if (draftOutcome.kind === "refused") {
            return await finish(draftOutcome.message, "blocked", {
              tools: [...toolsCalled, "draft_report_email"],
              model: lastModel,
              unansweredReason: "role_restricted",
            });
          }

          if (draftOutcome.draft.recipient_user_id) {
            const reportToolDef = findTool(draftOutcome.draft.report_reference.tool);
            const roleAllowed =
              reportToolDef &&
              canUseTool(reportToolDef, draftOutcome.draft.recipient_roles) &&
              !(
                draftOutcome.draft.report_reference.rpc.startsWith("assistant_staff_my_") &&
                draftOutcome.draft.recipient_user_id !== user.id
              );
            const dbRoleAllowed = await checkRecipientCanReadReport(
              userClient,
              draftOutcome.draft.recipient_user_id,
              draftOutcome.draft.report_reference.rpc,
              recordDegraded,
            );
            if (!roleAllowed || !dbRoleAllowed) {
              return await finish(MSG.recipientRoleRestricted, "blocked", {
                tools: [...toolsCalled, "draft_report_email"],
                model: lastModel,
                unansweredReason: "role_restricted",
              });
            }
          }

          const savedEmailDraftId = await saveServerDraft(
            userClient,
            "email",
            {
              kind: "email",
              recipient_email: draftOutcome.draft.recipient_email ?? "",
              subject: draftOutcome.draft.subject,
              message: draftOutcome.draft.message,
              report_reference: draftOutcome.draft.report_reference,
            },
            conv.id,
            recordDegraded,
          );
          if (savedEmailDraftId) {
            draftOutcome.draft.draft_id = savedEmailDraftId;
          }

          if (draftOutcome.kind === "pick_recipient") {
            return await finish(draftOutcome.question, "clarify", {
              tools: [...toolsCalled, "draft_report_email"],
              model: lastModel,
              clarification: {
                question: draftOutcome.question,
                options: draftOutcome.options,
              },
              sourceLabel: draftOutcome.draft.report_reference.source,
              periodLabel: draftOutcome.draft.report_reference.period,
              reportPayload: {
                ...lastReportPayload,
                email_draft: draftOutcome.draft,
              },
            });
          }

          return await finish(draftOutcome.replyText, "answered", {
            tools: [...toolsCalled, "draft_report_email"],
            model: lastModel,
            sourceLabel: draftOutcome.draft.report_reference.source,
            periodLabel: draftOutcome.draft.report_reference.period,
            reportPayload: {
              ...lastReportPayload,
              email_draft: draftOutcome.draft,
            },
          });
        }

        // Action tool: draft_reminder
        if (call.function.name === "draft_reminder") {
          const r = DraftReminderArgsSchema.safeParse(rawArgs);
          if (!r.success) {
            return await finish(MSG.unmatched, "unmatched", {
              tools: toolsCalled,
              model: lastModel,
              unansweredReason: "unmatched",
            });
          }

          const reminderDraft = buildReminderDraft({
            title: r.data.title,
            remindAt: r.data.remind_at,
            note: r.data.note,
            todayKampala: today,
          });

          const reminderGuard = checkDraftCardText(
            [r.data.title, r.data.note],
            [...rawToolOutputs, JSON.stringify({ today, remind_at: reminderDraft.draft.remind_at_kampala })],
            userText,
          );
          if (!reminderGuard.ok) {
            return await finish(MSG.unmatched, "blocked", {
              tools: [...toolsCalled, "draft_reminder"],
              model: lastModel,
              unansweredReason: "error",
            });
          }

          const savedReminderDraftId = await saveServerDraft(
            userClient,
            "reminder",
            {
              kind: "reminder",
              title: reminderDraft.draft.title,
              remind_at: reminderDraft.draft.remind_at,
              note: reminderDraft.draft.note ?? "",
            },
            conv.id,
            recordDegraded,
          );
          if (savedReminderDraftId) {
            reminderDraft.draft.draft_id = savedReminderDraftId;
          }

          return await finish(reminderDraft.replyText, "answered", {
            tools: [...toolsCalled, "draft_reminder"],
            model: lastModel,
            sourceLabel: "My Space Zoe Reminder Draft",
            periodLabel: reminderDraft.draft.remind_at_kampala,
            reportPayload: {
              ...(lastReportPayload ?? {}),
              action_draft: reminderDraft.draft,
            },
          });
        }

        // Action tool: draft_staff_notification
        if (call.function.name === "draft_staff_notification") {
          const n = DraftStaffNotificationArgsSchema.safeParse(rawArgs);
          if (!n.success) {
            return await finish(MSG.unmatched, "unmatched", {
              tools: toolsCalled,
              model: lastModel,
              unansweredReason: "unmatched",
            });
          }

          if (isEmailFromToolData(n.data.recipient_search, rawToolOutputs, userText)) {
            return await finish(MSG.dataEmailForbidden, "blocked", {
              tools: [...toolsCalled, "draft_staff_notification"],
              model: lastModel,
              unansweredReason: "role_restricted",
            });
          }

          const notifGuard = checkDraftCardText(
            [n.data.title, n.data.message],
            [...rawToolOutputs, JSON.stringify({ today })],
            userText,
          );
          if (!notifGuard.ok) {
            return await finish(MSG.unmatched, "blocked", {
              tools: [...toolsCalled, "draft_staff_notification"],
              model: lastModel,
              unansweredReason: "error",
            });
          }

          const recipientQuery = extractRecipientQuery(n.data.recipient_search);
          const { data: recipientRows, error: recipientErr } = await userClient.rpc(
            "staff_assistant_email_recipients",
            { p_search: recipientQuery },
          );
          if (recipientErr) {
            return await retryPlainTextWhenToolUnavailable(
              "draft_staff_notification",
              "staff_assistant_email_recipients",
              recipientErr.message,
            );
          }

          const notifOutcome = buildStaffNotificationDraft({
            recipientSearch: n.data.recipient_search,
            recipients: normalizeStaffRecipients(recipientRows),
            rawToolOutputs,
            userText,
            title: n.data.title,
            message: n.data.message,
            todayKampala: today,
          });

          if (notifOutcome.kind === "refused") {
            return await finish(notifOutcome.message, "blocked", {
              tools: [...toolsCalled, "draft_staff_notification"],
              model: lastModel,
              unansweredReason: "role_restricted",
            });
          }

          const savedNotifDraftId = await saveServerDraft(
            userClient,
            "notification",
            {
              kind: "notification",
              recipient_email: notifOutcome.draft.recipient_email ?? "",
              title: notifOutcome.draft.title,
              message: notifOutcome.draft.message,
              link_path: "/me",
            },
            conv.id,
            recordDegraded,
          );
          if (savedNotifDraftId) {
            notifOutcome.draft.draft_id = savedNotifDraftId;
          }

          if (notifOutcome.kind === "pick_recipient") {
            return await finish(notifOutcome.question, "clarify", {
              tools: [...toolsCalled, "draft_staff_notification"],
              model: lastModel,
              clarification: {
                question: notifOutcome.question,
                options: notifOutcome.options,
              },
              sourceLabel: "staff_assistant_email_recipients",
              periodLabel: today,
              reportPayload: {
                ...(lastReportPayload ?? {}),
                action_draft: notifOutcome.draft,
              },
            });
          }

          return await finish(notifOutcome.replyText, "answered", {
            tools: [...toolsCalled, "draft_staff_notification"],
            model: lastModel,
            sourceLabel: "staff_assistant_email_recipients",
            periodLabel: today,
            reportPayload: {
              ...(lastReportPayload ?? {}),
              action_draft: notifOutcome.draft,
            },
          });
        }

        // Action tool: draft_report_schedule
        if (call.function.name === "draft_report_schedule") {
          const s = DraftReportScheduleArgsSchema.safeParse(rawArgs);
          if (!s.success) {
            return await finish(MSG.unmatched, "unmatched", {
              tools: toolsCalled,
              model: lastModel,
              unansweredReason: "unmatched",
            });
          }

          if (isEmailFromToolData(s.data.recipient_search, rawToolOutputs, userText)) {
            return await finish(MSG.dataEmailForbidden, "blocked", {
              tools: [...toolsCalled, "draft_report_schedule"],
              model: lastModel,
              unansweredReason: "role_restricted",
            });
          }

          if (!lastReportPayload && s.data.report_tool) {
            const repTool = findTool(s.data.report_tool);
            if (!repTool) {
              return await finish(MSG.unmatched, "unmatched", {
                tools: toolsCalled,
                model: lastModel,
                unansweredReason: "missing_tool",
              });
            }
            if (!canUseTool(repTool, callerRoles)) {
              return await finish(MSG.roleRestricted, "not_staff", {
                tools: toolsCalled,
                model: lastModel,
                unansweredReason: "role_restricted",
              });
            }
            if (repTool.sensitive) {
              const mfaGate = await checkMfa(token, user.id);
              if (!mfaGate.ok) {
                return await finish(MSG.mfaRequired, "blocked", {
                  tools: toolsCalled,
                  model: lastModel,
                  mfaRequired: true,
                });
              }
            }
            const repArgs = repTool.schema.safeParse({});
            const repRpcArgs = repTool.toRpcArgs(repArgs.success ? repArgs.data : {});
            const { data: repData, error: repError } = await userClient.rpc(
              repTool.rpc,
              repRpcArgs,
            );
            if (repError) {
              if (repError.code === "42501") {
                return await finish(MSG.roleRestricted, "not_staff", {
                  tools: toolsCalled,
                  model: lastModel,
                  unansweredReason: "role_restricted",
                });
              }
              return await retryPlainTextWhenToolUnavailable(
                repTool.name,
                repTool.rpc,
                repError.message,
              );
            }
            toolsCalled.push(repTool.name);
            const preparedRep = prepareToolOutputForModel(repData ?? {}, repTool.name, {
              maxChars: MAX_TOOL_RESULT_CHARS,
            });
            rawToolOutputs.push(preparedRep.cleanJson);
            if (repData && typeof repData === "object" && !Array.isArray(repData)) {
              const payload = repData as Record<string, unknown>;
              lastReportPayload = {
                ...payload,
                tool: repTool.name,
                rpc: repTool.rpc,
                args: repArgs.success ? repArgs.data : {},
                source: payload.source ?? repTool.rpc,
                period: payload.period ?? null,
                row_count: payload.row_count ?? null,
                rows: Array.isArray(payload.rows) ? payload.rows.slice(0, 200) : [],
                data: payload.data ?? null,
              };
            }
          }

          if (!lastReportPayload) {
            const candidatePayload = await store.loadLatestReportPayload(user.id, conv.id);
            if (
              candidatePayload &&
              isHistoryMessageAllowedForRoles(
                { role: "assistant", report_payload: candidatePayload },
                callerRoles,
              )
            ) {
              lastReportPayload = candidatePayload;
            }
          }

          if (!lastReportPayload) {
            return await finish(
              "Which report would you like me to schedule? Ask for the report first or specify the report, frequency (daily or weekly), and Welile staff recipient.",
              "clarify",
              {
                tools: [...toolsCalled, "draft_report_schedule"],
                model: lastModel,
                clarification: {
                  question: "Which report would you like to schedule?",
                  options: ["My tasks and tickets", "My payslips"],
                },
              },
            );
          }

          const combinedOutputs = [
            ...rawToolOutputs,
            JSON.stringify(lastReportPayload),
            JSON.stringify({ period: today }),
          ];
          if (isEmailFromToolData(s.data.recipient_search, rawToolOutputs, userText)) {
            return await finish(MSG.dataEmailForbidden, "blocked", {
              tools: [...toolsCalled, "draft_report_schedule"],
              model: lastModel,
              unansweredReason: "role_restricted",
            });
          }

          const scheduleDraftGuard = checkDraftCardText(
            [s.data.custom_message],
            combinedOutputs,
            userText,
          );
          if (!scheduleDraftGuard.ok) {
            return await finish(MSG.unmatched, "blocked", {
              tools: [...toolsCalled, "draft_report_schedule"],
              model: lastModel,
              unansweredReason: "error",
            });
          }

          const recipientQuery = extractRecipientQuery(s.data.recipient_search);
          const { data: recipientRows, error: recipientErr } = await userClient.rpc(
            "staff_assistant_email_recipients",
            { p_search: recipientQuery },
          );
          if (recipientErr) {
            return await retryPlainTextWhenToolUnavailable(
              "draft_report_schedule",
              "staff_assistant_email_recipients",
              recipientErr.message,
            );
          }

          const resolvedPeriodLabel =
            periodsUsed[0] ?? formatPeriodLabel(lastReportPayload.period) ?? today;
          const scheduleOutcome = buildReportScheduleDraft({
            recipientSearch: s.data.recipient_search,
            recipients: normalizeStaffRecipients(recipientRows),
            rawToolOutputs: combinedOutputs,
            userText,
            frequency: s.data.frequency,
            dayOfWeek: s.data.day_of_week,
            sendTimeKampala: s.data.send_time_kampala,
            customMessage: s.data.custom_message,
            reportPayload: lastReportPayload,
            periodLabel: resolvedPeriodLabel,
            todayKampala: today,
          });

          if (scheduleOutcome.kind === "refused") {
            return await finish(scheduleOutcome.message, "blocked", {
              tools: [...toolsCalled, "draft_report_schedule"],
              model: lastModel,
              unansweredReason: "role_restricted",
            });
          }

          if (scheduleOutcome.draft.recipient_user_id) {
            const reportToolDef = findTool(scheduleOutcome.draft.report_reference.tool);
            const roleAllowed =
              reportToolDef &&
              canUseTool(reportToolDef, scheduleOutcome.draft.recipient_roles) &&
              !(
                scheduleOutcome.draft.report_reference.rpc.startsWith("assistant_staff_my_") &&
                scheduleOutcome.draft.recipient_user_id !== user.id
              );
            const dbRoleAllowed = await checkRecipientCanReadReport(
              userClient,
              scheduleOutcome.draft.recipient_user_id,
              scheduleOutcome.draft.report_reference.rpc,
              recordDegraded,
            );
            if (!roleAllowed || !dbRoleAllowed) {
              return await finish(MSG.recipientRoleRestricted, "blocked", {
                tools: [...toolsCalled, "draft_report_schedule"],
                model: lastModel,
                unansweredReason: "role_restricted",
              });
            }
          }

          const savedScheduleDraftId = await saveServerDraft(
            userClient,
            "schedule",
            {
              kind: "schedule",
              title: scheduleOutcome.draft.title,
              report_tool: scheduleOutcome.draft.report_reference.tool,
              report_rpc: scheduleOutcome.draft.report_reference.rpc,
              report_args: scheduleOutcome.draft.report_reference.args ?? {},
              frequency: scheduleOutcome.draft.frequency,
              day_of_week: scheduleOutcome.draft.day_of_week,
              send_time_kampala: scheduleOutcome.draft.send_time_kampala,
              recipient_emails: scheduleOutcome.draft.recipient_email
                ? [scheduleOutcome.draft.recipient_email]
                : [],
              custom_message: scheduleOutcome.draft.custom_message ?? "",
            },
            conv.id,
            recordDegraded,
          );
          if (savedScheduleDraftId) {
            scheduleOutcome.draft.draft_id = savedScheduleDraftId;
          }

          if (scheduleOutcome.kind === "pick_recipient") {
            return await finish(scheduleOutcome.question, "clarify", {
              tools: [...toolsCalled, "draft_report_schedule"],
              model: lastModel,
              clarification: {
                question: scheduleOutcome.question,
                options: scheduleOutcome.options,
              },
              sourceLabel: scheduleOutcome.draft.report_reference.source,
              periodLabel: scheduleOutcome.draft.report_reference.period,
              reportPayload: {
                ...lastReportPayload,
                action_draft: scheduleOutcome.draft,
              },
            });
          }

          return await finish(scheduleOutcome.replyText, "answered", {
            tools: [...toolsCalled, "draft_report_schedule"],
            model: lastModel,
            sourceLabel: scheduleOutcome.draft.report_reference.source,
            periodLabel: scheduleOutcome.draft.report_reference.period,
            reportPayload: {
              ...lastReportPayload,
              action_draft: scheduleOutcome.draft,
            },
          });
        }

        // Action tool: draft_welile_idea (Prompt 4 item 3: "Ideas for Welile" draft card)
        if (call.function.name === "draft_welile_idea") {
          const ideaParsed = DraftIdeaArgsSchema.safeParse(rawArgs);
          if (!ideaParsed.success) {
            return await finish(MSG.unmatched, "unmatched", {
              tools: toolsCalled,
              model: lastModel,
              unansweredReason: "unmatched",
            });
          }

          if (!lastReportPayload) {
            const candidatePayload = await store.loadLatestReportPayload(user.id, conv.id);
            if (
              candidatePayload &&
              isHistoryMessageAllowedForRoles(
                { role: "assistant", report_payload: candidatePayload },
                callerRoles,
              )
            ) {
              lastReportPayload = candidatePayload;
            }
          }

          const combinedIdeaOutputs = [
            ...rawToolOutputs,
            ...(lastReportPayload ? [JSON.stringify(lastReportPayload)] : []),
            JSON.stringify({ period: today }),
          ];

          const ideaGuard = checkDraftCardText(
            [
              ideaParsed.data.title,
              ideaParsed.data.suggestion,
              ideaParsed.data.evidence_summary,
            ],
            combinedIdeaOutputs,
            userText,
          );
          if (!ideaGuard.ok) {
            return await finish(MSG.unmatched, "blocked", {
              tools: [...toolsCalled, "draft_welile_idea"],
              model: lastModel,
              unansweredReason: "error",
            });
          }

          const resolvedIdeaPeriod =
            ideaParsed.data.period_label ??
            periodsUsed[0] ??
            (lastReportPayload ? formatPeriodLabel(lastReportPayload.period) : null) ??
            `as of ${today}`;

          const builtIdea = buildIdeaDraft({
            title: ideaParsed.data.title,
            suggestion: ideaParsed.data.suggestion,
            evidenceSummary: ideaParsed.data.evidence_summary,
            category: ideaParsed.data.category,
            screenPath: ideaParsed.data.screen_path,
            sourceLabel: ideaParsed.data.source_label,
            figures: ideaParsed.data.figures,
            reportPayload: lastReportPayload,
            periodLabel: resolvedIdeaPeriod,
            todayKampala: today,
          });

          const savedIdeaDraftId = await saveServerDraft(
            userClient,
            "idea",
            {
              kind: "idea",
              title: builtIdea.draft.title,
              suggestion: builtIdea.draft.suggestion,
              evidence_summary: builtIdea.draft.evidence_summary,
              source_label: builtIdea.draft.source_label,
              period_label: builtIdea.draft.period_label,
              category: builtIdea.draft.category,
              screen_path: builtIdea.draft.screen_path,
            },
            conv.id,
            recordDegraded,
          );
          if (savedIdeaDraftId) {
            builtIdea.draft.draft_id = savedIdeaDraftId;
          }

          return await finish(builtIdea.replyText, "answered", {
            tools: [...toolsCalled, "draft_welile_idea"],
            model: lastModel,
            sourceLabel: builtIdea.draft.source_label,
            periodLabel: builtIdea.draft.period_label,
            reportPayload: {
              ...(lastReportPayload ?? {}),
              action_draft: builtIdea.draft,
            },
          });
        }

        // Look up tool & enforce role check (Requirement b)
        const tool = findTool(call.function.name);
        if (!tool) {
          return await finish(MSG.unmatched, "unmatched", {
            tools: toolsCalled,
            model: lastModel,
            unansweredReason: "missing_tool",
          });
        }

        if (!canUseTool(tool, callerRoles)) {
          return await finish(MSG.roleRestricted, "not_staff", {
            tools: toolsCalled,
            model: lastModel,
            unansweredReason: "role_restricted",
          });
        }

        // Validate tool arguments against its strict Zod schema
        const args = tool.schema.safeParse(rawArgs);
        if (!args.success) {
          return await finish(MSG.unmatched, "unmatched", {
            tools: toolsCalled,
            model: lastModel,
            unansweredReason: "unmatched",
          });
        }

        // Prompt 3 item (3): Analyst Lane pre-flight validation & role-area/MFA checks
        let validatedAnalystSql: {
          cleanSql: string;
          executedSql: string;
          roleAreas: ZoeRoArea[];
        } | null = null;

        if (tool.name === "get_data_catalog") {
          const areaArg = String((args.data as Record<string, unknown>).area ?? "all")
            .trim()
            .toLowerCase();
          if (areaArg !== "" && areaArg !== "all") {
            if (!canCallerAccessZoeRoArea(areaArg as ZoeRoArea, callerRoles, user.id)) {
              return await finish(MSG.roleRestricted, "not_staff", {
                tools: toolsCalled,
                model: lastModel,
                unansweredReason: "role_restricted",
              });
            }
          }
        }

        if (tool.name === "run_analyst_query") {
          const queryStartedAt = Date.now();
          const candidateQuery = String((args.data as Record<string, unknown>).sql ?? "");
          const queryQuestion = String(
            (args.data as Record<string, unknown>).question ?? userText,
          );
          const sqlCheck = validateAnalystSqlQuery(candidateQuery);
          if (!sqlCheck.ok) {
            await store.logAnalystQuery?.({
              userId: user.id,
              question: queryQuestion,
              sqlText: candidateQuery,
              executedSql: candidateQuery,
              roleAreas: [],
              rowCount: 0,
              truncated: false,
              durationMs: Date.now() - queryStartedAt,
              status: "refused",
              errorMessage: sqlCheck.reason,
            });
            return await finish(
              `I cannot run that Analyst query: ${sqlCheck.reason}`,
              "blocked",
              {
                tools: [...toolsCalled, "run_analyst_query"],
                model: lastModel,
                unansweredReason: "error",
              },
            );
          }

          for (const area of sqlCheck.roleAreas) {
            if (!canCallerAccessZoeRoArea(area, callerRoles, user.id)) {
              await store.logAnalystQuery?.({
                userId: user.id,
                question: queryQuestion,
                sqlText: sqlCheck.cleanSql,
                executedSql: sqlCheck.executedSql,
                roleAreas: sqlCheck.roleAreas,
                rowCount: 0,
                truncated: false,
                durationMs: Date.now() - queryStartedAt,
                status: "refused",
                errorMessage: `Role not authorized for zoe_ro area: ${area}`,
              });
              return await finish(MSG.roleRestricted, "not_staff", {
                tools: toolsCalled,
                model: lastModel,
                unansweredReason: "role_restricted",
              });
            }
          }

          if (sqlCheck.requiresAal2) {
            const mfaGate = await checkMfa(token, user.id);
            if (!mfaGate.ok) {
              await store.logAnalystQuery?.({
                userId: user.id,
                question: queryQuestion,
                sqlText: sqlCheck.cleanSql,
                executedSql: sqlCheck.executedSql,
                roleAreas: sqlCheck.roleAreas,
                rowCount: 0,
                truncated: false,
                durationMs: Date.now() - queryStartedAt,
                status: "refused",
                errorMessage: "MFA aal2 required for sensitive zoe_ro area",
              });
              return await finish(MSG.mfaRequired, "blocked", {
                tools: toolsCalled,
                model: lastModel,
                mfaRequired: true,
              });
            }
          }

          validatedAnalystSql = {
            cleanSql: sqlCheck.cleanSql,
            executedSql: sqlCheck.executedSql,
            roleAreas: sqlCheck.roleAreas,
          };
        }

        // Requirement (g): Sensitive tools require AAL2 MFA via requireStaffAal2
        if (tool.sensitive) {
          const mfaGate = await checkMfa(token, user.id);
          if (!mfaGate.ok) {
            return await finish(MSG.mfaRequired, "blocked", {
              tools: toolsCalled,
              model: lastModel,
              mfaRequired: true,
            });
          }
        }

        // Requirement (c): Call `assistant_staff_*` with the caller's OWN JWT (`userClient`)
        const rpcArgs = tool.toRpcArgs(args.data);
        if (tool.name === "run_analyst_query" && !rpcArgs.p_question) {
          rpcArgs.p_question = userText;
        }
        const rpcStartedAt = Date.now();
        let data: unknown = null;
        let error: { code?: string; message: string } | null = null;

        if (tool.name === "get_data_catalog") {
          const primaryCatalog = await userClient.rpc("assistant_staff_get_data_catalog", rpcArgs);
          if (!primaryCatalog.error) {
            data = primaryCatalog.data;
          } else {
            await recordDegraded(
              ZOE_ERROR_CODES.ERR_DB_ANALYST_CATALOG_MISSING,
              `assistant_staff_get_data_catalog: ${primaryCatalog.error.message}`,
            );
            const fallbackCatalog = await userClient.rpc("assistant_staff_data_catalog", rpcArgs);
            data = fallbackCatalog.data;
            error = fallbackCatalog.error;
          }
        } else {
          const rpcRes = await userClient.rpc(tool.rpc, rpcArgs);
          data = rpcRes.data;
          error = rpcRes.error;
        }

        if (error) {
          console.error(`[staff-assistant] tool ${tool.rpc} error:`, error.code, error.message);
          if (tool.name === "run_analyst_query" && validatedAnalystSql) {
            await store.logAnalystQuery?.({
              userId: user.id,
              question: String(rpcArgs.p_question ?? userText),
              sqlText: validatedAnalystSql.cleanSql,
              executedSql: validatedAnalystSql.executedSql,
              roleAreas: validatedAnalystSql.roleAreas,
              rowCount: 0,
              truncated: false,
              durationMs: Date.now() - rpcStartedAt,
              status: error.code === "42501" ? "refused" : "error",
              errorMessage: error.message,
            });
          }
          if (error.code === "42501") {
            return await finish(MSG.roleRestricted, "not_staff", {
              tools: toolsCalled,
              model: lastModel,
              unansweredReason: "role_restricted",
            });
          }
          return await retryPlainTextWhenToolUnavailable(
            tool.name,
            tool.name === "get_data_catalog" ? "assistant_staff_get_data_catalog" : tool.rpc,
            error.message,
          );
        }

        // Deduplicate `rows`/`data`, sanitize free-text fields, trim by whole rows ("showing 50 of 312 rows"),
        // and wrap in `<UNTRUSTED_TOOL_DATA>` for prompt-injection defence.
        const rawJsonString = JSON.stringify(data ?? {});
        const prepared = prepareToolOutputForModel(data ?? {}, tool.name, {
          maxChars: MAX_TOOL_RESULT_CHARS,
        });
        toolsCalled.push(tool.name);
        rawToolOutputs.push(rawJsonString);
        if (prepared.cleanJson !== rawJsonString) {
          rawToolOutputs.push(prepared.cleanJson);
        }

        if (data && typeof data === "object" && !Array.isArray(data)) {
          const payload = data as Record<string, unknown>;
          const sourceStr =
            typeof payload.source === "string" && payload.source.trim()
              ? payload.source.trim()
              : tool.rpc;
          if (!sourcesUsed.includes(sourceStr)) sourcesUsed.push(sourceStr);
          const pLabel = formatPeriodLabel(payload.period);
          if (pLabel && !periodsUsed.includes(pLabel)) {
            periodsUsed.push(pLabel);
          }

          if (tool.name === "run_analyst_query" && validatedAnalystSql) {
            await store.logAnalystQuery?.({
              userId: user.id,
              question: String(rpcArgs.p_question ?? userText),
              sqlText:
                typeof payload.sql === "string" ? payload.sql : validatedAnalystSql.cleanSql,
              executedSql:
                typeof payload.executed_sql === "string"
                  ? payload.executed_sql
                  : validatedAnalystSql.executedSql,
              roleAreas: validatedAnalystSql.roleAreas,
              rowCount:
                typeof payload.row_count === "number"
                  ? payload.row_count
                  : prepared.totalRows ?? 0,
              truncated: Boolean(payload.truncated),
              durationMs:
                typeof payload.duration_ms === "number"
                  ? payload.duration_ms
                  : Date.now() - rpcStartedAt,
              status: "ok",
            });
          }

          lastReportPayload = {
            ...payload,
            tool: tool.name,
            rpc: tool.rpc,
            args: args.data,
            resolved_rpc_args: rpcArgs,
            source: sourceStr,
            period: payload.period ?? null,
            row_count: payload.row_count ?? prepared.totalRows,
            rows: Array.isArray(payload.rows) ? payload.rows.slice(0, 200) : [],
            data: payload.data ?? null,
            ...(tool.adHoc
              ? {
                  ad_hoc: true,
                  certification: "Ad hoc, not certified",
                  ...(validatedAnalystSql
                    ? {
                        sql:
                          typeof payload.sql === "string"
                            ? payload.sql
                            : validatedAnalystSql.cleanSql,
                        executed_sql:
                          typeof payload.executed_sql === "string"
                            ? payload.executed_sql
                            : validatedAnalystSql.executedSql,
                      }
                    : {}),
                }
              : {}),
            ...(prepared.truncationNote ? { rows_note: prepared.truncationNote } : {}),
          };

          newMemoryEntries.push(
            buildMemoryEntryFromToolResult({
              tool: tool.name,
              rpc: tool.rpc,
              toolArgs: args.data,
              payload,
              todayKampala: today,
            }),
          );
        }

        messages.push({ role: "tool", tool_call_id: call.id, content: prepared.modelContent });
      }
      if (hitStepOrCostLimit) {
        break;
      }
    }

    // Prompt 2 item (3): When the multi-step loop reaches its round, tool-call, or cost ceiling
    // after gathering partial tool results, synthesize a clear grounded summary of what Zoe has so far.
    if (!finalText && newMemoryEntries.length > 0) {
      const partialReply = synthesizePartialStepLimitReply(
        newMemoryEntries,
        MSG.stepLimitReachedPrefix,
      );
      const sourceLabel =
        sourcesUsed.length > 0 ? sourcesUsed.join(" + ") : toolsCalled.join(" + ");
      const periodLabel = periodsUsed.length > 0 ? periodsUsed.join(", ") : `as of ${today}`;
      const partialGuard = checkAnswer(
        partialReply,
        [...rawToolOutputs, JSON.stringify({ source: sourceLabel, period: periodLabel })],
        userText,
      );
      if (partialGuard.ok) {
        return await finish(partialReply, "answered", {
          tools: toolsCalled,
          model: lastModel,
          sourceLabel,
          periodLabel,
          reportPayload: lastReportPayload,
        });
      }
    }

    if (!finalText) {
      return await finish(MSG.unmatched, "unmatched", {
        tools: toolsCalled,
        model: lastModel,
        unansweredReason: "unmatched",
      });
    }

    const trimmedUpper = finalText.trim().toUpperCase();
    if (trimmedUpper === "OUT_OF_SCOPE") {
      return await finish(MSG.outOfScope, "out_of_scope", {
        tools: toolsCalled,
        model: lastModel,
        unansweredReason: "out_of_scope",
      });
    }
    if (trimmedUpper === "ROLE_RESTRICTED") {
      return await finish(MSG.roleRestricted, "not_staff", {
        tools: toolsCalled,
        model: lastModel,
        unansweredReason: "role_restricted",
      });
    }
    if (trimmedUpper === "UNMATCHED") {
      return await finish(MSG.unmatched, "unmatched", {
        tools: toolsCalled,
        model: lastModel,
        unansweredReason: "missing_tool",
      });
    }

    // Prompt 2 item (2) & Prompt 3 item (1): Zoe answers greetings, explanations, drafting,
    // brainstorming, general work help, and transparent data-unavailable guidance directly
    // without canned UNMATCHED/OUT_OF_SCOPE scripts, while still enforcing checkAnswer on any figure.
    if (toolsCalled.length === 0) {
      if (!isConversationalPromptAllowedWithoutTool(userText, finalText)) {
        return await finish(MSG.unmatched, "unmatched", {
          model: lastModel,
          unansweredReason: "missing_tool",
        });
      }

      const policyTaggedText = ensurePolicyDisclaimerWhenNeeded(userText, finalText, toolsCalled);
      const convGuard = checkAnswer(policyTaggedText, rawToolOutputs, userText);
      if (!convGuard.ok) {
        if (convGuard.reason === "prompt_leak") {
          return await finish(MSG.outOfScope, "blocked", {
            model: lastModel,
            unansweredReason: "out_of_scope",
          });
        }
        if (wantsStream) {
          const sanitized = verifyAndSanitizeStreamedParagraphs(
            policyTaggedText,
            rawToolOutputs,
            userText,
          );
          for (const pIdx of sanitized.replacedIndices) {
            liveSse?.emit("paragraph_replace", {
              paragraph_index: pIdx,
              replacement: UNVERIFIED_PARAGRAPH_REPLACEMENT,
              sanitized_text: sanitized.sanitizedText,
            });
          }
          return await finish(sanitized.sanitizedText, "answered", {
            tools: [],
            model: lastModel,
            sourceLabel: null,
            periodLabel: null,
            reportPayload: null,
            unansweredReason: "error",
            errorCode: "ERR_STREAM_PARAGRAPH_UNVERIFIED",
            errorDetail: `Replaced ${sanitized.replacedIndices.length} unverified paragraph(s): ${sanitized.reasons.join(", ")}`,
          });
        }
        return await finish(MSG.unmatched, "blocked", {
          model: lastModel,
          unansweredReason: "error",
        });
      }

      return await finish(policyTaggedText, "answered", {
        tools: [],
        model: lastModel,
        sourceLabel: null,
        periodLabel: null,
        reportPayload: null,
      });
    }


    const sourceLabel =
      sourcesUsed.length > 0 ? sourcesUsed.join(" + ") : toolsCalled.join(" + ");
    const periodLabel = periodsUsed.length > 0 ? periodsUsed.join(", ") : `as of ${today}`;

    // Always add a "Source · dates" line whenever any tool was used
    let answerWithCitation = ensurePolicyDisclaimerWhenNeeded(userText, finalText, toolsCalled);
    if (sourceLabel && !answerWithCitation.toLowerCase().includes("source:")) {
      answerWithCitation = `${answerWithCitation}\n\nSource: ${sourceLabel} · Period: ${periodLabel}`;
    }

    // Prompt 3 item (3): Ensure every ad-hoc Analyst query answer carries "Ad hoc, not certified"
    const usedAdHocAnalyst = toolsCalled.includes("run_analyst_query");
    if (usedAdHocAnalyst) {
      answerWithCitation = ensureAdHocCertificationNotice(answerWithCitation, true);
    }

    const allowedOutputsForGuard = [
      ...rawToolOutputs,
      JSON.stringify({
        source: sourceLabel,
        period: periodLabel,
        ...(usedAdHocAnalyst ? { certification: "Ad hoc, not certified", limit: 500 } : {}),
      }),
    ];

    // Requirement (d): Deterministic post-generation guard against tool results
    const guard = checkAnswer(
      answerWithCitation,
      allowedOutputsForGuard,
      userText,
    );
    if (!guard.ok) {
      console.warn(`[staff-assistant] output guard blocked answer: ${guard.reason}`);
      if (guard.reason === "prompt_leak") {
        return await finish(MSG.outOfScope, "blocked", {
          tools: toolsCalled,
          model: lastModel,
          unansweredReason: "out_of_scope",
        });
      }
      if (wantsStream) {
        const sanitized = verifyAndSanitizeStreamedParagraphs(
          answerWithCitation,
          allowedOutputsForGuard,
          userText,
        );
        for (const pIdx of sanitized.replacedIndices) {
          liveSse?.emit("paragraph_replace", {
            paragraph_index: pIdx,
            replacement: UNVERIFIED_PARAGRAPH_REPLACEMENT,
            sanitized_text: sanitized.sanitizedText,
          });
        }
        return await finish(sanitized.sanitizedText, "answered", {
          tools: toolsCalled,
          model: lastModel,
          sourceLabel,
          periodLabel,
          reportPayload: lastReportPayload,
          unansweredReason: "error",
          errorCode: "ERR_STREAM_PARAGRAPH_UNVERIFIED",
          errorDetail: `Replaced ${sanitized.replacedIndices.length} unverified paragraph(s): ${sanitized.reasons.join(", ")}`,
        });
      }
      return await finish(MSG.unmatched, "blocked", {
        tools: toolsCalled,
        model: lastModel,
        unansweredReason: "error",
      });
    }

    return await finish(answerWithCitation, "answered", {
      tools: toolsCalled,
      model: lastModel,
      sourceLabel,
      periodLabel,
      reportPayload: lastReportPayload,
    });
  } catch (err) {
    if (err instanceof AiGatewayError && (err.status === 429 || err.status === 402)) {
      console.error(
        `[staff-assistant] AI gateway HTTP ${err.status}:`,
        err.detail || err.message,
      );
      const reply = err.status === 429 ? MSG.gatewayBusy : MSG.gatewayOutOfCredit;
      return await finish(reply, "error", {
        unansweredReason: "error",
        errorCode: ZOE_ERROR_CODES.ERR_AI_GATEWAY_UNREACHABLE,
        errorDetail: `AI gateway HTTP ${err.status}`,
      });
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[staff-assistant] unhandled error:", errMsg);
    return await finish(MSG.error, "error", {
      unansweredReason: "error",
      errorCode: ZOE_ERROR_CODES.ERR_AI_GATEWAY_UNREACHABLE,
      errorDetail: errMsg,
    });
  }
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve((req) => handleStaffAssistantRequest(req));
}
