// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  executeZoeTurn,
  FIXED_EVAL_DATE,
  handleStaffAssistantRequest,
  MSG,
} from "../../../../scripts/zoe-eval/runtime.ts";
import { ANALYST_OPEN_OFFER } from "../../../../supabase/functions/staff-assistant/messages.ts";
import { STATIC_SYSTEM_PROMPT_PREFIX } from "../../../../supabase/functions/staff-assistant/prompt.ts";

describe("Prompt 2 — Model Drift Detection, Gateway Model Logging & Analyst Open Offer", () => {
  it("logs both requested_model and actual gateway_model on every reply even when the gateway routes to gemini-3.8-flash", async () => {
    const recordedTurns: Array<Record<string, unknown>> = [];
    const recordedLearningLogs: Array<Record<string, unknown>> = [];

    const mockUserClient = {
      auth: {
        getUser: async () => ({
          data: { user: { id: "00000000-0000-4000-8000-000000000010", email: "jane@welile.com" } },
          error: null,
        }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: async () => ({
              data: [{ role: "tenant_ops" }],
              error: null,
            }),
          }),
        }),
      }),
      rpc: async (fnName: string) => {
        if (fnName === "staff_assistant_has_access") {
          return { data: true, error: null };
        }
        if (fnName === "staff_assistant_health") {
          return {
            data: {
              ok: true,
              status: "ok",
              missing_tables: [],
              missing_functions: [],
              missing_views: [],
              model_drift: {
                ok: true,
                drift_detected: true,
                checked_count: 8,
                mismatched_count: 8,
                configured_model_fast: "google/gemini-2.5-flash",
                configured_model_deep: "google/gemini-2.5-pro",
                dominant_gateway_model: "google/gemini-3.8-flash",
                warning_message:
                  "Model drift detected: 8 of the last 8 Zoe replies were answered by google/gemini-3.8-flash, which does not match staff_assistant_config (model_fast: google/gemini-2.5-flash, model_deep: google/gemini-2.5-pro).",
              },
            },
            error: null,
          };
        }
        return { data: {}, error: null };
      },
    };

    const req = new Request("https://example.supabase.co/functions/v1/staff-assistant", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-jwt-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "message",
        message: "Good morning Zoe, what can you help me with?",
      }),
    });

    const res = await handleStaffAssistantRequest(req, {
      userClient: mockUserClient as never,
      aiClient: {
        chatCompletion: async (opts) => ({
          message: {
            role: "assistant",
            content:
              "Good morning. I can help you check Tenant Ops reports, review your My Space tasks, or draft notes for your team.",
          },
          // Simulate the Lovable AI Gateway pre-routing gemini-2.5-flash -> gemini-3.8-flash
          model: "google/gemini-3.8-flash",
          usage: {
            promptTokens: 420,
            completionTokens: 28,
            totalTokens: 448,
            cachedTokens: 0,
            estimatedCostUsd: 0.00012,
          },
          ...(opts.model ? { requestedModel: opts.model } : {}),
        }),
      },
      store: {
        checkQuestionBudget: async () => ({
          allowed: true,
          remainingToday: 49,
          maxQuestionsPerDay: 50,
          maxModelRounds: 4,
          maxToolCalls: 6,
          webResearchEnabled: false,
          modelConfig: {
            modelFast: "google/gemini-2.5-flash",
            modelDeep: "google/gemini-2.5-pro",
            temperatureFast: 0.1,
            temperatureDeep: 0.15,
            maxTokensFast: 1100,
            maxTokensDeep: 2200,
            maxDeepModelRounds: 8,
            maxDeepToolCalls: 10,
            maxCostUsdPerQuestion: 0.05,
            promptCacheEnabled: true,
          },
        }),
        getOrCreateConversation: async () => ({
          id: "00000000-0000-4000-8000-000000000099",
          status: "open",
          memory: { entries: [] },
          rollingSummary: "",
        }),
        loadRecentTurns: async () => [],
        recordTurn: async (turnArgs) => {
          recordedTurns.push(turnArgs as unknown as Record<string, unknown>);
          return { assistantMessageId: "00000000-0000-4000-8000-000000000100" };
        },
        recordLearningLogEntry: async (logArgs) => {
          recordedLearningLogs.push(logArgs as unknown as Record<string, unknown>);
        },
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.outcome).toBe("answered");
    expect(body.requested_model).toBe("google/gemini-2.5-flash");
    expect(body.gateway_model).toBe("google/gemini-3.8-flash");

    expect(recordedTurns).toHaveLength(1);
    expect(recordedTurns[0].requestedModel).toBe("google/gemini-2.5-flash");
    expect(recordedTurns[0].gatewayModel).toBe("google/gemini-3.8-flash");
    expect(recordedTurns[0].model).toBe("google/gemini-3.8-flash");

    expect(recordedLearningLogs).toHaveLength(1);
    expect(recordedLearningLogs[0].requestedModel).toBe("google/gemini-2.5-flash");
    expect(recordedLearningLogs[0].gatewayModel).toBe("google/gemini-3.8-flash");
  });

  it("exposes action: 'health' and action: 'check_model_drift' with admin-visible drift warnings when gateway_model != staff_assistant_config", async () => {
    const mockDriftPayload = {
      ok: true,
      source: "staff_assistant_check_model_drift",
      sample_limit: 50,
      checked_count: 8,
      mismatched_count: 8,
      drift_detected: true,
      configured_model_fast: "google/gemini-2.5-flash",
      configured_model_deep: "google/gemini-2.5-pro",
      dominant_gateway_model: "google/gemini-3.8-flash",
      observed_models: [
        {
          gateway_model: "google/gemini-3.8-flash",
          requested_model: "google/gemini-3-flash-preview",
          reply_count: 8,
          matches_config: false,
          last_seen_at: "2026-11-04T09:05:00Z",
        },
      ],
      warning_message:
        "Model drift detected: 8 of the last 8 Zoe replies were answered by google/gemini-3.8-flash, which does not match staff_assistant_config (model_fast: google/gemini-2.5-flash, model_deep: google/gemini-2.5-pro).",
    };

    const mockUserClient = {
      auth: {
        getUser: async () => ({
          data: { user: { id: "00000000-0000-4000-8000-000000000010", email: "crm@welile.com" } },
          error: null,
        }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: async () => ({
              data: [{ role: "crm" }],
              error: null,
            }),
          }),
        }),
      }),
      rpc: async (fnName: string) => {
        if (fnName === "staff_assistant_has_access") {
          return { data: true, error: null };
        }
        if (fnName === "staff_assistant_health") {
          return {
            data: {
              ok: true,
              status: "ok",
              missing_tables: [],
              missing_functions: [],
              missing_views: [],
              model_drift: mockDriftPayload,
            },
            error: null,
          };
        }
        if (fnName === "staff_assistant_check_model_drift") {
          return { data: mockDriftPayload, error: null };
        }
        return { data: {}, error: null };
      },
    };

    const healthReq = new Request("https://example.supabase.co/functions/v1/staff-assistant", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-jwt-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "health" }),
    });
    const healthRes = await handleStaffAssistantRequest(healthReq, {
      userClient: mockUserClient as never,
    });
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as {
      ok: boolean;
      database_status: string;
      model_drift: typeof mockDriftPayload;
    };
    expect(healthJson.ok).toBe(true);
    expect(healthJson.database_status).toBe("ok");
    expect(healthJson.model_drift.drift_detected).toBe(true);
    expect(healthJson.model_drift.dominant_gateway_model).toBe("google/gemini-3.8-flash");
    expect(healthJson.model_drift.warning_message).toContain("Model drift detected");

    const driftReq = new Request("https://example.supabase.co/functions/v1/staff-assistant", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-jwt-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "check_model_drift", limit: 50 }),
    });
    const driftRes = await handleStaffAssistantRequest(driftReq, {
      userClient: mockUserClient as never,
    });
    expect(driftRes.status).toBe(200);
    const driftJson = (await driftRes.json()) as typeof mockDriftPayload;
    expect(driftJson.drift_detected).toBe(true);
    expect(driftJson.mismatched_count).toBe(8);
    expect(driftJson.configured_model_fast).toBe("google/gemini-2.5-flash");
  });

  it("openly offers the Analyst lane ('I can look that up directly, with the usual checks — want me to try?') when no fixed report fits, and executes zoe_ro lookup when accepted", async () => {
    expect(ANALYST_OPEN_OFFER).toBe(
      "I can look that up directly, with the usual checks — want me to try?",
    );
    expect(MSG.unmatched).toContain(ANALYST_OPEN_OFFER);
    expect(MSG.refuseUnmatched("How many active Rent Plans are in Wakiso vs Mukono?")).toContain(
      ANALYST_OPEN_OFFER,
    );
    expect(STATIC_SYSTEM_PROMPT_PREFIX).toContain(ANALYST_OPEN_OFFER);

    // 1. Unmatched fixed-report question offers the Analyst lane + follow-up suggestion
    const unmatchedOfferTurn = await executeZoeTurn({
      callerRoles: ["tenant_ops"],
      userMessage: "Compare active Rent Plans in Wakiso vs Mukono by payment status.",
      modelToolCalls: [],
      modelFinalText:
        "REFUSE_UNMATCHED: I don't have a fixed report that splits Wakiso vs Mukono by payment status, and I won't guess a number. I can look that up directly, with the usual checks — want me to try? Or you can check /tenant-ops.",
    });
    expect(unmatchedOfferTurn.outcome).toBe("unmatched");
    expect(unmatchedOfferTurn.reply).toContain(ANALYST_OPEN_OFFER);
    expect(unmatchedOfferTurn.followUpSuggestions).toEqual([
      "Yes — I can look that up directly, with the usual checks",
    ]);

    // 2. When the staff member says yes, Zoe runs get_data_catalog + run_analyst_query and labels it "Ad hoc, not certified"
    const analystTurn = await executeZoeTurn({
      callerRoles: ["tenant_ops"],
      userMessage: "Yes — look that up directly, with the usual checks.",
      modelToolCalls: [
        { name: "get_data_catalog", args: { area: "operations" } },
        {
          name: "run_analyst_query",
          args: {
            question: "Active Rent Plans by stage in operations",
            sql: "SELECT stage, SUM(plans_count) AS total_plans FROM zoe_ro.operations_rent_plans_by_stage GROUP BY stage",
          },
        },
      ],
      rpcDataByTool: {
        get_data_catalog: {
          source: "assistant_staff_get_data_catalog",
          period: { as_of: FIXED_EVAL_DATE },
          views: [{ view_name: "zoe_ro.operations_rent_plans_by_stage", role_area: "operations" }],
        },
        run_analyst_query: {
          source: "assistant_staff_run_query",
          period: { as_of: FIXED_EVAL_DATE },
          sql: "SELECT stage, SUM(plans_count) AS total_plans FROM zoe_ro.operations_rent_plans_by_stage GROUP BY stage",
          executed_sql:
            "SELECT * FROM (SELECT stage, SUM(plans_count) AS total_plans FROM zoe_ro.operations_rent_plans_by_stage GROUP BY stage) AS _zoe_q LIMIT 500",
          row_count: 2,
          rows: [
            { stage: "active", total_plans: 142 },
            { stage: "completed", total_plans: 38 },
          ],
        },
      },
      modelFinalText:
        "From `zoe_ro.operations_rent_plans_by_stage`, there are 142 active Rent Plans and 38 completed Rent Plans.",
    });

    expect(analystTurn.outcome).toBe("answered");
    expect(analystTurn.toolsCalled).toEqual(["get_data_catalog", "run_analyst_query"]);
    expect(analystTurn.reply).toContain("Ad hoc, not certified");
    expect(analystTurn.reply).toContain("142 active Rent Plans");
  });
});
