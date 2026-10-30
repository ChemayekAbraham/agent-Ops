import {
  buildReminderDraft,
  buildReportScheduleDraft,
  buildStaffNotificationDraft,
  resolveReminderTimestamp,
  ZoeActionDraft,
  ZoeNotificationDraft,
  ZoeReminderDraft,
  ZoeScheduleDraft,
} from "../../supabase/functions/staff-assistant/actionDrafts.ts";
import {
  ALLOWED_ANALYST_SQL_FUNCTIONS,
  type AnalystSqlValidationResult,
  areaRequiresStaffAal2,
  canCallerAccessZoeRoArea,
  ensureAdHocCertificationNotice,
  FORBIDDEN_ANALYST_PII_COLUMNS,
  validateAnalystSqlQuery,
  ZOE_RO_AREA_ROLES,
  ZOE_RO_VIEWS_CATALOG,
  type ZoeRoArea,
  type ZoeRoViewCatalogEntry,
} from "../../supabase/functions/staff-assistant/analyst.ts";
import {
  CONSULTANT_FORBIDDEN_TOOLS,
  type ConsultantChecklistScore,
  executeConsultantReadWebPage,
  executeConsultantWebSearch,
  filterToolsForConsultantMode,
  isConsultantQuestion,
  scoreConsultantAnswer,
  validateConsultantWebQuery,
  validateConsultantWebUrl,
  WEB_RESEARCH_TOOL_NAMES,
} from "../../supabase/functions/staff-assistant/consultant.ts";
import {
  currentWednesdayWeekStart,
  formatPeriodLabel,
  kampalaToday,
  Period,
  resolvePeriod,
} from "../../supabase/functions/staff-assistant/dates.ts";
import {
  buildReportEmailDraft,
  DraftEmailOutcome,
  extractRecipientQuery,
  isEmailFromToolData,
  normalizeStaffRecipients,
  sanitizeWelileTermsServer,
  StaffEmailRecipient,
} from "../../supabase/functions/staff-assistant/emailDraft.ts";
import {
  checkAnswer,
  checkDraftCardText,
  containsPromptOrSecretLeak,
  GuardResult,
  isDirectPromptInjection,
  isWriteMutationIntent,
  validateZoeNoteText,
} from "../../supabase/functions/staff-assistant/guards.ts";
import {
  handleStaffAssistantRequest,
  StaffAssistantAiClient,
  StaffAssistantHandlerDeps,
  StaffAssistantStoreDeps,
} from "../../supabase/functions/staff-assistant/index.ts";
import { isConversationalPromptAllowedWithoutTool } from "../../supabase/functions/staff-assistant/manualHelp.ts";
import {
  buildRollingConversationSummary,
  formatZoeNotesForPrompt,
  MAX_ZOE_NOTES_PER_USER,
  synthesizePartialStepLimitReply,
  ZoeUserNote,
} from "../../supabase/functions/staff-assistant/memory.ts";
import { MSG } from "../../supabase/functions/staff-assistant/messages.ts";
import {
  buildMorningBriefForCaller,
  isPastKampalaBriefTime,
  MORNING_BRIEF_CANDIDATE_TOOLS,
  MorningBriefPayload,
  selectRoleBriefToolNames,
} from "../../supabase/functions/staff-assistant/morningBrief.ts";
import {
  type ChatMessage,
  DEFAULT_CHAT_MAX_TOKENS,
  DEFAULT_CHAT_TEMPERATURE,
  DEFAULT_MAX_COST_USD_PER_QUESTION,
  DEFAULT_ZOE_MODEL_DEEP,
  DEFAULT_ZOE_MODEL_FAST,
  estimateCallCostUsd,
  isDeepQuestion,
  MAX_DEEP_MODEL_ROUNDS,
  MAX_DEEP_TOOL_CALLS,
  type OpenAiTool,
  selectModelTier,
} from "../../supabase/functions/staff-assistant/openai.ts";
import {
  buildSystemPrompt,
  SCOPE_CHECK_PROMPT,
  STATIC_SYSTEM_PROMPT_PREFIX,
} from "../../supabase/functions/staff-assistant/prompt.ts";
import { cleanMessage, RequestSchema } from "../../supabase/functions/staff-assistant/schemas.ts";
import {
  type BudgetCheckResult,
  checkStaffAssistantHealth,
  DEFAULT_STAFF_ASSISTANT_CONFIG,
  mapMissingFunctionToErrorCode,
  resetStaffAssistantHealthCache,
  ZOE_ERROR_CODES,
  type ZoeErrorCode,
} from "../../supabase/functions/staff-assistant/store.ts";
import {
  canUseTool,
  ClarificationArgsSchema,
  describeToolsForRoles,
  DraftReportEmailArgsSchema,
  findTool,
  isHistoryMessageAllowedForRoles,
  openAiToolsForRoles,
  STAFF_TOOLS,
  StaffTool,
  toolsForRoles,
} from "../../supabase/functions/staff-assistant/tools.ts";
import {
  deduplicatePayloadArrays,
  isValueFromToolDataOnly,
  PreparedToolOutput,
  prepareToolOutputForModel,
  sanitizeUntrustedFreeText,
} from "../../supabase/functions/staff-assistant/toolOutput.ts";
import {
  DEFAULT_MAX_EMAILS_PER_DAY,
  extractReportTableFromFreshRpc,
  handleStaffAssistantSendEmail,
  SendEmailDependencies,
  SendEmailResult,
  ZOE_REPORT_EMAIL_DISPLAY_NAME,
  ZOE_REPORT_EMAIL_TEMPLATE,
} from "../../supabase/functions/staff-assistant-send-email/handler.ts";

