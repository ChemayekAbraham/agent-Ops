import { describe, expect, it } from "vitest";
import {
  CONSULTANT_FORBIDDEN_TOOLS,
  filterToolsForConsultantMode,
  isConsultantQuestion,
  READ_WEB_PAGE_OPENAI_TOOL,
  SEARCH_WEB_OPENAI_TOOL,
  scoreConsultantAnswer,
  validateConsultantWebQuery,
  validateConsultantWebUrl,
} from "../../../../supabase/functions/staff-assistant/consultant";
import { openAiToolsForRoles } from "../../../../supabase/functions/staff-assistant/tools";
import {
  extractZoeExportableReport,
  evaluateZoeFileRequest,
} from "../zoeReportData";

describe("Prompt 4 — Consultant Mode, Web Research Guards & Safety Invariants", () => {
  describe("isConsultantQuestion", () => {
    it("routes advice, plan review, why, what should we do, and way forward questions to Consultant mode", () => {
      expect(
        isConsultantQuestion(
          "Why are Rent Plan requests waiting longest on Landlord Ops, and what should we do this week?",
        ),
      ).toBe(true);
      expect(
        isConsultantQuestion(
          "Why is uncollected rent high in the First 7 Days report, and what is the best way forward?",
        ),
      ).toBe(true);
      expect(
        isConsultantQuestion(
          "Review our plan for the Partner Ops pending Supporter portfolio queue and advise on priorities.",
        ),
      ).toBe(true);
      expect(
        isConsultantQuestion(
          "Give me advice on handling the 14 silent field collectors this week.",
        ),
      ).toBe(true);
      expect(
        isConsultantQuestion(
          "What are our options for handling the 'Check first' flagged rows in the Landlord Calling Hub?",
        ),
      ).toBe(true);
    });

    it("keeps simple lookups, explicit draft actions, and UI navigation questions in normal mode", () => {
      expect(isConsultantQuestion("What is our treasury cash position today?")).toBe(false);
      expect(isConsultantQuestion("How many active Rent Plans are in Kampala?")).toBe(false);
      expect(
        isConsultantQuestion("Send an email to mark@welile.com with this report."),
      ).toBe(false);
      expect(
        isConsultantQuestion("Set a reminder for tomorrow at 9am to check arrears."),
      ).toBe(false);
      expect(
        isConsultantQuestion("Where do I find the button to submit a requisition?"),
      ).toBe(false);
    });
  });

  describe("filterToolsForConsultantMode (no write tools, no export/draft tools)", () => {
    it("strips every draft/action tool in Consultant mode and omits web tools when webResearchEnabled is false", () => {
      const cfoTools = openAiToolsForRoles(["cfo", "coo", "employee"]);
      const filtered = filterToolsForConsultantMode(cfoTools, false);
      const names = new Set(filtered.map((t) => t.function.name));

      for (const forbidden of CONSULTANT_FORBIDDEN_TOOLS) {
        expect(names.has(forbidden)).toBe(false);
      }
      expect(names.has("search_web")).toBe(false);
      expect(names.has("read_web_page")).toBe(false);
      expect(names.has("get_cfo_treasury_cash_position")).toBe(true);
      expect(names.has("get_welile_glossary")).toBe(true);
      expect(names.has("run_analyst_query")).toBe(true);
    });

    it("adds search_web and read_web_page ONLY in Consultant mode when webResearchEnabled is true", () => {
      const cfoTools = openAiToolsForRoles(["cfo"]);
      const filtered = filterToolsForConsultantMode(cfoTools, true);
      const names = new Set(filtered.map((t) => t.function.name));

      expect(names.has(SEARCH_WEB_OPENAI_TOOL.function.name)).toBe(true);
      expect(names.has(READ_WEB_PAGE_OPENAI_TOOL.function.name)).toBe(true);
      for (const forbidden of CONSULTANT_FORBIDDEN_TOOLS) {
        expect(names.has(forbidden)).toBe(false);
      }
    });
  });

  describe("validateConsultantWebQuery & validateConsultantWebUrl (deterministic privacy firewall)", () => {
    const sampleToolOutputs = [
      JSON.stringify({
        tenant_name: "Mukasa Ronald",
        landlord_name: "Ssali Godfrey",
        staff_name: "Janehephzibar Gimono",
        phone: "+256772123456",
        arrears_ugx: 192220962,
        expected_ugx: 66541680,
      }),
    ];

    it("rejects queries containing names or figures from tool results", () => {
      expect(
        validateConsultantWebQuery("Mukasa Ronald Kampala rent history", sampleToolOutputs).ok,
      ).toBe(false);
      expect(
        validateConsultantWebQuery("Janehephzibar Gimono calling report", sampleToolOutputs).ok,
      ).toBe(false);
      expect(
        validateConsultantWebQuery("192,220,962 arrears benchmark", sampleToolOutputs).ok,
      ).toBe(false);
      expect(
        validateConsultantWebQuery("66541680 first seven days", sampleToolOutputs).ok,
      ).toBe(false);
    });

    it("rejects phone numbers, emails, NINs, UUIDs, UGX figures, and Welile-internal identifiers", () => {
      expect(validateConsultantWebQuery("+256772123456 mobile money", []).ok).toBe(false);
      expect(validateConsultantWebQuery("0772 123 456 landlord", []).ok).toBe(false);
      expect(validateConsultantWebQuery("staff@welile.com", []).ok).toBe(false);
      expect(validateConsultantWebQuery("CM92012345ABCD national id", []).ok).toBe(false);
      expect(
        validateConsultantWebQuery(
          "ca207807-3996-4a1b-98a8-fc21191156c7 landlord",
          [],
        ).ok,
      ).toBe(false);
      expect(validateConsultantWebQuery("UGX 45,000,000 rent collection", []).ok).toBe(false);
      expect(validateConsultantWebQuery("welile internal database", []).ok).toBe(false);
    });

    it("allows generic public research queries with no Welile names or figures", () => {
      expect(
        validateConsultantWebQuery(
          "Uganda mobile money transaction tax rate 2026",
          sampleToolOutputs,
        ),
      ).toEqual({
        ok: true,
        cleanedQuery: "Uganda mobile money transaction tax rate 2026",
      });
    });

    it("validates public HTTPS URLs and blocks localhost, private IPs, and internal hosts", () => {
      expect(validateConsultantWebUrl("http://example.com").ok).toBe(false);
      expect(validateConsultantWebUrl("https://localhost:5432/admin").ok).toBe(false);
      expect(validateConsultantWebUrl("https://192.168.1.1/status").ok).toBe(false);
      expect(validateConsultantWebUrl("https://project.supabase.co/rest/v1").ok).toBe(false);
      expect(validateConsultantWebUrl("https://www.bou.or.ug/bou/rates.html").ok).toBe(true);
    });
  });

  describe("scoreConsultantAnswer (5-point checklist AI judge)", () => {
    it("scores a compliant 4-part Consultant answer at 5/5", () => {
      const answer = `### What I looked at
- **Data source & period:** \`tops_first_seven_summary\` as of 2026-10-26.
- **Sample & caveats:** Covers 184 newly funded Rent Plans in their first 7 days.

### What the data shows
- **[Evidence]** Across 184 newly funded Rent Plans, expected collections are UGX 66,541,680 and uncollected is UGX 41,961,100, with 28 plans at zero payment.
- **[Assumption]** Some of the 28 zero-payment plans have not yet completed their Day-1 onboarding call.
- **[Judgement]** Focusing on the 28 zero-payment plans first is the highest-leverage intervention.

### Options
- **Option 1: Mandatory Day-1 onboarding call for the 28 zero-payment plans**
  - *Trade-offs:* Uses existing Calling Center capacity without pulling field agents off listings.
  - *Risks:* Depends on phone reachability.
  - *What would change the answer:* If call logs show all 28 tenants were already reached.
- **Option 2: Field agent visit on Day 3 for any plan still at zero payment**
  - *Trade-offs:* High in-person conversion, but takes agent field time.
  - *Risks:* Slower in dispersed parishes.
  - *What would change the answer:* If the 28 plans sit under a few silent collectors.

### Recommendation and what to measure next
- **Recommendation:** Start with Option 1 today for the 28 zero-payment Rent Plans, escalating to Option 2 on Day 3.
- **What to measure next:** Track \`zero_payment_plans\` (from 28) in \`tops_first_seven_summary\`.`;

      const res = scoreConsultantAnswer(answer);
      expect(res.passed).toBe(true);
      expect(res.score).toBe(5);
    });

    it("fails answers that make causal claims from correlation, invent unlabelled benchmarks, or use banned terms", () => {
      const badAnswer = `### What I looked at
- Data source & period: sample report with caveats.
### What the data shows
- [Evidence] Correlation proves that this definitely caused the drop in loan ROI.
- [Assumption] The industry standard is 95% for lenders.
### Options
- Option 1: Do A (Trade-offs: X, Risks: Y, What would change the answer: Z)
- Option 2: Do B (Trade-offs: X, Risks: Y, What would change the answer: Z)
### Recommendation and what to measure next
- Recommendation: Option 1. What to measure next: track weekly rate.`;

      const res = scoreConsultantAnswer(badAnswer);
      expect(res.passed).toBe(false);
      expect(res.checks.respectsEpistemicAndTerminologyRules).toBe(false);
    });
  });

  describe("Explicit Invariant: Zoe never makes a file unless asked (incl. Consultant mode)", () => {
    it("never extracts an exportable report when reportPayload has consultant_mode = true", () => {
      const report = extractZoeExportableReport({
        content: "### What I looked at\n...",
        reportPayload: {
          consultant_mode: true,
          title: "Consultant Advice",
          columns: [
            { key: "metric", label: "Metric" },
            { key: "value", label: "Value" },
          ],
          rows: [{ metric: "Active Rent Plans", value: 1420 }],
        },
      });
      expect(report).toBeNull();
    });

    it("produces fileCreated = false when the user says 'no file please' or asks for advice", () => {
      const decision = evaluateZoeFileRequest({
        userPrompt: "Show the COO overview numbers in chat only, no file please.",
        assistantMessage: {
          content: "There are 1,420 active Rent Plans.",
          reportPayload: {
            title: "COO Overview",
            columns: [
              { key: "metric", label: "Metric" },
              { key: "value", label: "Value" },
            ],
            rows: [{ metric: "Active Rent Plans", value: 1420 }],
          },
        },
      });
      expect(decision.fileCreated).toBe(false);
    });
  });
});
