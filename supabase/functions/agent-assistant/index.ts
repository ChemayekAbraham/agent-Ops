/**
 * agent-assistant — a READ-ONLY personal assistant for agents, answering questions about the
 * signed-in agent's own account (wallet, collections, tenants, advances).
 *
 * Trust model (see docs in each module):
 *   - Identity is the verified JWT. Nothing the client sends can name another user.
 *   - Data is read ONLY through `assistant_agent_*` RPCs called with the user's own JWT, so
 *     auth.uid() and RLS apply. The service role is confined to store.ts (the CRM log).
 *   - The model only ever REQUESTS tools from a fixed registry; this code validates and runs
 *     them. Unknown tool, bad arguments, too many calls -> the turn is aborted.
 *   - Conversation history and session ids are owned by the server.
 *   - The model's final answer is checked against the tool results before it is returned.
 */
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { RequestSchema } from "./schemas.ts";
import { CLARIFICATION_TOOL, findTool, openAiTools } from "./tools.ts";
import { callModel, type ChatMessage, ModelError } from "./openai.ts";
import { buildSystemPrompt, SCOPE_CHECK_PROMPT } from "./prompt.ts";
import { checkAnswer } from "./guards.ts";
import { ESCALATION_OFFER_OUTCOMES, MSG } from "./messages.ts";
import { kampalaToday } from "./dates.ts";
import { getClientUserAgent, resolveTrustedClientIp } from "../_shared/resolveClientIp.ts";
import { classifyDevice } from "../_shared/deviceClass.ts";
import {
  createEscalation,
  getOwnedConversation,
  isRateLimited,
  loadHistory,
  logMessage,
  type Outcome,
  resolveConversation,
  touchConversation,
} from "./store.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_BODY_BYTES = 8 * 1024;
const MAX_MODEL_ROUNDS = 4;
const MAX_CALLS_PER_ROUND = 3;
const MAX_TOOL_CALLS = 6;
const MAX_TOOL_RESULT_CHARS = 6000;
const MAX_ANSWER_CHARS = 1200;
/** Without any tool result, an answer can only be a short greeting or refusal. */
const MAX_UNGROUNDED_CHARS = 300;

interface TurnResult {
  reply: string;
  outcome: Outcome;
  toolsCalled: string[];
  model?: string;
  quickReplies?: string[];
  escalationOffered?: boolean;
}

class NotAnAgentError extends Error {}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Cheap pre-check on the user's message alone; it never sees any account data. */
async function scopeCheck(
  message: string,
  lastAssistant: string | undefined,
): Promise<"in_scope" | "out_of_scope" | "wants_human"> {
  if (Deno.env.get("ASSISTANT_SCOPE_PRECHECK") === "off") return "in_scope";
  // A tapped quick reply or a short follow-up ("yesterday") only makes sense with the question
  // it answers, so the assistant's previous message is passed as context.
  const content = lastAssistant
    ? `Previous assistant message: ${lastAssistant.slice(0, 300)}\n\nMessage to classify: ${message}`
    : `Message to classify: ${message}`;
  const { message: m } = await callModel({
    messages: [
      { role: "system", content: SCOPE_CHECK_PROMPT },
      { role: "user", content },
    ],
    json: true,
    maxTokens: 30,
  });
  const parsed = safeParse(m.content ?? "") as { category?: string } | undefined;
  const c = parsed?.category;
  // Anything unexpected is treated as out of scope (fail closed).
  return c === "in_scope" || c === "wants_human" ? c : "out_of_scope";
}

function blocked(toolsCalled: string[], model?: string, reason?: string): TurnResult {
  console.error(`[agent-assistant] blocked: ${reason ?? "unspecified"}`);
  return { reply: MSG.unmatched, outcome: "blocked", toolsCalled, model };
}