export {
  ALLOWED_ANALYST_SQL_FUNCTIONS,
  areaRequiresStaffAal2,
  buildMorningBriefForCaller,
  buildReminderDraft,
  buildReportEmailDraft,
  buildReportScheduleDraft,
  buildRollingConversationSummary,
  buildStaffNotificationDraft,
  buildSystemPrompt,
  canCallerAccessZoeRoArea,
  canUseTool,
  checkAnswer,
  checkDraftCardText,
  checkStaffAssistantHealth,
  ClarificationArgsSchema,
  cleanMessage,
  CONSULTANT_FORBIDDEN_TOOLS,
  containsPromptOrSecretLeak,
  currentWednesdayWeekStart,
  deduplicatePayloadArrays,
  DEFAULT_CHAT_MAX_TOKENS,
  DEFAULT_CHAT_TEMPERATURE,
  DEFAULT_MAX_COST_USD_PER_QUESTION,
  DEFAULT_MAX_EMAILS_PER_DAY,
  DEFAULT_STAFF_ASSISTANT_CONFIG,
  DEFAULT_ZOE_MODEL_DEEP,
  DEFAULT_ZOE_MODEL_FAST,
  describeToolsForRoles,
  DraftReportEmailArgsSchema,
  ensureAdHocCertificationNotice,
  estimateCallCostUsd,
  executeConsultantReadWebPage,
  executeConsultantWebSearch,
  extractRecipientQuery,
  extractReportTableFromFreshRpc,
  filterToolsForConsultantMode,
  findTool,
  FORBIDDEN_ANALYST_PII_COLUMNS,
  formatPeriodLabel,
  formatZoeNotesForPrompt,
  handleStaffAssistantRequest,
  handleStaffAssistantSendEmail,
  isConsultantQuestion,
  isConversationalPromptAllowedWithoutTool,
  isDeepQuestion,
  isDirectPromptInjection,
  isEmailFromToolData,
  isHistoryMessageAllowedForRoles,
  isPastKampalaBriefTime,
  isValueFromToolDataOnly,
  isWriteMutationIntent,
  kampalaToday,
  mapMissingFunctionToErrorCode,
  MAX_DEEP_MODEL_ROUNDS,
  MAX_DEEP_TOOL_CALLS,
  MAX_ZOE_NOTES_PER_USER,
  MORNING_BRIEF_CANDIDATE_TOOLS,
  MSG,
  normalizeStaffRecipients,
  openAiToolsForRoles,
  prepareToolOutputForModel,
  RequestSchema,
  resetStaffAssistantHealthCache,
  resetStaffAssistantHealthCache as resetStaffAssistantHealthCacheForTest,
  resolvePeriod,
  resolveReminderTimestamp,
  sanitizeUntrustedFreeText,
  sanitizeWelileTermsServer,
  SCOPE_CHECK_PROMPT,
  scoreConsultantAnswer,
  selectModelTier,
  selectRoleBriefToolNames,
  STAFF_TOOLS,
  STATIC_SYSTEM_PROMPT_PREFIX,
  synthesizePartialStepLimitReply,
  toolsForRoles,
  validateAnalystSqlQuery,
  validateConsultantWebQuery,
  validateConsultantWebUrl,
  validateZoeNoteText,
  WEB_RESEARCH_TOOL_NAMES,
  ZOE_ERROR_CODES,
  ZOE_REPORT_EMAIL_DISPLAY_NAME,
  ZOE_REPORT_EMAIL_TEMPLATE,
  ZOE_RO_AREA_ROLES,
  ZOE_RO_VIEWS_CATALOG,
};
export type {
  AnalystSqlValidationResult,
  BudgetCheckResult,
  ChatMessage,
  ConsultantChecklistScore,
  DraftEmailOutcome,
  GuardResult,
  MorningBriefPayload,
  OpenAiTool,
  Period,
  PreparedToolOutput,
  SendEmailDependencies,
  SendEmailResult,
  StaffAssistantAiClient,
  StaffAssistantHandlerDeps,
  StaffAssistantStoreDeps,
  StaffEmailRecipient,
  StaffTool,
  ZoeActionDraft,
  ZoeErrorCode,
  ZoeNotificationDraft,
  ZoeReminderDraft,
  ZoeRoArea,
  ZoeRoViewCatalogEntry,
  ZoeScheduleDraft,
  ZoeUserNote,
};

