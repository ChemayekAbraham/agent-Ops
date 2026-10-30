import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runPrompt1ParityAndResilienceEval,
  SEVEN_MISSING_FUNCTIONS_LIST,
  TEN_DATA_UNAVAILABLE_WELILE_QUESTIONS_PACK,
  TWENTY_GENERAL_QUESTIONS_PACK,
} from "../../../../scripts/zoe-eval/realWorldEvalPack.ts";
import {
  checkAnswer,
  checkStaffAssistantHealth,
  executeZoeTurn,
  MSG,
  resetStaffAssistantHealthCacheForTest,
  ZOE_ERROR_CODES,
} from "../../../../scripts/zoe-eval/runtime.ts";

const ROOT = resolve(__dirname, "../../../..");

describe("Prompt 1 — Database Parity Guard, Missing-Function Resilience & Plain-Text Fallback", () => {
  it("survives each of the 7 missing database functions one at a time in real handleStaffAssistantRequest", async () => {
    expect(SEVEN_MISSING_FUNCTIONS_LIST).toHaveLength(7);

    const summary = await runPrompt1ParityAndResilienceEval();
    expect(summary.missingFunctionsTested).toBe(7);
    expect(summary.missingFunctionsPassed).toBe(7);

    for (const res of summary.missingFunctionResults) {
      expect(res.generalQuestionAnswered).toBe(true);
      expect(res.noRawErrorShown).toBe(true);
      expect(res.errorCodeLogged).toBe(true);
      expect(res.passed).toBe(true);
    }
  });

  it("answers all 20 general questions normally without showing MSG.error even when optional DB objects are missing", async () => {
    expect(TWENTY_GENERAL_QUESTIONS_PACK).toHaveLength(20);

    // Confirm the 4 example questions from Prompt 1 are included
    const questionsLower = TWENTY_GENERAL_QUESTIONS_PACK.map((q) => q.question.toLowerCase());
    expect(questionsLower.some((q) => q.includes("what is receivables"))).toBe(true);
    expect(questionsLower.some((q) => q.includes("explain like i'm five"))).toBe(true);
    expect(questionsLower.some((q) => q.includes("draft a polite reminder"))).toBe(true);
    expect(questionsLower.some((q) => q.includes("what does iterative mean"))).toBe(true);

    for (const gq of TWENTY_GENERAL_QUESTIONS_PACK) {
      const turn = await executeZoeTurn({
        callerRoles: [gq.callerRole],
        mfaAal2: true,
        userMessage: gq.question,
        modelToolCalls: [],
        modelFinalText: gq.modelReply,
        brokenRpcs: SEVEN_MISSING_FUNCTIONS_LIST.map((f) => f.fnName),
      });

      expect(turn.httpStatus).toBe(200);
      expect(turn.outcome).toBe("answered");
      expect(turn.reply).not.toBe(MSG.error);
      expect(turn.reply).toContain(gq.modelReply.slice(0, 25));
    }
  });

  it("retries without tools (tools: []) on all 10 data-unavailable Welile-fact questions, states plainly what could not be checked, and never shows MSG.error", async () => {
    expect(TEN_DATA_UNAVAILABLE_WELILE_QUESTIONS_PACK).toHaveLength(10);

    for (const du of TEN_DATA_UNAVAILABLE_WELILE_QUESTIONS_PACK) {
      const turn = await executeZoeTurn({
        callerRoles: [du.callerRole],
        mfaAal2: true,
        userMessage: du.question,
        modelToolCalls: [{ name: du.toolName, args: {} }],
        modelFinalText: du.plainTextFallbackReply,
        brokenRpcs: [du.unavailableRpc],
      });

      expect(turn.httpStatus).toBe(200);
      expect(turn.outcome).toBe("answered");
      expect(turn.reply).not.toBe(MSG.error);
      expect(turn.reply).toContain(du.unavailableRpc);
      expect(checkAnswer(turn.reply, [], du.question).ok).toBe(true);
      expect(turn.degradedErrorCodes).toContain(ZOE_ERROR_CODES.ERR_DB_TOOL_RPC_FAILED);
    }
  });

  it("shows the generic error (MSG.error) ONLY when the AI service itself is unreachable", async () => {
    const turn = await executeZoeTurn({
      callerRoles: ["tenant_ops"],
      mfaAal2: true,
      userMessage: "what is receivables",
      modelToolCalls: [],
      modelFinalText: "Unreachable",
      aiGatewayUnreachable: true,
    });

    expect(turn.httpStatus).toBe(200);
    expect(turn.outcome).toBe("error");
    expect(turn.reply).toBe(MSG.error);
    expect(turn.degradedErrorCodes).toContain(ZOE_ERROR_CODES.ERR_AI_GATEWAY_UNREACHABLE);
  });

  it("caches staff_assistant_health for 60 seconds and reports zoe_database_behind when objects are missing", async () => {
    resetStaffAssistantHealthCacheForTest();
    let rpcCalls = 0;

    const mockBehindAdmin = {
      rpc: async (fnName: string) => {
        if (fnName === "staff_assistant_health") {
          rpcCalls += 1;
          return {
            data: {
              status: "zoe_database_behind",
              ok: false,
              missing_functions: [
                "staff_assistant_get_config",
                "assistant_staff_run_query",
              ],
              missing_objects: [
                "rpc:public.staff_assistant_get_config",
                "rpc:public.assistant_staff_run_query",
              ],
              missing_count: 2,
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    };

    const first = await checkStaffAssistantHealth(mockBehindAdmin, false);
    expect(first.status).toBe("zoe_database_behind");
    expect(first.ok).toBe(false);
    expect(first.missingObjects).toContain("rpc:public.staff_assistant_get_config");
    expect(rpcCalls).toBe(1);

    // Second call within 60s uses cache without hitting RPC again
    const second = await checkStaffAssistantHealth(mockBehindAdmin, false);
    expect(second.status).toBe("zoe_database_behind");
    expect(rpcCalls).toBe(1);
    resetStaffAssistantHealthCacheForTest();
  });

  it("passes npm run guard:zoe-parity and verifies parity artifacts exist", () => {
    const stdout = execFileSync(
      process.execPath,
      [resolve(ROOT, "scripts/guard-zoe-parity.mjs")],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(stdout).toContain("[guard:zoe-parity] ok");

    expect(existsSync(resolve(ROOT, "docs/zoe/parity-audit.md"))).toBe(true);
    expect(existsSync(resolve(ROOT, "docs/zoe/deploy-order.md"))).toBe(true);
    expect(existsSync(resolve(ROOT, "supabase/tests/zoe_live_parity.sql"))).toBe(true);

    const paritySql = readFileSync(resolve(ROOT, "supabase/tests/zoe_live_parity.sql"), "utf8");
    expect(paritySql).toContain("zoe_database_behind");
    expect(paritySql).toContain("mfa_required_for_staff");
  });
});
