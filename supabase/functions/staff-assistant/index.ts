import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireStaffAal2 } from "../_shared/staffMfa.ts";
import { kampalaToday } from "./dates.ts";
import { checkAnswer } from "./guards.ts";
import { MSG } from "./messages.ts";
import { chatCompletion, ChatMessage, classifyText } from "./openai.ts";
import { buildSystemPrompt, SCOPE_CHECK_PROMPT } from "./prompt.ts";
import { RequestSchema } from "./schemas.ts";
import {
  checkQuestionBudget,
  clearUserHistory,
  getAdminClientForMfa,
  getOrCreateConversation,
  loadConversationHistory,
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

export function formatPeriodLabel(period: unknown): string | null {
  if (!period || typeof period !== "object") return null;
  const p = period as Record<string, unknown>;
  if (typeof p.from === "string" && typeof p.to === "string") {
    return p.from === p.to ? p.from : `${p.from} to ${p.to}`;
  }
  if (typeof p.as_of === "string") return `as of ${p.as_of}`;
  if (typeof p.service_date === "string") return p.service_date;
  if (typeof p.anchor === "string") return `week of ${p.anchor}`;
  return null;
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
            tool: tool.name,
            rpc: tool.rpc,
            source: payload.source ?? tool.rpc,
            period: payload.period ?? null,
            row_count: payload.row_count ?? null,
            rows: Array.isArray(payload.rows) ? payload.rows.slice(0, 50) : [],
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