/**
 * Fixed anchor date for deterministic Zoe safety and accuracy evaluations:
 * Monday, 26 October 2026 at 09:00:00 Africa/Kampala (06:00:00 UTC).
 */
export const FIXED_EVAL_DATE = "2026-10-26";
export const FIXED_EVAL_TIMESTAMP_MS = Date.parse("2026-10-26T09:00:00+03:00");

/**
 * Runs a callback with `Date.now` pinned to `FIXED_EVAL_TIMESTAMP_MS` (`2026-10-26`)
 * so that `kampalaToday()`, `resolvePeriod()`, `currentWednesdayWeekStart()`, and
 * `STAFF_TOOLS[i].toRpcArgs()` always produce identical dates regardless of when
 * `npm run eval:zoe` is executed.
 */
export async function withFixedEvalDate<T>(fn: () => T | Promise<T>): Promise<T> {
  const realDateNow = Date.now;
  Date.now = () => FIXED_EVAL_TIMESTAMP_MS;
  try {
    return await fn();
  } finally {
    Date.now = realDateNow;
  }
}

export function withFixedEvalDateSync<T>(fn: () => T): T {
  const realDateNow = Date.now;
  Date.now = () => FIXED_EVAL_TIMESTAMP_MS;
  try {
    return fn();
  } finally {
    Date.now = realDateNow;
  }
}

export interface SimulatedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ExecuteZoeTurnInput {
  authenticated?: boolean;
  hasAccess?: boolean;
  callerRoles: string[];
  mfaAal2?: boolean;
  userMessage: string;
  action?: string;
  conversationId?: string;
  requestExtraFields?: Record<string, unknown>;
  scopeClassification?: "in_scope" | "out_of_scope";
  modelToolCalls?: SimulatedToolCall[];
  modelToolCallRounds?: SimulatedToolCall[][];
  modelFinalText?: string;
  rpcDataByTool?: Record<string, Record<string, unknown> | { errorCode: string; message: string }>;
  missingFunctions?: string[];
  brokenRpcs?: string[];
  aiGatewayUnreachable?: boolean;
  staffDirectory?: StaffEmailRecipient[];
  recentTurns?: ChatMessage[];
  userNotes?: ZoeUserNote[];
  latestReportPayload?: Record<string, unknown> | null;
  budgetCheckResult?: BudgetCheckResult;
  recipientCanReadReport?: boolean;
}

