import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireStaffAal2 } from "../_shared/staffMfa.ts";
import {
  buildReminderDraft,
  buildReportScheduleDraft,
  buildStaffNotificationDraft,
} from "./actionDrafts.ts";
import { formatPeriodLabel, kampalaToday } from "./dates.ts";
import {
  buildReportEmailDraft,
  extractRecipientQuery,
  isEmailFromToolData,
  normalizeStaffRecipients,
} from "./emailDraft.ts";
import { checkAnswer } from "./guards.ts";
import { MSG } from "./messages.ts";
import { buildMorningBriefForCaller } from "./morningBrief.ts";
import { chatCompletion, ChatMessage, classifyText } from "./openai.ts";
import { buildSystemPrompt, SCOPE_CHECK_PROMPT } from "./prompt.ts";
import { RequestSchema } from "./schemas.ts";
import {
  checkQuestionBudget,
  clearUserHistory,
  getAdminClientForMfa,
  getOrCreateConversation,
  loadConversationHistory,
  loadLatestReportPayload,
  loadRecentTurns,
  recordTurn,
  recordUnanswered,
  saveFeedback,
  SessionMeta,
  TurnOutcome,
  UnansweredReason,
} from "./store.ts";
import {
  canUseTool,
  ClarificationArgsSchema,
  describeToolsForRoles,
  DraftReminderArgsSchema,
  DraftReportEmailArgsSchema,
  DraftReportScheduleArgsSchema,
  DraftStaffNotificationArgsSchema,
  findTool,
  openAiToolsForRoles,
} from "./tools.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MAX_MODEL_ROUNDS = 4;
const MAX_CALLS_PER_ROUND = 3;
const MAX_TOOL_CALLS = 6;
const MAX_TOOL_RESULT_CHARS = 16_000;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseCategory(raw: string): "in_scope" | "out_of_scope" {
  const m = raw.match(/"category"\s*:\s*"(in_scope|out_of_scope)"/);
  return (m?.[1] as "in_scope" | "out_of_scope" | undefined) ?? "in_scope";
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: MSG.invalidRequest });

  const startedAt = Date.now();

  // ---- 1. Authenticate caller from Authorization Bearer JWT only -----------------------------
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json(401, { error: MSG.unauthorized });
  }
  const token = authHeader.slice("Bearer ".length).trim();

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  // This client carries the caller's own JWT. Every `assistant_staff_*` RPC is called on THIS
  // client so `auth.uid()` inside PostgreSQL is always the signed-in staff member.
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

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

  // ---- 4. Non-chat utility actions (history, clear_history, feedback) ------------------------
  if (body.action === "history") {
    const history = await loadConversationHistory(user.id, body.conversation_id, body.limit ?? 30);
    return json(200, history);
  }

  if (body.action === "clear_history") {
    await clearUserHistory(user.id, body.conversation_id);
    return json(200, { ok: true, reply: MSG.historyCleared });
  }

  if (body.action === "feedback") {
    const res = await saveFeedback({
      conversationId: body.conversation_id,
      messageId: body.message_id,
      userId: user.id,
      rating: body.rating,
      comment: body.comment,
    });
    if (!res.ok) return json(404, { error: MSG.invalidRequest });
    return json(200, { ok: true, reply: MSG.feedbackSaved });
  }

  if (body.action === "morning_brief") {
    const callerRoles = await resolveCallerRoles(userClient, user.id);
    const brief = await buildMorningBriefForCaller({
      callerRoles,
      force: body.force,
      runTool: async (tool) => {
        if (!canUseTool(tool, callerRoles)) return null;
        if (tool.sensitive) {
          const mfaGate = await requireStaffAal2(getAdminClientForMfa(), token, user.id);
          if (!mfaGate.ok) return null;
        }
        const parsedArgs = tool.schema.safeParse({});
        const rpcArgs = tool.toRpcArgs(parsedArgs.success ? parsedArgs.data : {});
        const { data, error } = await userClient.rpc(tool.rpc, rpcArgs);
        if (error || !data || typeof data !== "object" || Array.isArray(data)) {
          return null;
        }
        return data as Record<string, unknown>;
      },
    });
    return json(200, { ok: true, morning_brief: brief });
  }

  // ---- 5. Requirement (d): Daily question budget & burst rate limit --------------------------
  const budget = await checkQuestionBudget(user.id);
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
  const callerRoles = await resolveCallerRoles(userClient, user.id);
  const allowedOpenAiTools = openAiToolsForRoles(callerRoles);
  const toolDescriptions = describeToolsForRoles(callerRoles);

  const conv = await getOrCreateConversation(user.id, body.conversation_id, sessionMeta);
  const userText = body.message;

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
      unansweredReason?: UnansweredReason;
      mfaRequired?: boolean;
    },
  ) => {
    const { assistantMessageId } = await recordTurn({
      conversationId: conv.id,
      userId: user.id,
      userMessage: userText,
      assistantMessage: reply,
      outcome,
      toolsCalled: opts?.tools,
      sourceLabel: opts?.sourceLabel ?? null,
      periodLabel: opts?.periodLabel ?? null,
      reportPayload: opts?.reportPayload ?? null,
      model: opts?.model,
      latencyMs: Date.now() - startedAt,
    });

    if (opts?.unansweredReason) {
      await recordUnanswered({
        conversationId: conv.id,
        messageId: assistantMessageId,
        userId: user.id,
        callerRoles,
        questionText: userText,
        reason: opts.unansweredReason,
      });
    }

    return json(200, {
      conversation_id: conv.id,
      message_id: assistantMessageId,
      reply,
      outcome,
      clarification: opts?.clarification ?? null,
      source: opts?.sourceLabel ?? null,
      period: opts?.periodLabel ?? null,
      report_payload: opts?.reportPayload ?? null,
      mfa_required: opts?.mfaRequired ?? false,
      remaining_questions_today: budget.remainingToday,
    });
  };

  try {
    // ---- 7. Cheap scope pre-check (no data, no tools) ----------------------------------------
    const scopeRaw = await classifyText(SCOPE_CHECK_PROMPT, userText);
    const scope = parseCategory(scopeRaw);
    if (scope === "out_of_scope") {
      return await finish(MSG.outOfScope, "out_of_scope", {
        unansweredReason: "out_of_scope",
      });
    }

    // ---- 8. Tool-calling loop (Requirement c, d, f, g) ---------------------------------------
    const history = await loadRecentTurns(user.id, conv.id);
    const today = kampalaToday();
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(today, callerRoles, toolDescriptions),
      },
      ...history,
      { role: "user", content: userText },
    ];

    const toolsCalled: string[] = [];
    const rawToolOutputs: string[] = [];
    const sourcesUsed: string[] = [];
    const periodsUsed: string[] = [];
    let lastReportPayload: Record<string, unknown> | null = null;
    let lastModel = "";
    let finalText: string | null = null;

    for (let round = 0; round < MAX_MODEL_ROUNDS; round++) {
      const { message, model } = await chatCompletion({
        messages,
        tools: allowedOpenAiTools,
      });
      lastModel = model;

      if (!message.tool_calls || message.tool_calls.length === 0) {
        finalText = (message.content ?? "").trim();
        break;
      }

      const calls = message.tool_calls.slice(0, MAX_CALLS_PER_ROUND);
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });

      for (const call of calls) {
        if (toolsCalled.length >= MAX_TOOL_CALLS) {
          return await finish(MSG.unmatched, "unmatched", {
            tools: toolsCalled,
            model: lastModel,
            unansweredReason: "unmatched",
          });
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

          // Rule: Never use an email address found in data
          if (isEmailFromToolData(d.data.recipient_search, rawToolOutputs, userText)) {
            return await finish(MSG.dataEmailForbidden, "blocked", {
              tools: [...toolsCalled, "draft_report_email"],
              model: lastModel,
              unansweredReason: "role_restricted",
            });
          }

          // Ensure we have a report payload (either from this turn, from report_tool, or from conversation history)
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
              const mfaGate = await requireStaffAal2(getAdminClientForMfa(), token, user.id);
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
              return await finish(MSG.error, "error", {
                tools: toolsCalled,
                model: lastModel,
                unansweredReason: "error",
              });
            }
            toolsCalled.push(repTool.name);
            rawToolOutputs.push(JSON.stringify(repData ?? {}).slice(0, MAX_TOOL_RESULT_CHARS));
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
            lastReportPayload = await loadLatestReportPayload(user.id, conv.id);
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
                  options: [
                    "My tasks and tickets",
                    "My payslips",
                  ],
                },
              },
            );
          }

          const combinedRawOutputs = [...rawToolOutputs, JSON.stringify(lastReportPayload)];
          if (isEmailFromToolData(d.data.recipient_search, combinedRawOutputs, userText)) {
            return await finish(MSG.dataEmailForbidden, "blocked", {
              tools: [...toolsCalled, "draft_report_email"],
              model: lastModel,
              unansweredReason: "role_restricted",
            });
          }

          // Look up recipient ONLY through staff_assistant_email_recipients with caller's JWT
          const recipientQuery = extractRecipientQuery(d.data.recipient_search);
          const { data: recipientRows, error: recipientErr } = await userClient.rpc(
            "staff_assistant_email_recipients",
            { p_search: recipientQuery },
          );
          if (recipientErr) {
            return await finish(MSG.error, "error", {
              tools: [...toolsCalled, "draft_report_email"],
              model: lastModel,
              unansweredReason: "error",
            });
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

        // Action tool: draft_reminder (NEVER writes to DB; returns draft card for user click)
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

        // Action tool: draft_staff_notification (NEVER writes to notifications; looks up recipient ONLY via staff_assistant_email_recipients)
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

          const recipientQuery = extractRecipientQuery(n.data.recipient_search);
          const { data: recipientRows, error: recipientErr } = await userClient.rpc(
            "staff_assistant_email_recipients",
            { p_search: recipientQuery },
          );
          if (recipientErr) {
            return await finish(MSG.error, "error", {
              tools: [...toolsCalled, "draft_staff_notification"],
              model: lastModel,
              unansweredReason: "error",
            });
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

        // Action tool: draft_report_schedule (NEVER stores or sends; looks up recipient ONLY via staff_assistant_email_recipients)
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
              const mfaGate = await requireStaffAal2(getAdminClientForMfa(), token, user.id);
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
              return await finish(MSG.error, "error", {
                tools: toolsCalled,
                model: lastModel,
                unansweredReason: "error",
              });
            }
            toolsCalled.push(repTool.name);
            rawToolOutputs.push(JSON.stringify(repData ?? {}).slice(0, MAX_TOOL_RESULT_CHARS));
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
            lastReportPayload = await loadLatestReportPayload(user.id, conv.id);
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

          const combinedOutputs = [...rawToolOutputs, JSON.stringify(lastReportPayload)];
          if (isEmailFromToolData(s.data.recipient_search, combinedOutputs, userText)) {
            return await finish(MSG.dataEmailForbidden, "blocked", {
              tools: [...toolsCalled, "draft_report_schedule"],
              model: lastModel,
              unansweredReason: "role_restricted",
            });
          }

          const recipientQuery = extractRecipientQuery(s.data.recipient_search);
          const { data: recipientRows, error: recipientErr } = await userClient.rpc(
            "staff_assistant_email_recipients",
            { p_search: recipientQuery },
          );
          if (recipientErr) {
            return await finish(MSG.error, "error", {
              tools: [...toolsCalled, "draft_report_schedule"],
              model: lastModel,
              unansweredReason: "error",
            });
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

        // Requirement (g): Sensitive tools require AAL2 MFA via requireStaffAal2
        if (tool.sensitive) {
          const mfaGate = await requireStaffAal2(getAdminClientForMfa(), token, user.id);
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
        const { data, error } = await userClient.rpc(tool.rpc, rpcArgs);
        if (error) {
          console.error(`[staff-assistant] tool ${tool.rpc} error:`, error.code, error.message);
          if (error.code === "42501") {
            return await finish(MSG.roleRestricted, "not_staff", {
              tools: toolsCalled,
              model: lastModel,
              unansweredReason: "role_restricted",
            });
          }
          return await finish(MSG.error, "error", {
            tools: toolsCalled,
            model: lastModel,
            unansweredReason: "error",
          });
        }

        const serialized = JSON.stringify(data ?? {}).slice(0, MAX_TOOL_RESULT_CHARS);
        toolsCalled.push(tool.name);
        rawToolOutputs.push(serialized);

        if (data && typeof data === "object" && !Array.isArray(data)) {
          const payload = data as Record<string, unknown>;
          if (typeof payload.source === "string" && payload.source.trim()) {
            if (!sourcesUsed.includes(payload.source)) sourcesUsed.push(payload.source);
          }
          const pLabel = formatPeriodLabel(payload.period);
          if (pLabel && !periodsUsed.includes(pLabel)) {
            periodsUsed.push(pLabel);
          }
          lastReportPayload = {
            ...payload,
            tool: tool.name,
            rpc: tool.rpc,
            args: args.data,
            source: payload.source ?? tool.rpc,
            period: payload.period ?? null,
            row_count: payload.row_count ?? null,
            rows: Array.isArray(payload.rows) ? payload.rows.slice(0, 200) : [],
            data: payload.data ?? null,
          };
        }

        messages.push({ role: "tool", tool_call_id: call.id, content: serialized });
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

    // Any real answer must come from at least one read-only tool call
    if (toolsCalled.length === 0) {
      return await finish(MSG.unmatched, "unmatched", {
        model: lastModel,
        unansweredReason: "missing_tool",
      });
    }

    const sourceLabel = sourcesUsed.length > 0 ? sourcesUsed.join(" + ") : null;
    const periodLabel = periodsUsed.length > 0 ? periodsUsed.join(", ") : today;

    // Ensure Source and Period are always explicitly named on every answer (Requirement f)
    let answerWithCitation = finalText;
    if (sourceLabel && !answerWithCitation.toLowerCase().includes("source:")) {
      answerWithCitation = `${answerWithCitation}\n\nSource: ${sourceLabel} · Period: ${periodLabel}`;
    }

    // Requirement (d): Deterministic post-generation guard against tool results
    const guard = checkAnswer(
      answerWithCitation,
      [...rawToolOutputs, JSON.stringify({ source: sourceLabel, period: periodLabel })],
      userText,
    );
    if (!guard.ok) {
      console.warn(`[staff-assistant] output guard blocked answer: ${guard.reason}`);
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
    console.error("[staff-assistant] unhandled error:", err instanceof Error ? err.message : err);
    return await finish(MSG.error, "error", {
      unansweredReason: "error",
    });
  }
});