async function runTurn(
  userClient: SupabaseClient,
  history: { role: "user" | "assistant"; content: string }[],
  message: string,
): Promise<TurnResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(kampalaToday()) },
    ...history,
    { role: "user", content: message },
  ];
  const toolsCalled: string[] = [];
  const toolOutputs: string[] = [];
  let model: string | undefined;
  let totalCalls = 0;

  for (let round = 0; round < MAX_MODEL_ROUNDS; round++) {
    const reply = await callModel({ messages, tools: openAiTools() });
    model = reply.model;
    const calls = reply.message.tool_calls ?? [];

    if (!calls.length) {
      let text = (reply.message.content ?? "").trim();
      if (!text) return { reply: MSG.unmatched, outcome: "unmatched", toolsCalled, model };
      if (/^OUT_OF_SCOPE\b/.test(text)) return { reply: MSG.outOfScope, outcome: "out_of_scope", toolsCalled, model };

      text = text.slice(0, MAX_ANSWER_CHARS);
      if (!toolsCalled.length && text.length > MAX_UNGROUNDED_CHARS) {
        return blocked(toolsCalled, model, "long answer with no tool results");
      }
      // Figures given in earlier turns already passed this guard, so they may be restated.
      const verdict = checkAnswer(text, [...toolOutputs, ...history.map((h) => h.content)], message);
      if (!verdict.ok) return blocked(toolsCalled, model, `output guard: ${verdict.reason}`);
      return { reply: text, outcome: "answered", toolsCalled, model };
    }

    if (calls.length > MAX_CALLS_PER_ROUND) return blocked(toolsCalled, model, "too many tool calls in one round");
    messages.push({ role: "assistant", content: reply.message.content ?? null, tool_calls: calls });

    for (const call of calls) {
      if (++totalCalls > MAX_TOOL_CALLS) return blocked(toolsCalled, model, "tool call cap");
      const name = call.function.name;
      const rawArgs = safeParse(call.function.arguments || "{}");

      if (name === CLARIFICATION_TOOL.name) {
        const parsed = CLARIFICATION_TOOL.schema.safeParse(rawArgs);
        if (!parsed.success) return blocked(toolsCalled, model, "bad clarification arguments");
        return {
          reply: parsed.data.question,
          outcome: "clarify",
          toolsCalled,
          model,
          quickReplies: parsed.data.options,
        };
      }

      const tool = findTool(name);
      if (!tool) return blocked(toolsCalled, model, `unknown tool: ${name.slice(0, 60)}`);

      const args = tool.schema.safeParse(rawArgs ?? {});
      if (!args.success) return blocked(toolsCalled, model, `invalid arguments for ${name}`);

      // Runs as the signed-in user. The RPC derives identity from auth.uid(); no id is passed.
      const { data, error } = await userClient.rpc(tool.rpc, tool.toRpcArgs(args.data));
      toolsCalled.push(name);

      let content: string;
      if (error) {
        if (error.message?.includes("not_an_agent")) throw new NotAnAgentError();
        if (/invalid_(range|direction|status)/.test(error.message ?? "")) {
          content = JSON.stringify({ error: "That range is not allowed (no future dates, at most 92 days)." });
        } else {
          throw new Error(`tool ${name} failed: ${error.message}`);
        }
      } else {
        // Wrapped so the model treats it as data, never as instructions.
        content = JSON.stringify({ untrusted_data: data }).slice(0, MAX_TOOL_RESULT_CHARS);
      }
      toolOutputs.push(content);
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }

  return { reply: MSG.unmatched, outcome: "unmatched", toolsCalled, model };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    // --- authenticate: verified against the auth server, not just decoded ---------------------
    const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: MSG.unauthorized }, 401);
    const token = authHeader.slice("Bearer ".length).trim();

    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: authError } = await userClient.auth.getUser(token);
    const user = userData?.user;
    if (authError || !user) return json({ error: MSG.unauthorized }, 401);

    // --- validate the request ----------------------------------------------------------------
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: MSG.invalidRequest }, 413);
    const parsed = RequestSchema.safeParse(safeParse(raw));
    if (!parsed.success) return json({ error: MSG.invalidRequest }, 400);
    const request = parsed.data;

    if (await isRateLimited(user.id)) {
      return json({ reply: MSG.rateLimited, outcome: "rate_limited", escalation_offered: false }, 429);
    }

    // --- the agent gate: no record in agent_collections, no assistant ------------------------
    const { data: isAgent, error: gateError } = await userClient.rpc("assistant_is_agent");
    if (gateError) throw new Error(`gate check failed: ${gateError.message}`);
    const startedAt = Date.now();

    if (request.action === "escalate") {
      if (!isAgent) return json({ reply: MSG.notAnAgent, outcome: "not_an_agent", escalation_offered: false });
      const owned = await getOwnedConversation(user.id, request.conversation_id);
      if (!owned) return json({ error: MSG.invalidRequest }, 404);
      const { created } = await createEscalation(user.id, owned.id, request.note);
      if (created) await touchConversation(owned.id, { escalated: true }).catch(() => {});
      return json({
        conversation_id: owned.id,
        reply: created ? MSG.escalated : MSG.alreadyEscalated,
        outcome: "answered",
        escalation_offered: false,
      });
    }

    // --- a message turn ----------------------------------------------------------------------
    // IP uses the shared trusted-header rule (cf-connecting-ip first; never a client-set header
    // on its own). GPS / device details are client-reported and stored only as hints.
    const userAgent = getClientUserAgent(req);
    const device = classifyDevice(userAgent);
    const conversation = await resolveConversation(user.id, request.conversation_id, {
      ip: resolveTrustedClientIp(req),
      userAgent,
      device: { deviceClass: device.deviceClass, browser: device.browser, os: device.os },
      clientDevice: request.client_context?.device,
      geo: request.client_context?.geo,
    });
    const history = isAgent ? await loadHistory(conversation.id) : [];
    await logMessage({ conversationId: conversation.id, userId: user.id, role: "user", content: request.message });

    let turn: TurnResult;
    if (!isAgent) {
      turn = { reply: MSG.notAnAgent, outcome: "not_an_agent", toolsCalled: [] };
    } else {
      try {
        const lastAssistant = [...history].reverse().find((h) => h.role === "assistant")?.content;
        const scope = await scopeCheck(request.message, lastAssistant);
        if (scope === "out_of_scope") {
          turn = { reply: MSG.outOfScope, outcome: "out_of_scope", toolsCalled: [] };
        } else if (scope === "wants_human") {
          turn = { reply: MSG.wantsHuman, outcome: "answered", toolsCalled: [], escalationOffered: true };
        } else {
          turn = await runTurn(userClient, history, request.message);
        }
      } catch (e) {
        if (e instanceof NotAnAgentError) {
          turn = { reply: MSG.notAnAgent, outcome: "not_an_agent", toolsCalled: [] };
        } else {
          console.error("[agent-assistant] turn failed", e instanceof ModelError ? e.message : e);
          turn = { reply: MSG.error, outcome: "error", toolsCalled: [] };
        }
      }
    }

    await logMessage({
      conversationId: conversation.id,
      userId: user.id,
      role: "assistant",
      content: turn.reply,
      outcome: turn.outcome,
      toolsCalled: turn.toolsCalled,
      model: turn.model,
      latencyMs: Date.now() - startedAt,
    });
    await touchConversation(conversation.id, { messageCount: conversation.messageCount + 2 }).catch(() => {});

    return json({
      conversation_id: conversation.id,
      reply: turn.reply,
      outcome: turn.outcome,
      quick_replies: turn.quickReplies ?? [],
      escalation_offered: turn.escalationOffered ?? ESCALATION_OFFER_OUTCOMES.has(turn.outcome),
    });
  } catch (e) {
    console.error("[agent-assistant] unhandled", e);
    return json({ reply: MSG.error, outcome: "error", escalation_offered: false }, 500);
  }
});