export interface ExecuteZoeTurnResult {
  httpStatus: number;
  outcome:
    | "answered"
    | "clarify"
    | "out_of_scope"
    | "not_staff"
    | "unmatched"
    | "blocked"
    | "rate_limited"
    | "error"
    | "invalid_request"
    | "unauthorized";
  reply: string;
  toolsOffered: string[];
  toolsCalled: string[];
  source: string | null;
  period: string | null;
  reportPayload: Record<string, unknown> | null;
  mfaRequired: boolean;
  emailsSentCount: number;
  modelMessagesSeen: ChatMessage[][];
  savedDrafts: Array<{ kind: string; payload: Record<string, unknown>; draftId: string }>;
  loggedAnalystQueries: Array<{
    question: string;
    sqlText: string;
    executedSql: string;
    roleAreas: string[];
    rowCount: number;
    truncated: boolean;
    status: "ok" | "refused" | "error";
    errorMessage?: string;
  }>;
  unansweredLogs: Array<{
    reason: string;
    errorCode?: string | null;
    errorDetail?: string | null;
    questionText: string;
  }>;
  degradedErrorCodes: string[];
  databaseStatus?: string;
  modelTier?: "fast" | "deep";
  consultantMode?: boolean;
  statusSteps?: string[];
}

const ENABLED_STAFF_ROLES = new Set([
  "employee",
  "operations",
  "tenant_ops",
  "landlord_ops",
  "agent_ops",
  "partner_ops",
  "financial_ops",
  "hr",
  "crm",
  "cmo",
  "rd",
  "coo",
  "cfo",
  "ceo",
  "cto",
  "manager",
  "super_admin",
  "access_admin",
]);

/**
 * Executes a turn against the REAL `handleStaffAssistantRequest` handler from
 * `supabase/functions/staff-assistant/index.ts` with injected `aiClient`, `userClient`,
 * `checkMfaAal2`, and `store` dependencies.
 */
export async function executeZoeTurn(input: ExecuteZoeTurnInput): Promise<ExecuteZoeTurnResult> {
  return await withFixedEvalDate(async () => {
    const callerHasStaffRole = input.callerRoles.some((r) =>
      ENABLED_STAFF_ROLES.has(r.toLowerCase().trim())
    );
    const hasAccess = input.hasAccess ?? callerHasStaffRole;

    const modelMessagesSeen: ChatMessage[][] = [];
    const savedDrafts: Array<{ kind: string; payload: Record<string, unknown>; draftId: string }> =
      [];
    const loggedAnalystQueries: ExecuteZoeTurnResult["loggedAnalystQueries"] = [];
    const unansweredLogs: ExecuteZoeTurnResult["unansweredLogs"] = [];
    let recordedToolsCalled: string[] = [];
    let toolsOfferedFromRound: string[] = [];

    const missingSet = new Set(
      [...(input.missingFunctions ?? []), ...(input.brokenRpcs ?? [])].map((f) =>
        f.toLowerCase().trim(),
      ),
    );

    const mockUserClient = {
      auth: {
        getUser: async () => {
          if (input.authenticated === false) {
            return { data: { user: null }, error: { message: "Unauthorized" } };
          }
          return {
            data: {
              user: {
                id: "5295252d-0000-4000-8000-000000000001",
                email: "staff@welile.com",
              },
            },
            error: null,
          };
        },
      },
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: async () => {
              if (table === "user_roles") {
                return {
                  data: input.callerRoles.map((role) => ({ role })),
                  error: null,
                };
              }
              return { data: [], error: null };
            },
          }),
        }),
      }),
      rpc: async (fnName: string, rpcArgs?: Record<string, unknown>) => {
        const lowerFn = fnName.toLowerCase().trim();
        if (missingSet.has(lowerFn)) {
          return {
            data: null,
            error: {
              code: "PGRST202",
              message: `Could not find the function public.${fnName} in the schema cache`,
            },
          };
        }

        if (fnName === "staff_assistant_has_access") {
          return { data: hasAccess, error: null };
        }
        if (fnName === "staff_assistant_health") {
          const missingFns = [...missingSet];
          return {
            data: {
              ok: missingFns.length === 0,
              status: missingFns.length > 0 ? "zoe_database_behind" : "ok",
              missing_functions: missingFns,
              missing_tables: [],
              missing_columns: [],
              missing_views: [],
              missing_objects: missingFns.map((f) => `function:${f}`),
            },
            error: null,
          };
        }
        if (fnName === "staff_assistant_get_config") {
          return {
            data: {
              id: true,
              enabled: true,
              max_questions_per_day: 50,
              max_emails_per_day: 10,
              max_notifications_per_day: 20,
              history_days: 30,
              max_model_rounds: 4,
              max_tool_calls: 6,
              model_fast: "google/gemini-2.5-flash",
              model_deep: "google/gemini-2.5-pro",
              temperature: 0.2,
              max_tokens: 3200,
              max_deep_model_rounds: 8,
              max_deep_tool_calls: 12,
              max_cost_usd_per_question: 0.08,
              web_research_enabled: Boolean(input.budgetCheckResult?.webResearchEnabled),
            },
            error: null,
          };
        }
        if (fnName === "staff_assistant_email_recipients") {
          const query = String(rpcArgs?.p_search ?? "").toLowerCase().trim();
          const directory = input.staffDirectory ?? [];
          const matches = directory.filter(
            (r) =>
              r.full_name.toLowerCase().includes(query) ||
              r.email.toLowerCase() === query,
          );
          return { data: matches, error: null };
        }
        if (fnName === "staff_assistant_can_user_read_report") {
          return { data: input.recipientCanReadReport ?? true, error: null };
        }
        if (fnName === "staff_assistant_save_draft") {
          const draftId = `550e8400-e29b-41d4-a716-${String(savedDrafts.length + 1).padStart(
            12,
            "0",
          )}`;
          savedDrafts.push({
            kind: String(rpcArgs?.p_kind ?? ""),
            payload: (rpcArgs?.p_payload as Record<string, unknown>) ?? {},
            draftId,
          });
          return { data: { ok: true, draft_id: draftId }, error: null };
        }

        // Find matching tool by RPC name (including canonical alias assistant_staff_get_data_catalog)
        const tool = STAFF_TOOLS.find(
          (t) =>
            t.rpc === fnName ||
            (fnName === "assistant_staff_get_data_catalog" && t.name === "get_data_catalog"),
        );
        const toolKey = tool?.name ?? fnName;
        const mockRes =
          input.rpcDataByTool?.[toolKey] ??
          input.rpcDataByTool?.[fnName] ??
          (fnName === "assistant_staff_get_data_catalog"
            ? input.rpcDataByTool?.["assistant_staff_data_catalog"]
            : undefined);

        if (mockRes && typeof mockRes === "object" && "errorCode" in mockRes) {
          return {
            data: null,
            error: {
              code: String(mockRes.errorCode),
              message: String(mockRes.message ?? "RPC error"),
            },
          };
        }

        const payload = (mockRes as Record<string, unknown> | undefined) ?? {
          source: tool?.rpc ?? fnName,
          period: { as_of: FIXED_EVAL_DATE },
          row_count: 1,
          rows: [],
        };
        return { data: payload, error: null };
      },
    };

    let chatRound = 0;
    const mockAiClient: StaffAssistantAiClient = {
      classifyText: async () => {
        const cat = input.scopeClassification ?? "in_scope";
        return JSON.stringify({ category: cat });
      },
      chatCompletion: async (opts) => {
        if (input.aiGatewayUnreachable) {
          throw new Error("AI gateway unreachable: connection refused");
        }
        modelMessagesSeen.push([...opts.messages]);
        if (opts.tools && opts.tools.length > 0 && toolsOfferedFromRound.length === 0) {
          toolsOfferedFromRound = opts.tools.map((t) => t.function.name);
        }
        const currentRound = chatRound++;
        const roundsList =
          input.modelToolCallRounds ??
          (input.modelToolCalls && input.modelToolCalls.length > 0
            ? [input.modelToolCalls]
            : []);
        const configuredCalls = roundsList[currentRound] ?? [];
        const toolsAllowedThisCall = !opts.tools || opts.tools.length > 0;
        if (configuredCalls.length > 0 && toolsAllowedThisCall) {
          return {
            model: opts.model ?? "google/gemini-2.5-flash",
            message: {
              role: "assistant",
              content: null,
              tool_calls: configuredCalls.map((c, idx) => ({
                id: `call_r${currentRound + 1}_${idx + 1}`,
                type: "function" as const,
                function: {
                  name: c.name,
                  arguments: JSON.stringify(c.args ?? {}),
                },
              })),
            },
          };
        }
        return {
          model: opts.model ?? "google/gemini-2.5-flash",
          message: {
            role: "assistant",
            content: input.modelFinalText ?? "",
          },
        };
      },
    };

    const mockStore: Partial<StaffAssistantStoreDeps> = {
      checkQuestionBudget: async () =>
        input.budgetCheckResult ?? {
          allowed: true,
          remainingToday: 49,
          maxQuestionsPerDay: 50,
          maxModelRounds: 4,
          maxToolCalls: 6,
          maxDeepModelRounds: 8,
          maxDeepToolCalls: 12,
          modelFast: "google/gemini-2.5-flash",
          modelDeep: "google/gemini-2.5-pro",
          temperature: 0.2,
          maxTokens: 3200,
          maxCostUsdPerQuestion: 0.08,
        },
      getOrCreateConversation: async (_uid, convId) => ({
        id: convId ?? "11111111-2222-4333-8444-555555555555",
        status: "open",
        rollingSummary: null,
      }),
      loadRecentTurns: async () => input.recentTurns ?? [],
      listUserNotes: async () => input.userNotes ?? [],
      loadLatestReportPayload: async () => input.latestReportPayload ?? null,
      recordTurn: async (args) => {
        recordedToolsCalled = args.toolsCalled ?? [];
        return {
          userMessageId: "22222222-3333-4444-8555-666666666666",
          assistantMessageId: "33333333-4444-4555-8666-777777777777",
        };
      },
      recordUnanswered: async (entry) => {
        unansweredLogs.push({
          reason: entry.reason,
          errorCode: entry.errorCode ?? null,
          errorDetail: entry.errorDetail ?? null,
          questionText: entry.questionText,
        });
      },
      logAnalystQuery: async (entry) => {
        loggedAnalystQueries.push({
          question: entry.question,
          sqlText: entry.sqlText,
          executedSql: entry.executedSql,
          roleAreas: [...entry.roleAreas],
          rowCount: entry.rowCount,
          truncated: entry.truncated,
          status: entry.status,
          errorMessage: entry.errorMessage,
        });
      },
    };

    const rawBody = {
      action: input.action ?? "message",
      ...(input.action && input.action !== "message" ? {} : { message: input.userMessage }),
      ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
      ...(input.requestExtraFields ?? {}),
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (input.authenticated !== false) {
      headers.Authorization = "Bearer test-staff-jwt-token";
    }

    const req = new Request("https://welileapp.com/functions/v1/staff-assistant", {
      method: "POST",
      headers,
      body: JSON.stringify(rawBody),
    });

    const response = await handleStaffAssistantRequest(req, {
      // deno-lint-ignore no-explicit-any
      userClient: mockUserClient as any,
      aiClient: mockAiClient,
      store: mockStore,
      checkMfaAal2: async () => ({ ok: input.mfaAal2 !== false }),
    });

    const resBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const httpStatus = response.status;

    const outcome = (() => {
      if (httpStatus === 401) return "unauthorized";
      if (httpStatus === 400) return "invalid_request";
      if (typeof resBody.outcome === "string") {
        return resBody.outcome as ExecuteZoeTurnResult["outcome"];
      }
      return "error";
    })();

    const reply = String(resBody.reply ?? resBody.error ?? "");
    const toolsOffered =
      toolsOfferedFromRound.length > 0
        ? toolsOfferedFromRound
        : hasAccess && httpStatus === 200
        ? openAiToolsForRoles(input.callerRoles).map((t) => t.function.name)
        : [];

    return {
      httpStatus,
      outcome,
      reply,
      toolsOffered,
      toolsCalled: recordedToolsCalled,
      source: typeof resBody.source === "string" ? resBody.source : null,
      period: typeof resBody.period === "string" ? resBody.period : null,
      reportPayload:
        resBody.report_payload && typeof resBody.report_payload === "object"
          ? (resBody.report_payload as Record<string, unknown>)
          : null,
      mfaRequired: Boolean(resBody.mfa_required),
      emailsSentCount: 0,
      modelMessagesSeen,
      savedDrafts,
      loggedAnalystQueries,
      unansweredLogs,
      degradedErrorCodes: Array.from(
        new Set([
          ...(Array.isArray(resBody.degraded_error_codes)
            ? (resBody.degraded_error_codes as string[])
            : []),
          ...unansweredLogs
            .map((u) => u.errorCode)
            .filter((c): c is string => typeof c === "string" && c.length > 0),
        ]),
      ),
      databaseStatus:
        typeof resBody.database_status === "string" ? resBody.database_status : undefined,
      modelTier:
        resBody.model_tier === "deep" || resBody.model_tier === "fast"
          ? resBody.model_tier
          : undefined,
      consultantMode: Boolean(resBody.consultant_mode),
      statusSteps: Array.isArray(resBody.status_steps)
        ? (resBody.status_steps as string[])
        : undefined,
    };
  });
}
