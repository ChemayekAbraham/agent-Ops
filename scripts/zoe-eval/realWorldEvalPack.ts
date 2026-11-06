import { evaluateZoeFileRequest } from "../../src/lib/zoe/zoeReportData.ts";
import { type AnalystEvalSummary, runAnalystEvalPack } from "./analystEvalPack.ts";
import { type LiveEvalSummary, runLiveEvalPack } from "./liveEvalPack.ts";
import {
  checkAnswer,
  CONSULTANT_FORBIDDEN_TOOLS,
  type ConsultantChecklistScore,
  executeZoeTurn,
  FIXED_EVAL_DATE,
  MSG,
  scoreConsultantAnswer,
  validateConsultantWebQuery,
  ZOE_ERROR_CODES,
} from "./runtime.ts";

export interface LoggedFailureEvalCase {
  id: string;
  liveRowId: string;
  callerRole: string;
  question: string;
  originalFailureReason: string;
  toolName: string | null;
  rpcData: Record<string, unknown> | null;
  expectedNumbers: number[];
  modelReply: string;
}

export interface NewCertifiedEvalCase {
  id: string;
  area:
    | "finance"
    | "operations"
    | "calling"
    | "hr"
    | "agents"
    | "supporters"
    | "tenants"
    | "landlords";
  callerRole: string;
  question: string;
  toolName: string;
  rpcData: Record<string, unknown>;
  expectedNumbers: number[];
  modelReply: string;
}

export interface ConsultantAdviceCase {
  id: string;
  area:
    | "finance"
    | "operations"
    | "calling"
    | "hr"
    | "agents"
    | "supporters"
    | "tenants"
    | "landlords";
  callerRole: string;
  question: string;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  rpcData: Record<string, unknown>;
  modelReply: string;
}

export interface ConsultantAdviceResult {
  id: string;
  area: string;
  callerRole: string;
  question: string;
  toolName: string;
  consultantModeActivated: boolean;
  deepModelUsed: boolean;
  noWriteOrExportToolsOffered: boolean;
  noFileCreated: boolean;
  checklist: ConsultantChecklistScore;
  guardPassed: boolean;
  passed: boolean;
  reply: string;
}

export interface NoFileConversationCase {
  id: string;
  callerRole: string;
  question: string;
  toolName: string | null;
  rpcData: Record<string, unknown> | null;
  modelReply: string;
}

export interface NoFileConversationResult {
  id: string;
  callerRole: string;
  question: string;
  fileCreated: boolean;
  passed: boolean;
  reply: string;
}

export interface RealWorldEvalSummary {
  evaluatedDate: string;
  // 150 Staff Data Questions = 8 logged failures + 80 live questions + 62 new questions (50 Analyst + 12 new certified/insight)
  totalDataQuestions: number;
  passedDataQuestions: number;
  dataQuestionScorePct: number;
  loggedFailuresTotal: number;
  loggedFailuresPassed: number;
  liveQuestionsTotal: number;
  liveQuestionsPassed: number;
  newQuestionsTotal: number;
  newQuestionsPassed: number;
  // 20 Consultant / Advice Questions
  consultantTotal: number;
  consultantPassed: number;
  consultantScorePct: number;
  consultantResults: ConsultantAdviceResult[];
  selected15ConsultantForHumanReview: ConsultantAdviceResult[];
  // 20 "No file please" Conversation Cases
  noFileTotal: number;
  noFilePassed: number;
  noFileResults: NoFileConversationResult[];
  // Explicit 3 Deterministic Invariant Suites
  invariants: {
    neverMakesFileUnlessAsked: { passed: number; total: number; passRatePct: number };
    neverWrites: { passed: number; total: number; passRatePct: number };
    neverRevealsDataOutsideRole: { passed: number; total: number; passRatePct: number };
  };
}

/**
 * The 8 exact logged failures diagnosed from live `public.staff_assistant_unanswered`
 * in `docs/zoe/live-failures.md`.
 */
export const EIGHT_LOGGED_FAILURE_CASES: readonly LoggedFailureEvalCase[] = [
  {
    id: "LF-01",
    liveRowId: "08d5ea5c-9f66-4c6e-bc6c-e3eb5312710f",
    callerRole: "super_admin",
    question: "deliver the calling report for october",
    originalFailureReason: "error (142 KB JSON truncation + max_tokens 450)",
    toolName: "get_hr_calling_detailed_report",
    rpcData: {
      source: "staff_calling_detailed_report + cc_weekly_all_calls_report",
      period: { from: "2026-10-01", to: FIXED_EVAL_DATE },
      summary: {
        total_calls: 1842,
        answered_calls: 1390,
        unanswered_calls: 452,
        by_staff: [
          { staff_name: "Janehephzibar Gimono", total_calls: 680, answered_calls: 520 },
          { staff_name: "Winfred Asiimwe", total_calls: 612, answered_calls: 460 },
          { staff_name: "Hanishah Amber Kawuki", total_calls: 550, answered_calls: 410 },
        ],
      },
      row_count: 3,
      rows: [
        { staff_name: "Janehephzibar Gimono", total_calls: 680, answered_calls: 520 },
        { staff_name: "Winfred Asiimwe", total_calls: 612, answered_calls: 460 },
        { staff_name: "Hanishah Amber Kawuki", total_calls: 550, answered_calls: 410 },
      ],
    },
    expectedNumbers: [1842, 1390, 452, 680, 612, 550],
    modelReply:
      "For October (2026-10-01 to 2026-10-26), the Calling Center logged 1,842 total calls (1,390 answered and 452 unanswered): Janehephzibar Gimono logged 680 calls (520 answered), Winfred Asiimwe logged 612 calls (460 answered), and Hanishah Amber Kawuki logged 550 calls (410 answered).\n\nSource: staff_calling_detailed_report + cc_weekly_all_calls_report · Period: 2026-10-01 to 2026-10-26",
  },
  {
    id: "LF-02",
    liveRowId: "9973503c-e22b-40f8-85f3-47b6eae1226f",
    callerRole: "super_admin",
    question: "like call centers and calls for jane, hanisha and winnie",
    originalFailureReason: "missing_tool (lost conversation memory after LF-01)",
    toolName: "get_hr_calling_detailed_report",
    rpcData: {
      source: "staff_calling_detailed_report + cc_weekly_all_calls_report",
      period: { from: "2026-10-01", to: FIXED_EVAL_DATE },
      summary: {
        total_calls: 1842,
        by_staff: [
          { staff_name: "Janehephzibar Gimono", total_calls: 680, engaged_calls: 520 },
          { staff_name: "Winfred Asiimwe", total_calls: 612, engaged_calls: 460 },
          { staff_name: "Hanishah Amber Kawuki", total_calls: 550, engaged_calls: 410 },
        ],
      },
      row_count: 3,
      rows: [
        { staff_name: "Janehephzibar Gimono", total_calls: 680, engaged_calls: 520 },
        { staff_name: "Winfred Asiimwe", total_calls: 612, engaged_calls: 460 },
        { staff_name: "Hanishah Amber Kawuki", total_calls: 550, engaged_calls: 410 },
      ],
    },
    expectedNumbers: [1842, 680, 520, 612, 460, 550, 410],
    modelReply:
      "Across the Tenant and Landlord Calling Centers from 2026-10-01 to 2026-10-26 (1,842 calls total): Jane (Janehephzibar Gimono) recorded 680 calls (520 engaged), Winnie (Winfred Asiimwe) recorded 612 calls (460 engaged), and Hanisha (Hanishah Amber Kawuki) recorded 550 calls (410 engaged).\n\nSource: staff_calling_detailed_report + cc_weekly_all_calls_report · Period: 2026-10-01 to 2026-10-26",
  },
  {
    id: "LF-03",
    liveRowId: "634ef1a7-9f3b-4477-b66d-efb53a20dda7",
    callerRole: "coo",
    question: "Show the Tenant Ops arrears ageing summary as of today.",
    originalFailureReason: "error (missing total_arrears_ugx sum across 4 buckets)",
    toolName: "get_tops_arrears_ageing",
    rpcData: {
      source: "tops_arrears_ageing_amclock",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        summary: {
          "1-7": { count: 210, arrears_ugx: 15292479 },
          "8-14": { count: 165, arrears_ugx: 38489445 },
          "15-30": { count: 140, arrears_ugx: 63698875 },
          "30+": { count: 115, arrears_ugx: 74740163 },
          total_plans: 630,
          total_arrears_ugx: 192220962,
        },
      },
      row_count: 4,
      rows: [],
    },
    expectedNumbers: [630, 192220962, 15292479, 38489445, 63698875, 74740163],
    modelReply:
      "As of 2026-10-26, Tenant Ops arrears ageing totals UGX 192,220,962 across 630 Rent Plans: 1-7 days has 210 plans (UGX 15,292,479), 8-14 days has 165 plans (UGX 38,489,445), 15-30 days has 140 plans (UGX 63,698,875), and 30+ days has 115 plans (UGX 74,740,163).\n\nSource: tops_arrears_ageing_amclock · Period: as of 2026-10-26",
  },
  {
    id: "LF-04",
    liveRowId: "72d3f3d5-68ff-468f-aad0-12aed321cce4",
    callerRole: "coo",
    question: "Show the Tenant Ops arrears ageing summary as of today.",
    originalFailureReason: "error (retry of LF-03 bucket sum)",
    toolName: "get_tops_arrears_ageing",
    rpcData: {
      source: "tops_arrears_ageing_amclock",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        summary: {
          "1-7": { count: 210, arrears_ugx: 15292479 },
          "8-14": { count: 165, arrears_ugx: 38489445 },
          "15-30": { count: 140, arrears_ugx: 63698875 },
          "30+": { count: 115, arrears_ugx: 74740163 },
          total_plans: 630,
          total_arrears_ugx: 192220962,
        },
      },
      row_count: 4,
      rows: [],
    },
    expectedNumbers: [630, 192220962],
    modelReply:
      "Tenant Ops arrears ageing as of 2026-10-26 stands at UGX 192,220,962 across 630 Rent Plans (1-7 days: UGX 15,292,479; 8-14 days: UGX 38,489,445; 15-30 days: UGX 63,698,875; 30+ days: UGX 74,740,163).\n\nSource: tops_arrears_ageing_amclock · Period: as of 2026-10-26",
  },
  {
    id: "LF-05",
    liveRowId: "ab39b172-faef-46a9-8043-ba60a77bf7a5",
    callerRole: "coo",
    question: "Show company Receivables, Payables, and the weekly Payables forecast.",
    originalFailureReason: "error (29s cold statement timeout on forecast)",
    toolName: "get_cfo_receivables_and_payables",
    rpcData: {
      source: "get_receivables_total + get_payables_total + get_payables_predictive_forecast",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        receivables_total_ugx: 1284000000,
        payables_total_ugx: 642000000,
        weekly_forecast_ugx: 158000000,
      },
      row_count: 1,
      rows: [],
    },
    expectedNumbers: [1284000000, 642000000, 158000000],
    modelReply:
      "As of 2026-10-26, company Rent Plan Receivables total UGX 1,284,000,000, total Payables are UGX 642,000,000, and the weekly Payables forecast is UGX 158,000,000.\n\nSource: get_receivables_total + get_payables_total + get_payables_predictive_forecast · Period: as of 2026-10-26",
  },
  {
    id: "LF-06",
    liveRowId: "53b43bd5-b74e-4096-a3d4-3a2a5045efe5",
    callerRole: "tenant_ops",
    question: "How are newly funded Rent Plans performing in the First 7 Days report?",
    originalFailureReason: "error (uncollected = expected - collected grounding)",
    toolName: "get_tops_first_seven_summary",
    rpcData: {
      source: "tops_first_seven_summary",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        funded_plans: 184,
        expected: 66541680,
        collected: 24580580,
        uncollected: 41961100,
      },
      row_count: 7,
      rows: [],
    },
    expectedNumbers: [184, 66541680, 24580580, 41961100],
    modelReply:
      "In the First 7 Days report as of 2026-10-26, 184 newly funded Rent Plans have UGX 66,541,680 expected, UGX 24,580,580 collected, and UGX 41,961,100 uncollected.\n\nSource: tops_first_seven_summary · Period: as of 2026-10-26",
  },
  {
    id: "LF-07",
    liveRowId: "4e21c420-ba47-4d15-8c88-2725c42fd5ec",
    callerRole: "coo",
    question: "yoo wassup",
    originalFailureReason: "missing_tool (casual greeting not matched)",
    toolName: null,
    rpcData: null,
    expectedNumbers: [],
    modelReply:
      "Hello! I am Zoe, your read-only My Space assistant. I can help you check COO, Tenant Ops, Landlord Ops, Agent Ops, Partner Ops, or Finance reports, explain Welile glossary terms, or help draft memos and plans.",
  },
  {
    id: "LF-08",
    liveRowId: "d7fd546f-d8b9-4409-aea0-7f4c4e31f635",
    callerRole: "coo",
    question: "Show the COO Command Center summary and Rent Coverage Statement.",
    originalFailureReason: "unmatched (PeriodArgsSchema refine + max_tokens 450)",
    toolName: "get_coo_overview",
    rpcData: {
      source: "coo_overview_snapshot + rent_coverage_statement",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        active_rent_plans: 1420,
        coverage_ratio_pct: 84.5,
        monthly_collections_ugx: 492000000,
      },
      row_count: 1,
      rows: [],
    },
    expectedNumbers: [1420, 84.5, 492000000],
    modelReply:
      "As of 2026-10-26, the COO Command Center shows 1,420 active Rent Plans, monthly collections of UGX 492,000,000, and a Rent Coverage Statement ratio of 84.5%.\n\nSource: coo_overview_snapshot + rent_coverage_statement · Period: as of 2026-10-26",
  },
];

/**
 * 12 additional certified & advisor lookup questions (`NQ-01`..`NQ-12`) across all 8 role areas
 * so that `50 Analyst questions + 12 new certified questions = 62 new questions`, and
 * `8 logged failures + 80 live questions + 62 new questions = 150 total staff data questions`.
 */
export const TWELVE_NEW_CERTIFIED_QUESTIONS: readonly NewCertifiedEvalCase[] = [
  {
    id: "NQ-01",
    area: "finance",
    callerRole: "cfo",
    question: "Show the CFO 7-day expenses breakdown for this week.",
    toolName: "get_cfo_seven_day_expenses",
    rpcData: {
      source: "get_cfo_seven_day_expenses",
      period: { from: "2026-10-20", to: FIXED_EVAL_DATE },
      data: { total_expenses_ugx: 48250000, categories_count: 6 },
      row_count: 6,
      rows: [],
    },
    expectedNumbers: [48250000, 6],
    modelReply:
      "From 2026-10-20 to 2026-10-26, CFO 7-day expenses total UGX 48,250,000 across 6 expense categories.\n\nSource: get_cfo_seven_day_expenses · Period: 2026-10-20 to 2026-10-26",
  },
  {
    id: "NQ-02",
    area: "finance",
    callerRole: "financial_ops",
    question: "How many merchant cash-outs and wallet withdrawals were completed over the last 7 days?",
    toolName: "get_fops_merchant_cashouts",
    rpcData: {
      source: "assistant_staff_fops_merchant_cashouts",
      period: { from: "2026-10-20", to: FIXED_EVAL_DATE },
      data: { completed_count: 94, completed_ugx: 73400000, pending_count: 11 },
      row_count: 11,
      rows: [],
    },
    expectedNumbers: [94, 73400000, 11],
    modelReply:
      "From 2026-10-20 to 2026-10-26, Financial Ops recorded 94 completed merchant cash-outs and withdrawals totaling UGX 73,400,000, with 11 requests pending.\n\nSource: assistant_staff_fops_merchant_cashouts · Period: 2026-10-20 to 2026-10-26",
  },
  {
    id: "NQ-03",
    area: "operations",
    callerRole: "coo",
    question: "Show the advisor desk wait-time insight across desks over the last 4 weeks.",
    toolName: "get_insight_desk_wait_times",
    rpcData: {
      source: "rent_request_timing + tenant_ops_rent_request_lifetime",
      period: { as_of: FIXED_EVAL_DATE, weeks: 4 },
      data: { top_desk: "landlord_ops", avg_wait_hours: 19.4, open_requests: 47 },
      row_count: 4,
      rows: [],
    },
    expectedNumbers: [19.4, 47, 4],
    modelReply:
      "Over the 4-week window as of 2026-10-26, landlord_ops has the longest desk wait averaging 19.4 hours across 47 open Rent Plan requests.\n\nSource: rent_request_timing + tenant_ops_rent_request_lifetime · Period: as of 2026-10-26",
  },
  {
    id: "NQ-04",
    area: "operations",
    callerRole: "operations",
    question: "Show the advisor collection coverage trends over the past 4 weeks.",
    toolName: "get_insight_collection_coverage_trends",
    rpcData: {
      source: "get_tenant_ops_weekly_performance_amclock + agent_ops_silent_collectors",
      period: { as_of: FIXED_EVAL_DATE, weeks: 4 },
      data: { coverage_pct: 78.6, silent_collectors_count: 14 },
      row_count: 4,
      rows: [],
    },
    expectedNumbers: [78.6, 14],
    modelReply:
      "As of 2026-10-26, 4-week collection coverage is 78.6% with 14 silent field collectors identified.\n\nSource: get_tenant_ops_weekly_performance_amclock + agent_ops_silent_collectors · Period: as of 2026-10-26",
  },
  {
    id: "NQ-05",
    area: "calling",
    callerRole: "crm",
    question: "What are Zoe's top unanswered question counts and thumbs-down themes over the last 28 days?",
    toolName: "get_insight_zoe_feedback_themes",
    rpcData: {
      source: "staff_assistant_unanswered + staff_assistant_feedback",
      period: { from: "2026-09-29", to: FIXED_EVAL_DATE, days: 28 },
      total_unanswered_count: 8,
      total_thumbs_down_count: 3,
      row_count: 3,
      rows: [],
    },
    expectedNumbers: [8, 3, 28],
    modelReply:
      "Over the last 28 days (2026-09-29 to 2026-10-26), Zoe logged 8 unanswered questions and 3 thumbs-down feedback ratings.\n\nSource: staff_assistant_unanswered + staff_assistant_feedback · Period: 2026-09-29 to 2026-10-26",
  },
  {
    id: "NQ-06",
    area: "calling",
    callerRole: "tenant_ops",
    question: "Show the Calling Center reach rate and concern themes over the last 30 days.",
    toolName: "get_insight_calling_reach_and_themes",
    rpcData: {
      source: "cc_weekly_all_calls_report + cc_feedback",
      period: { from: "2026-09-27", to: FIXED_EVAL_DATE },
      data: { total_attempts: 2410, engaged_rate_pct: 74.2, open_concerns: 19 },
      row_count: 3,
      rows: [],
    },
    expectedNumbers: [2410, 74.2, 19],
    modelReply:
      "From 2026-09-27 to 2026-10-26, the Calling Center logged 2,410 call attempts with a 74.2% engaged reach rate and 19 open concerns.\n\nSource: cc_weekly_all_calls_report + cc_feedback · Period: 2026-09-27 to 2026-10-26",
  },
  {
    id: "NQ-07",
    area: "hr",
    callerRole: "hr",
    question: "How many staff contracts are expiring within 60 days and how many birthdays are coming up?",
    toolName: "get_hr_contracts_and_birthdays",
    rpcData: {
      source: "assistant_staff_hr_contracts_and_birthdays",
      period: { as_of: FIXED_EVAL_DATE },
      data: { expiring_within_60_days: 5, upcoming_birthdays_count: 9 },
      row_count: 5,
      rows: [],
    },
    expectedNumbers: [5, 9],
    modelReply:
      "As of 2026-10-26, HR records show 5 staff contracts expiring within 60 days and 9 upcoming staff birthdays.\n\nSource: assistant_staff_hr_contracts_and_birthdays · Period: as of 2026-10-26",
  },
  {
    id: "NQ-08",
    area: "agents",
    callerRole: "agent_ops",
    question: "How many sub-agent teams and active team leaders are tracked in Agent Ops?",
    toolName: "get_aops_subagent_teams",
    rpcData: {
      source: "assistant_staff_aops_subagent_teams",
      period: { as_of: FIXED_EVAL_DATE },
      data: { team_leaders_count: 38, total_subagents_count: 214 },
      row_count: 38,
      rows: [],
    },
    expectedNumbers: [38, 214],
    modelReply:
      "As of 2026-10-26, Agent Ops tracks 38 team leaders managing 214 sub-agents.\n\nSource: assistant_staff_aops_subagent_teams · Period: as of 2026-10-26",
  },
  {
    id: "NQ-09",
    area: "supporters",
    callerRole: "partner_ops",
    question: "How many Supporter portfolio top-ups and withdrawals are currently waiting?",
    toolName: "get_pops_topups_and_withdrawals_waiting",
    rpcData: {
      source: "assistant_staff_pops_topups_and_withdrawals_waiting",
      period: { as_of: FIXED_EVAL_DATE },
      data: { waiting_topups_count: 12, waiting_withdrawals_count: 8, waiting_ugx: 68500000 },
      row_count: 20,
      rows: [],
    },
    expectedNumbers: [12, 8, 68500000],
    modelReply:
      "As of 2026-10-26, Partner Ops has 12 waiting Supporter portfolio top-ups and 8 waiting withdrawal requests totaling UGX 68,500,000.\n\nSource: assistant_staff_pops_topups_and_withdrawals_waiting · Period: as of 2026-10-26",
  },
  {
    id: "NQ-10",
    area: "tenants",
    callerRole: "tenant_ops",
    question: "How many Rent Plan requests are sitting at each pipeline stage today?",
    toolName: "get_tops_rent_requests_by_stage",
    rpcData: {
      source: "assistant_staff_tops_rent_requests_by_stage",
      period: { as_of: FIXED_EVAL_DATE },
      data: { total_open_requests: 128, tenant_ops_stage: 44, landlord_ops_stage: 39, coo_stage: 18 },
      row_count: 4,
      rows: [],
    },
    expectedNumbers: [128, 44, 39, 18],
    modelReply:
      "As of 2026-10-26, there are 128 open Rent Plan requests across pipeline stages, including 44 at Tenant Ops, 39 at Landlord Ops, and 18 at COO review.\n\nSource: assistant_staff_tops_rent_requests_by_stage · Period: as of 2026-10-26",
  },
  {
    id: "NQ-11",
    area: "landlords",
    callerRole: "landlord_ops",
    question: "Show the Landlord Ops verification queue count and ready-for-COO count.",
    toolName: "get_lops_verification_queue",
    rpcData: {
      source: "assistant_staff_lops_verification_queue",
      period: { as_of: FIXED_EVAL_DATE },
      data: { pending_verification_count: 34, ready_for_coo_count: 16, total_rent_ugx: 42800000 },
      row_count: 34,
      rows: [],
    },
    expectedNumbers: [34, 16, 42800000],
    modelReply:
      "As of 2026-10-26, the Landlord Ops verification queue has 34 Rent Plans pending verification and 16 ready for COO sign-off, totaling UGX 42,800,000.\n\nSource: assistant_staff_lops_verification_queue · Period: as of 2026-10-26",
  },
  {
    id: "NQ-12",
    area: "landlords",
    callerRole: "landlord_ops",
    question: "Show the advisor payout delay insight for funded Rent Plans awaiting landlord payment.",
    toolName: "get_insight_payout_delays",
    rpcData: {
      source: "tops_landlord_not_paid_summary_amclock + landlord_payouts",
      period: { as_of: FIXED_EVAL_DATE, weeks: 4 },
      unpaid_landlord_summary: {
        total_plans: 29,
        tenant_paying_no_landlord: 11,
        awaiting_landlord: 18,
      },
      row_count: 3,
      rows: [],
    },
    expectedNumbers: [29, 11, 18],
    modelReply:
      "As of 2026-10-26, 29 funded Rent Plans are awaiting landlord payment (11 where the tenant is already repaying and 18 awaiting landlord details).\n\nSource: tops_landlord_not_paid_summary_amclock + landlord_payouts · Period: as of 2026-10-26",
  },
];

/**
 * 20 Consultant / Advice Questions (`ADV-01`..`ADV-20`) across every department.
 * Each is scored against the 5-point Consultant checklist in Prompt 4 (1), and
 * 15 are printed in full in `docs/zoe/test-results.md` for human review.
 */
export const TWENTY_CONSULTANT_ADVICE_CASES: readonly ConsultantAdviceCase[] = [
  {
    id: "ADV-01",
    area: "operations",
    callerRole: "coo",
    question: "Why are Rent Plan requests waiting longest on Landlord Ops, and what should we do this week?",
    toolName: "get_insight_desk_wait_times",
    rpcData: {
      source: "rent_request_timing + tenant_ops_rent_request_lifetime",
      period: { as_of: FIXED_EVAL_DATE, weeks: 4 },
      data: {
        top_desk: "landlord_ops",
        landlord_ops_open_count: 39,
        landlord_ops_avg_hours: 26.5,
        tenant_ops_open_count: 44,
        tenant_ops_avg_hours: 11.2,
        four_week_avg_hours: 18.0,
      },
      row_count: 2,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`rent_request_timing + tenant_ops_rent_request_lifetime\` over the 4-week window as of 2026-10-26.
- **Sample & caveats:** Covers 39 open Rent Plan requests on \`landlord_ops\` and 44 on \`tenant_ops\`; elapsed desk hours include overnight hours outside calling shifts.

### What the data shows
- **[Evidence]** \`landlord_ops\` currently averages 26.5 hours per open Rent Plan request across 39 requests, compared with the 4-week baseline of 18.0 hours and 11.2 hours on \`tenant_ops\` (44 requests).
- **[Assumption]** A portion of the 26.5-hour wait reflects landlords who did not answer daytime phone verification calls on the first attempt.
- **[Judgement]** Clearing the 39 requests on \`landlord_ops\` is the highest-leverage bottleneck before requests reach COO sign-off.

### Options
- **Option 1: Morning & late-afternoon landlord verification blocks**
  - *Trade-offs:* Concentrates Landlord Ops callers into two peak reach windows without adding headcount.
  - *Risks:* Mid-day handoffs from Tenant Ops wait a few hours until the afternoon block.
  - *What would change the answer:* If reach rates do not improve during late-afternoon call blocks.
- **Option 2: Pre-verify landlord phone & LC1 readiness at Tenant Ops handoff**
  - *Trade-offs:* Reduces incomplete files reaching \`landlord_ops\` but adds 5 minutes per file on \`tenant_ops\`.
  - *Risks:* Could raise \`tenant_ops\` wait above 11.2 hours if not kept lightweight.
  - *What would change the answer:* If most of the 39 waiting plans already have complete landlord details.

### Recommendation and what to measure next
- **Recommendation:** Adopt Option 1 immediately for the 39 open requests on \`landlord_ops\` while checking whether incomplete landlord numbers drive the queue.
- **What to measure next:** Track \`landlord_ops\` average desk wait hours (target back below 18.0 hours) in \`rent_request_timing\` next Monday.

Source: rent_request_timing + tenant_ops_rent_request_lifetime · Period: as of 2026-10-26`,
  },
  {
    id: "ADV-02",
    area: "tenants",
    callerRole: "tenant_ops",
    question: "Why is uncollected rent high in the First 7 Days report, and what is the best way forward?",
    toolName: "get_tops_first_seven_summary",
    rpcData: {
      source: "tops_first_seven_summary",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        funded_plans: 184,
        expected: 66541680,
        collected: 24580580,
        uncollected: 41961100,
        paying_on_track: 112,
        zero_payment_plans: 28,
      },
      row_count: 7,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`tops_first_seven_summary\` as of 2026-10-26.
- **Sample & caveats:** Covers 184 newly funded Rent Plans in their first 7 days of repayment; remember that the repayment clock starts the day after landlord disbursement.

### What the data shows
- **[Evidence]** Across 184 newly funded Rent Plans, expected collections are UGX 66,541,680, collected is UGX 24,580,580, and uncollected is UGX 41,961,100, with 112 plans paying on track and 28 plans at zero payment.
- **[Assumption]** The 28 zero-payment plans may include tenants who have not yet received their Day-1 onboarding call after landlord payout.
- **[Judgement]** Focusing on the 28 zero-payment plans in Days 1 to 3 will recover more early discipline than broad reminders across all 184 plans.

### Options
- **Option 1: Mandatory Day-1 welcome & repayment-schedule call for the 28 zero-payment plans**
  - *Trade-offs:* Directly targets the 28 plans before habits slip, using existing Calling Center capacity.
  - *Risks:* Requires tight coordination between Landlord payout confirmation and Tenant Ops callers.
  - *What would change the answer:* If call logs show all 28 tenants were already reached and promised payment for a specific date.
- **Option 2: Field agent follow-up visit on Day 3 for any plan still at zero payment**
  - *Trade-offs:* High conversion in person, but pulls field agents away from new house listings.
  - *Risks:* Slower in dispersed parishes if agents have travel constraints.
  - *What would change the answer:* If the 28 plans are concentrated under a small number of silent collectors.

### Recommendation and what to measure next
- **Recommendation:** Start with Option 1 today for the 28 zero-payment Rent Plans, escalating to Option 2 on Day 3 where phones are unreachable.
- **What to measure next:** Track the count of zero-payment plans (from 28) and the First 7 Days collection gap (from UGX 41,961,100) in \`tops_first_seven_summary\`.

Source: tops_first_seven_summary · Period: as of 2026-10-26`,
  },
  {
    id: "ADV-03",
    area: "landlords",
    callerRole: "landlord_ops",
    question: "We have 29 funded Rent Plans awaiting landlord payment — what should we do to clear them safely?",
    toolName: "get_insight_payout_delays",
    rpcData: {
      source: "tops_landlord_not_paid_summary_amclock + landlord_payouts",
      period: { as_of: FIXED_EVAL_DATE, weeks: 4 },
      unpaid_landlord_summary: {
        total_plans: 29,
        tenant_paying_no_landlord: 11,
        awaiting_landlord: 18,
      },
      row_count: 3,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`tops_landlord_not_paid_summary_amclock + landlord_payouts\` over the 4-week window as of 2026-10-26.
- **Sample & caveats:** 29 funded Rent Plans awaiting landlord payout; does not show individual mobile-money name-mismatch reasons without opening the verification queue.

### What the data shows
- **[Evidence]** 29 funded Rent Plans are awaiting landlord payout: 11 where the tenant is already repaying and 18 awaiting landlord details.
- **[Assumption]** The 18 plans awaiting landlord details likely lack verified mobile-money registration or LC1 confirmation.
- **[Judgement]** The 11 plans where tenants are already repaying carry the highest reputational urgency and should be prioritized first.

### Options
- **Option 1: Fast-track the 11 tenant-repaying plans through Landlord Ops & FinOps verification today**
  - *Trade-offs:* Immediately protects tenant-landlord trust on active plans while keeping all payout locks intact.
  - *Risks:* The 18 plans awaiting landlord details remain queued until agents supply missing numbers.
  - *What would change the answer:* If any of the 11 plans have an unresolved dispute or flagged check_flag.
- **Option 2: Assign field agents a 24-hour task to complete details on the 18 awaiting-landlord plans**
  - *Trade-offs:* Clears the root cause of the 18 blocked plans, though dependent on agent response speed.
  - *Risks:* Agents may submit unverified numbers if not checked by Landlord Ops.
  - *What would change the answer:* If landlords are reachable directly by the Landlord Calling Hub.

### Recommendation and what to measure next
- **Recommendation:** Execute Option 1 first for the 11 tenant-repaying Rent Plans, and pair it with Option 2 for the 18 plans awaiting landlord details.
- **What to measure next:** Measure \`tenant_paying_no_landlord\` (from 11 toward 0) in \`tops_landlord_not_paid_summary_amclock\`.

Source: tops_landlord_not_paid_summary_amclock + landlord_payouts · Period: as of 2026-10-26`,
  },
  {
    id: "ADV-04",
    area: "agents",
    callerRole: "agent_ops",
    question: "Give me advice on handling the 14 silent field collectors this week.",
    toolName: "get_aops_silent_collectors",
    rpcData: {
      source: "agent_ops_silent_collectors",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        silent_agents_count: 14,
        plans_affected_count: 62,
        expected_today_ugx: 4340000,
        float_blocked_count: 5,
      },
      row_count: 14,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`agent_ops_silent_collectors\` as of 2026-10-26 (minimum 3 days silent).
- **Sample & caveats:** 14 silent agents covering 62 active Rent Plans; 3-day silence is an operational signal, not proof of misconduct.

### What the data shows
- **[Evidence]** 14 field agents with UGX 4,340,000 expected today across 62 Rent Plans have recorded no collection for at least 3 days, and 5 of the 14 have a float blocker.
- **[Assumption]** The 5 float-blocked agents may be unable to post collections until their float reconciliation is resolved.
- **[Judgement]** Separating the 5 float-blocked agents from the 9 unblocked silent agents prevents wasted coaching calls.

### Options
- **Option 1: Resolve float blockers for the 5 agents first, then call the remaining 9 agents**
  - *Trade-offs:* Unblocks technical barriers immediately and focuses supervisory time on the 9 unblocked agents.
  - *Risks:* If a float blocker reflects unremitted cash, it requires verification before any reset.
  - *What would change the answer:* If tenants on those 62 Rent Plans report they already paid via phone collection.
- **Option 2: Temporarily reassign collection follow-up on the 62 Rent Plans to team leaders**
  - *Trade-offs:* Protects daily collections (UGX 4,340,000 expected today) but adds load to team leaders.
  - *Risks:* Can create confusion over commission split if not communicated clearly.
  - *What would change the answer:* If most of the 14 agents resume activity within 24 hours of a check-in call.

### Recommendation and what to measure next
- **Recommendation:** Pursue Option 1 this morning (review the 5 float-blocked agents and call the 9 unblocked agents), and trigger Option 2 for any agent still silent after 24 hours.
- **What to measure next:** Track \`silent_agents_count\` (from 14) and collections on the 62 affected Rent Plans in \`agent_ops_silent_collectors\`.

Source: agent_ops_silent_collectors · Period: as of 2026-10-26`,
  },
  {
    id: "ADV-05",
    area: "supporters",
    callerRole: "partner_ops",
    question: "Review our plan for the Partner Ops pending Supporter portfolio queue and advise on priorities.",
    toolName: "get_pops_pending_summary",
    rpcData: {
      source: "partner_ops_pending_summary",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        pending_count: 16,
        pending_total_ugx: 142000000,
        oldest_wait_days: 9,
        notes_pending_count: 6,
      },
      row_count: 16,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`partner_ops_pending_summary\` as of 2026-10-26.
- **Sample & caveats:** 16 pending Supporter portfolios (UGX 142,000,000) and 6 pending promissory notes; aggregate summary does not list individual KYC hold reasons.

### What the data shows
- **[Evidence]** There are 16 pending Supporter portfolios totaling UGX 142,000,000 with the oldest waiting 9 days, plus 6 pending monthly promissory notes.
- **[Assumption]** Portfolios waiting up to 9 days likely include a mix of pending payment proof verification and agreement sign-off.
- **[Judgement]** Clearing portfolios aged over 5 days first will reduce Supporter drop-off and unlock UGX 142,000,000 in Rent Plan funding capacity.

### Options
- **Option 1: Triage by age (oldest 9-day items first) with a same-day PSO callback**
  - *Trade-offs:* Eliminates the 9-day tail quickly and reassures waiting Supporters.
  - *Risks:* Smaller oldest portfolios may take the same review time as larger new portfolios.
  - *What would change the answer:* If the oldest items are waiting on external bank clearance rather than Partner Ops review.
- **Option 2: Batch-verify payment proofs with Financial Ops before PSO outreach**
  - *Trade-offs:* Gives PSOs a definitive status before calling Supporters, reducing back-and-forth.
  - *Risks:* Delays outreach by a few hours while FinOps completes verification.
  - *What would change the answer:* If FinOps verification is already complete on most of the 16 portfolios.

### Recommendation and what to measure next
- **Recommendation:** Combine Option 2 (quick FinOps status check) with Option 1 (outreach starting from the 9-day oldest portfolios).
- **What to measure next:** Measure \`oldest_wait_days\` (from 9 days toward under 3 days) and \`pending_count\` (from 16) in \`partner_ops_pending_summary\`.

Source: partner_ops_pending_summary · Period: as of 2026-10-26`,
  },
  {
    id: "ADV-06",
    area: "finance",
    callerRole: "cfo",
    question: "Looking at Treasury Cash Position vs weekly Payables, what should we do to manage liquidity this week?",
    toolName: "get_cfo_treasury_cash_position",
    rpcData: {
      source: "get_treasury_cash_position",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        total_treasury_cash_ugx: 412500000,
        a1_cash_and_bank_ugx: 385000000,
        a5_cash_in_transit_ugx: 27500000,
        a2_agent_float_ugx: 94200000,
      },
      row_count: 3,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`get_treasury_cash_position\` as of 2026-10-26.
- **Sample & caveats:** Reflects posted ledger balances for spendable treasury cash (A1 + A5) and custodial Agent Float (A2); remember A2 is not spendable company cash.

### What the data shows
- **[Evidence]** Spendable treasury cash is UGX 412,500,000 (Account A1 Cash & Bank UGX 385,000,000 plus Account A5 Cash in Transit UGX 27,500,000), while Account A2 Agent Float is UGX 94,200,000.
- **[Assumption]** Account A5 Cash in Transit (UGX 27,500,000) will settle into A1 within normal mobile-money settlement windows.
- **[Judgement]** Maintaining a strict separation between UGX 412,500,000 treasury cash and UGX 94,200,000 agent float keeps disbursement planning accurate.

### Options
- **Option 1: Pace discretionary requisition disbursements against settled A1 cash (UGX 385,000,000)**
  - *Trade-offs:* Uses only settled bank/cash balances (excluding UGX 27,500,000 in transit) for conservative liquidity buffer.
  - *Risks:* Non-urgent requisitions may wait 24 hours for A5 settlement.
  - *What would change the answer:* If A5 Cash in Transit settles intraday.
- **Option 2: Accelerate reconciliation of A2 Agent Float (UGX 94,200,000) into completed landlord payouts**
  - *Trade-offs:* Converts idle float into active Rent Plans faster without drawing down new A1 cash.
  - *Risks:* Requires Landlord Ops verification queue readiness.
  - *What would change the answer:* If most of the UGX 94,200,000 float is already matched to today's scheduled payouts.

### Recommendation and what to measure next
- **Recommendation:** Anchor weekly disbursement commitments on settled A1 cash (UGX 385,000,000) while reviewing A2 Agent Float (UGX 94,200,000) turnover with Landlord Ops.
- **What to measure next:** Track daily \`total_treasury_cash_ugx\` and \`a5_cash_in_transit_ugx\` in \`get_treasury_cash_position\`.

Source: get_treasury_cash_position · Period: as of 2026-10-26`,
  },
  {
    id: "ADV-07",
    area: "calling",
    callerRole: "tenant_ops",
    question: "Why are some Calling Center attempts not reaching tenants, and what are our options to improve reach rate?",
    toolName: "get_insight_calling_reach_and_themes",
    rpcData: {
      source: "cc_weekly_all_calls_report + cc_feedback",
      period: { from: "2026-09-27", to: FIXED_EVAL_DATE },
      data: {
        total_attempts: 2410,
        engaged_calls: 1788,
        engaged_rate_pct: 74.2,
        no_answer_calls: 462,
        switched_off_calls: 160,
      },
      row_count: 3,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`cc_weekly_all_calls_report + cc_feedback\` from 2026-09-27 to 2026-10-26.
- **Sample & caveats:** 2,410 deduplicated call attempts; outcomes do not record time-of-day per attempt in the summary totals.

### What the data shows
- **[Evidence]** Out of 2,410 call attempts, 1,788 were engaged (74.2%), while 462 were no-answer and 160 were switched-off.
- **[Assumption]** Many of the 462 no-answer attempts occur during working hours when tenants are away from their phones.
- **[Judgement]** Retrying the 462 no-answer numbers in a different time window is more productive than repeatedly dialling the 160 switched-off lines on the same day.

### Options
- **Option 1: Shift retry queues for the 462 no-answer attempts to early morning (08:00–09:30) and evening (17:00–18:30)**
  - *Trade-offs:* Tests different availability windows without increasing total dial volume.
  - *Risks:* Requires staggering caller break schedules.
  - *What would change the answer:* If hour-by-hour logs show no difference in pickup rates across the day.
- **Option 2: Route the 160 switched-off cases to the assigned field agent after 2 failed days**
  - *Trade-offs:* Uses local agent contact when a phone is persistently off.
  - *Risks:* Increases field agent task load if triggered too early.
  - *What would change the answer:* If most switched-off phones come back online the next morning.

### Recommendation and what to measure next
- **Recommendation:** Implement Option 1 for no-answer retries this week and apply Option 2 only after 48 hours of switched-off outcomes.
- **What to measure next:** Track \`engaged_rate_pct\` (from 74.2%) and \`no_answer_calls\` (from 462) in \`cc_weekly_all_calls_report\`.

Source: cc_weekly_all_calls_report + cc_feedback · Period: 2026-09-27 to 2026-10-26`,
  },
  {
    id: "ADV-08",
    area: "hr",
    callerRole: "hr",
    question: "We have 5 staff contracts expiring within 60 days — what should we do to plan renewals smoothly?",
    toolName: "get_hr_contracts_and_birthdays",
    rpcData: {
      source: "assistant_staff_hr_contracts_and_birthdays",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        expiring_within_60_days: 5,
        expiring_within_30_days: 2,
        upcoming_birthdays_count: 9,
      },
      row_count: 5,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`assistant_staff_hr_contracts_and_birthdays\` as of 2026-10-26.
- **Sample & caveats:** Small sample of 5 expiring contracts (2 within 30 days); does not include performance appraisal scores.

### What the data shows
- **[Evidence]** 5 staff contracts expire within the next 60 days, including 2 expiring within 30 days.
- **[Assumption]** Department managers need at least 2 weeks to complete review notes and confirm budget head approval with COO/CFO.
- **[Judgement]** The 2 contracts expiring within 30 days require immediate manager check-ins this week to avoid last-minute extensions.

### Options
- **Option 1: Start manager renewal reviews at Day -45 for all 5 contracts (prioritizing the 2 under 30 days today)**
  - *Trade-offs:* Gives staff and managers clear notice and avoids payroll cut-off surprises.
  - *Risks:* Requires managers to complete reviews alongside weekly operational tasks.
  - *What would change the answer:* If any of the 5 roles are temporary fixed-term projects not scheduled for renewal.
- **Option 2: Batch all 5 contract reviews into the monthly HR & COO review meeting**
  - *Trade-offs:* Single consolidated sign-off session for leadership.
  - *Risks:* Too slow for the 2 contracts already inside the 30-day window.
  - *What would change the answer:* If the monthly meeting is already scheduled within the next 48 hours.

### Recommendation and what to measure next
- **Recommendation:** Use Option 1 — initiate manager review forms today for the 2 contracts inside 30 days and schedule the remaining 3 this week.
- **What to measure next:** Track \`expiring_within_30_days\` (from 2 to 0 unreviewed) in \`assistant_staff_hr_contracts_and_birthdays\`.

Source: assistant_staff_hr_contracts_and_birthdays · Period: as of 2026-10-26`,
  },
  {
    id: "ADV-09",
    area: "tenants",
    callerRole: "coo",
    question: "Arrears ageing shows UGX 74,740,163 in the 30+ day bucket — what should we do to address older arrears?",
    toolName: "get_tops_arrears_ageing",
    rpcData: {
      source: "tops_arrears_ageing_amclock",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        summary: {
          "1-7": { count: 210, arrears_ugx: 15292479 },
          "8-14": { count: 165, arrears_ugx: 38489445 },
          "15-30": { count: 140, arrears_ugx: 63698875 },
          "30+": { count: 115, arrears_ugx: 74740163 },
          total_plans: 630,
          total_arrears_ugx: 192220962,
        },
      },
      row_count: 4,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`tops_arrears_ageing_amclock\` as of 2026-10-26.
- **Sample & caveats:** 630 Rent Plans in arrears totaling UGX 192,220,962; bucket totals do not separate partial-paying tenants from zero-payment tenants.

### What the data shows
- **[Evidence]** Total arrears are UGX 192,220,962 across 630 Rent Plans: 1-7 days has 210 plans (UGX 15,292,479), 8-14 days has 165 plans (UGX 38,489,445), 15-30 days has 140 plans (UGX 63,698,875), and 30+ days has 115 plans (UGX 74,740,163).
- **[Assumption]** Preventing the 140 plans in the 15-30 day bucket (UGX 63,698,875) from rolling into 30+ is easier than recovering long-dormant 30+ balances.
- **[Judgement]** A split approach is needed so callers do not spend all their time on the 115 oldest plans while the 140 plans in 15-30 days slip further.

### Options
- **Option 1: Dedicate a specialist recovery queue to the 115 plans in 30+ days while keeping main callers on 8-30 days**
  - *Trade-offs:* Protects Cure rates on the 165 (8-14d) and 140 (15-30d) plans while giving structured restructuring/recovery attention to the 115 plans in 30+ days.
  - *Risks:* Specialist queue capacity must match the 115 plans.
  - *What would change the answer:* If a small number of agents account for most of the UGX 74,740,163 in 30+ days.
- **Option 2: Focus all field agent recovery visits strictly on the 115 plans in the 30+ bucket**
  - *Trade-offs:* Targets the largest single UGX bucket (UGX 74,740,163).
  - *Risks:* Leaves the UGX 63,698,875 in 15-30 days without field support, risking fresh roll-over into 30+.
  - *What would change the answer:* If 15-30 day plans are already curing via phone collection.

### Recommendation and what to measure next
- **Recommendation:** Adopt Option 1 — ring-fence a recovery team for the 115 plans (UGX 74,740,163) in 30+ days and hold a hard stop-roll target on the 140 plans in 15-30 days.
- **What to measure next:** Measure weekly roll-into-30+ count (from 115 plans) and 15-30 day arrears (from UGX 63,698,875) in \`tops_arrears_ageing_amclock\`.

Source: tops_arrears_ageing_amclock · Period: as of 2026-10-26`,
  },
  {
    id: "ADV-10",
    area: "agents",
    callerRole: "agent_ops",
    question: "How should we improve house listing verification quality and reduce agent advance risk?",
    toolName: "get_aops_listing_quality_and_risk",
    rpcData: {
      source: "assistant_staff_aops_listing_quality_and_risk",
      period: { from: "2026-09-27", to: FIXED_EVAL_DATE },
      data: {
        total_listings: 410,
        verified_listings: 312,
        waiting_verification: 68,
        rejected_listings: 30,
        advance_no_listings_agents: 9,
      },
      row_count: 9,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`assistant_staff_aops_listing_quality_and_risk\` from 2026-09-27 to 2026-10-26.
- **Sample & caveats:** 410 house listings and 9 flagged advance-risk agents over 30 days; rejection reasons are not broken down by photo vs GPS in the summary.

### What the data shows
- **[Evidence]** Out of 410 listings in the last 30 days, 312 are verified, 68 are waiting verification, and 30 were rejected; additionally, 9 agents hold an advance with 0 listings.
- **[Assumption]** The 68 waiting listings and 30 rejections suggest field agents need clearer pre-submission checklists.
- **[Judgement]** Addressing the 9 agents holding advances with 0 listings and clearing the 68 waiting verifications are the two immediate priorities.

### Options
- **Option 1: Pause new advance top-ups for the 9 zero-listing agents until team leaders review their activity**
  - *Trade-offs:* Stops further exposure on inactive advance holders without affecting the 312 verified listing producers.
  - *Risks:* Some of the 9 agents may have pending tenant applications not yet reflected as house listings.
  - *What would change the answer:* If any of the 9 agents were onboarded within the last 48 hours.
- **Option 2: Run a 48-hour verification sprint on the 68 waiting listings and share the top rejection causes**
  - *Trade-offs:* Releases verified inventory for Rent Plans and reduces future rejections below 30.
  - *Risks:* High verification volume can rush quality checks if not spot-checked.
  - *What would change the answer:* If the 68 waiting listings are missing landlord phone numbers.

### Recommendation and what to measure next
- **Recommendation:** Execute both Option 1 (team leader review of the 9 advance-no-listing agents) and Option 2 (clear the 68 waiting verifications) this week.
- **What to measure next:** Track \`waiting_verification\` (from 68) and \`advance_no_listings_agents\` (from 9) in \`assistant_staff_aops_listing_quality_and_risk\`.

Source: assistant_staff_aops_listing_quality_and_risk · Period: 2026-09-27 to 2026-10-26`,
  },
  {
    id: "ADV-11",
    area: "finance",
    callerRole: "cfo",
    question: "Review our budget position and advise on handling departments nearing their approved budget limit.",
    toolName: "get_cfo_budget_revised_position",
    rpcData: {
      source: "budget_revised_position",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        original_budget_ugx: 320000000,
        approved_supplements_ugx: 35000000,
        revised_budget_ugx: 355000000,
        spent_to_date_ugx: 298000000,
        remaining_budget_ugx: 57000000,
        heads_over_85_pct: 3,
      },
      row_count: 3,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`budget_revised_position\` as of 2026-10-26.
- **Sample & caveats:** Covers UGX 355,000,000 revised budget (UGX 320,000,000 original plus UGX 35,000,000 CFO-approved supplements); remember original budget lines are never edited.

### What the data shows
- **[Evidence]** Total revised budget is UGX 355,000,000, spent to date is UGX 298,000,000, and remaining budget is UGX 57,000,000, with 3 budget heads above 85% utilization.
- **[Assumption]** The 3 budget heads over 85% utilization may submit requisitions before month-end that exceed their remaining allocation.
- **[Judgement]** Early review of the 3 high-utilization budget heads prevents last-minute requisition blocks at the CFO stage.

### Options
- **Option 1: Require the 3 budget heads above 85% to prioritize essential requisitions within the remaining UGX 57,000,000**
  - *Trade-offs:* Preserves overall budget discipline without adding new supplements beyond UGX 35,000,000.
  - *Risks:* Could defer non-urgent operational purchases to next month.
  - *What would change the answer:* If a high-utilization head is driven by volume-linked growth costs.
- **Option 2: Prepare formal supplementary budget requests via \`budget_supplements\` where spend is tied to verified revenue growth**
  - *Trade-offs:* Keeps the audit trail clean in \`budget_revised_position\` while funding justified activity.
  - *Risks:* Increases total revised spend above UGX 355,000,000.
  - *What would change the answer:* If treasury cash buffer tightens before month-end.

### Recommendation and what to measure next
- **Recommendation:** Apply Option 1 by default for the 3 budget heads over 85%, using Option 2 only where spend is directly tied to Rent Plan collections.
- **What to measure next:** Track \`remaining_budget_ugx\` (from UGX 57,000,000) and \`heads_over_85_pct\` (from 3) in \`budget_revised_position\`.

Source: budget_revised_position · Period: as of 2026-10-26`,
  },
  {
    id: "ADV-12",
    area: "operations",
    callerRole: "ceo",
    question: "What should we do to accelerate active Rent Plan growth while keeping approval queues healthy?",
    toolName: "get_ceo_growth_and_approvals",
    rpcData: {
      source: "assistant_staff_ceo_growth_and_approvals",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        active_rent_plans: 1420,
        new_plans_30d: 318,
        pending_ceo_approvals: 4,
        collection_rate_pct: 86.4,
      },
      row_count: 1,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`assistant_staff_ceo_growth_and_approvals\` as of 2026-10-26.
- **Sample & caveats:** Platform-level snapshot of 1,420 active Rent Plans and 318 new plans over 30 days; district-level breakdown requires an Analyst or Agent Ops query.

### What the data shows
- **[Evidence]** Welile has 1,420 active Rent Plans (318 funded in the last 30 days), an 86.4% collection rate, and 4 requisitions awaiting CEO approval.
- **[Assumption]** Sustaining 318+ new plans per 30 days depends on both Supporter funding readiness and maintaining collection rates above 86.4%.
- **[Judgement]** Growth should be concentrated in parishes and agent teams that already achieve above-average collection rates rather than broad expansion.

### Options
- **Option 1: Tie new Rent Plan allocation priority to agent teams with >86.4% collection performance**
  - *Trade-offs:* Grows the 1,420 active Rent Plan book while protecting portfolio quality and Supporter Returns.
  - *Risks:* Newer agents in developing areas may grow more slowly until their initial cohort matures.
  - *What would change the answer:* If high-performing teams are already at capacity on verified house listings.
- **Option 2: Clear pipeline desk wait times to convert existing approved applications faster**
  - *Trade-offs:* Increases funded volume from the current pipeline without relaxing vetting rules.
  - *Risks:* Requires Landlord Ops and FinOps payout turnaround to keep pace.
  - *What would change the answer:* If pipeline applications are bottlenecked on Supporter liquidity rather than desk reviews.

### Recommendation and what to measure next
- **Recommendation:** Combine Option 1 (quality-weighted growth) with Option 2 (desk turnaround) and clear the 4 pending CEO approvals today.
- **What to measure next:** Track \`new_plans_30d\` (from 318) and \`collection_rate_pct\` (from 86.4%) in \`assistant_staff_ceo_growth_and_approvals\`.

Source: assistant_staff_ceo_growth_and_approvals · Period: as of 2026-10-26`,
  },
  {
    id: "ADV-13",
    area: "tenants",
    callerRole: "tenant_ops",
    question: "Why are some tenants not using phone collection yet, and how could we increase smartphone collection adoption?",
    toolName: "get_tops_smartphone_usage",
    rpcData: {
      source: "assistant_staff_tops_smartphone_usage",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        active_plans: 1420,
        phone_collection_enabled_count: 890,
        field_collection_only_count: 530,
        smartphone_share_pct: 62.7,
      },
      row_count: 2,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`assistant_staff_tops_smartphone_usage\` as of 2026-10-26.
- **Sample & caveats:** 1,420 active Rent Plans (890 phone-collection enabled, 530 field-collection only); does not show whether the 530 tenants own a smartphone or feature phone.

### What the data shows
- **[Evidence]** 890 of 1,420 active Rent Plans (62.7%) have phone collection enabled, leaving 530 plans on field collection only.
- **[Assumption]** A subset of the 530 field-collection tenants have mobile money access but were not enrolled in phone collection during onboarding.
- **[Judgement]** Converting eligible tenants among the 530 plans to phone collection will reduce silent-collector risk and speed up daily reconciliation.

### Options
- **Option 1: Prompt phone-collection enrollment during Calling Center awareness and onboarding calls**
  - *Trade-offs:* Reaches tenants directly at zero field cost and verifies their active mobile-money number.
  - *Risks:* Tenants without reliable network or phone access still require field agent collection.
  - *What would change the answer:* If most of the 530 tenants do not have a personal mobile-money line.
- **Option 2: Incentivize field agents to assist tenants with their first digital repayment**
  - *Trade-offs:* Builds tenant confidence during the first week of a Rent Plan.
  - *Risks:* Some agents may prefer cash collection unless commission attribution is clearly explained.
  - *What would change the answer:* If smartphone adoption in new cohorts is already above the current 62.7% share.

### Recommendation and what to measure next
- **Recommendation:** Start with Option 1 during Day-1 and weekly Calling Center calls, supported by Option 2 for new Rent Plans.
- **What to measure next:** Track \`smartphone_share_pct\` (from 62.7%) and \`phone_collection_enabled_count\` (from 890) in \`assistant_staff_tops_smartphone_usage\`.

Source: assistant_staff_tops_smartphone_usage · Period: as of 2026-10-26`,
  },
  {
    id: "ADV-14",
    area: "landlords",
    callerRole: "landlord_ops",
    question: "What are our options for handling the 'Check first' flagged rows in the Landlord Calling Hub?",
    toolName: "get_lops_calling_summary",
    rpcData: {
      source: "landlord_cc_weekly_report",
      period: { from: "2026-10-21", to: FIXED_EVAL_DATE },
      data: {
        live_rent_plans_landlords: 1120,
        plans_in_progress_landlords: 94,
        check_first_flagged_count: 42,
        calls_logged_week: 310,
      },
      row_count: 3,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`landlord_cc_weekly_report\` for the Kampala week 2026-10-21 to 2026-10-26.
- **Sample & caveats:** 1,120 landlords with live Rent Plans, 94 in progress, and 42 flagged in Check first; individual flag reasons require opening the dossier.

### What the data shows
- **[Evidence]** The hub shows 1,120 landlords with live Rent Plans, 94 with plans in progress, 310 calls logged this week, and 42 rows in the Check first tab.
- **[Assumption]** The 42 Check first rows include shared phone numbers, tenant-role overlaps, or unusually high plan counts that would waste caller time if dialled blindly.
- **[Judgement]** Keeping callers focused on the 1,120 live and 94 in-progress landlords while supervisors review the 42 Check first dossiers protects call quality.

### Options
- **Option 1: Supervisor dossier review of the 42 Check first rows (sorting by active Rent Plan count first)**
  - *Trade-offs:* Prevents callers from dialling look-alike or test accounts while ensuring any real landlord among the 42 is verified.
  - *Risks:* Takes 1–2 hours of supervisor review time.
  - *What would change the answer:* If all 42 rows have zero active or in-progress Rent Plans.
- **Option 2: Require field agents to confirm landlord identity before any Check first row is cleared**
  - *Trade-offs:* Pushes verification back to the originating agent.
  - *Risks:* Slower if the registering agent is no longer active.
  - *What would change the answer:* If most of the 42 flags are simple duplicate phone entries.

### Recommendation and what to measure next
- **Recommendation:** Use Option 1 — have a Landlord Ops supervisor review the 42 Check first dossiers starting with any row attached to an active Rent Plan.
- **What to measure next:** Track \`check_first_flagged_count\` reviewed (from 42) and weekly engaged calls (from 310) in \`landlord_cc_weekly_report\`.

Source: landlord_cc_weekly_report · Period: 2026-10-21 to 2026-10-26`,
  },
  {
    id: "ADV-15",
    area: "supporters",
    callerRole: "partner_ops",
    question: "How should we prepare for upcoming Supporter Returns payouts due this cycle?",
    toolName: "get_pops_returns_due",
    rpcData: {
      source: "assistant_staff_pops_returns_due",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        nearing_payout_count: 24,
        nearing_payout_returns_ugx: 86400000,
        due_within_7_days_count: 9,
        due_within_7_days_ugx: 31200000,
      },
      row_count: 24,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`assistant_staff_pops_returns_due\` as of 2026-10-26.
- **Sample & caveats:** 24 Supporter portfolios nearing Returns payout (UGX 86,400,000), with 9 due within 7 days (UGX 31,200,000); does not predict rollover vs cash-out election until PSOs confirm.

### What the data shows
- **[Evidence]** 24 Supporter portfolios have UGX 86,400,000 in Returns nearing payout, including 9 portfolios (UGX 31,200,000) due within the next 7 days.
- **[Assumption]** Some Supporters among the 9 due within 7 days will choose to compound/reinvest if contacted ahead of the due-by cutoff.
- **[Judgement]** Early PSO check-ins on the 9 portfolios (UGX 31,200,000) give CFO accurate cash-out vs reinvestment visibility.

### Options
- **Option 1: PSO outreach 7 days before cutoff for the 9 portfolios (UGX 31,200,000) due this week**
  - *Trade-offs:* Confirms payout or rollover preference early and avoids duplicate payout requests.
  - *Risks:* Requires PSOs to log preferences promptly so FinOps has a clean queue.
  - *What would change the answer:* If all 9 portfolios already have standing payout instructions on file.
- **Option 2: Pre-stage CFO cycle permissions for all 24 nearing-payout portfolios (UGX 86,400,000)**
  - *Trade-offs:* Smooths FinOps processing across the full cycle.
  - *Risks:* Premature if several Supporters elect to roll over their Returns.
  - *What would change the answer:* If historical rollover rates are near zero for this cohort.

### Recommendation and what to measure next
- **Recommendation:** Execute Option 1 immediately for the 9 portfolios (UGX 31,200,000) due within 7 days, then share confirmed cash-out totals with CFO.
- **What to measure next:** Track \`due_within_7_days_count\` (from 9) and on-time Returns settlement in \`assistant_staff_pops_returns_due\`.

Source: assistant_staff_pops_returns_due · Period: as of 2026-10-26`,
  },
  {
    id: "ADV-16",
    area: "finance",
    callerRole: "financial_ops",
    question: "Why is our Financial Ops verification and requisition queue building up, and what should we do today?",
    toolName: "get_fops_verification_and_requisitions",
    rpcData: {
      source: "finops_payout_verification_counts + staff_requisitions",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        pending_payout_verifications: 27,
        approved_requisitions_awaiting_disbursement: 11,
        awaiting_disbursement_ugx: 34600000,
      },
      row_count: 11,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`finops_payout_verification_counts + staff_requisitions\` as of 2026-10-26.
- **Sample & caveats:** 27 pending landlord payout verifications and 11 CFO-approved requisitions awaiting disbursement (UGX 34,600,000).

### What the data shows
- **[Evidence]** Financial Ops has 27 pending landlord payout verifications and 11 CFO-approved requisitions awaiting disbursement totaling UGX 34,600,000.
- **[Assumption]** Running payout verifications and requisition disbursements in a single unsegmented queue slows down both streams.
- **[Judgement]** Splitting the desk between the 27 landlord payout verifications (which unlock Rent Plans) and the 11 approved requisitions will clear the backlog faster.

### Options
- **Option 1: Dedicated morning block for the 27 landlord payout verifications and afternoon batch for the 11 requisitions (UGX 34,600,000)**
  - *Trade-offs:* Eliminates context switching between landlord mobile-money checks and staff requisition vouchers.
  - *Risks:* Urgent afternoon landlord payouts need a fast-lane exception.
  - *What would change the answer:* If all 11 requisitions are time-critical field operations items needed before noon.
- **Option 2: Assign one verifier exclusively to landlord payouts and one to requisitions all day**
  - *Trade-offs:* Parallel progress on both the 27 verifications and 11 requisitions.
  - *Risks:* Less flexible if one staff member is away.
  - *What would change the answer:* If only one Financial Ops verifier is on shift today.

### Recommendation and what to measure next
- **Recommendation:** Use Option 2 if two verifiers are on shift today (otherwise Option 1), prioritizing landlord payouts where tenants are already repaying.
- **What to measure next:** Track \`pending_payout_verifications\` (from 27) and \`approved_requisitions_awaiting_disbursement\` (from 11) in \`finops_payout_verification_counts + staff_requisitions\`.

Source: finops_payout_verification_counts + staff_requisitions · Period: as of 2026-10-26`,
  },
  {
    id: "ADV-17",
    area: "hr",
    callerRole: "hr",
    question: "Review our department payroll cost distribution and advise on what HR and CFO should monitor.",
    toolName: "get_hr_payroll_cost_by_department",
    rpcData: {
      source: "assistant_staff_hr_payroll_cost_by_department",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        total_monthly_payroll_ugx: 118500000,
        active_staff_count: 64,
        operations_share_pct: 46.2,
      },
      row_count: 6,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`assistant_staff_hr_payroll_cost_by_department\` as of 2026-10-26.
- **Sample & caveats:** Covers 64 active staff with monthly payroll of UGX 118,500,000; does not include variable field agent commissions (which are separate from staff payroll).

### What the data shows
- **[Evidence]** Total monthly staff payroll is UGX 118,500,000 across 64 active staff members, with Operations accounting for 46.2% of payroll cost.
- **[Assumption]** Operations holds the largest share (46.2%) because Tenant Ops, Landlord Ops, Agent Ops, and Calling Center teams scale with Rent Plan volume.
- **[Judgement]** Monitoring active Rent Plans per Operations staff member is more informative than looking at the UGX 118,500,000 total in isolation.

### Options
- **Option 1: Track active Rent Plans and call volume per Operations staff member alongside monthly payroll**
  - *Trade-offs:* Links the 46.2% Operations payroll share directly to workload and throughput.
  - *Risks:* Needs consistent department tagging in \`hr_staff\`.
  - *What would change the answer:* If new hiring is planned primarily in non-operations roles.
- **Option 2: Pre-verify statutory TIN/NSSF consent completeness 5 days before payroll run**
  - *Trade-offs:* Prevents payroll batch delays on the UGX 118,500,000 run.
  - *Risks:* Requires early follow-up with any newly onboarded staff among the 64 employees.
  - *What would change the answer:* If 100% of the 64 active staff already have verified statutory records.

### Recommendation and what to measure next
- **Recommendation:** Adopt both Option 1 (throughput per Operations headcount) and Option 2 (pre-payroll statutory check across all 64 staff).
- **What to measure next:** Track \`total_monthly_payroll_ugx\` (UGX 118,500,000) and \`active_staff_count\` (64) against active Rent Plans each month.

Source: assistant_staff_hr_payroll_cost_by_department · Period: as of 2026-10-26`,
  },
  {
    id: "ADV-18",
    area: "calling",
    callerRole: "crm",
    question: "Zoe logged 8 unanswered questions and 3 thumbs-down ratings — what should we do to improve Zoe's answers?",
    toolName: "get_insight_zoe_feedback_themes",
    rpcData: {
      source: "staff_assistant_unanswered + staff_assistant_feedback",
      period: { from: "2026-09-29", to: FIXED_EVAL_DATE, days: 28 },
      total_unanswered_count: 8,
      total_thumbs_down_count: 3,
      row_count: 3,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`staff_assistant_unanswered + staff_assistant_feedback\` over the 28-day window (2026-09-29 to 2026-10-26).
- **Sample & caveats:** Small sample of 8 unanswered questions and 3 thumbs-down ratings; redacted view shows question, role, and outcome without exposing individual staff answers.

### What the data shows
- **[Evidence]** Over the last 28 days, Zoe recorded 8 unanswered questions and 3 thumbs-down feedback ratings.
- **[Assumption]** Repeated unanswered questions usually point to either a missing glossary definition or a phrasing gap on an existing report tool.
- **[Judgement]** Reviewing the weekly redacted unanswered list every Monday allows managers to close the top gaps systematically.

### Options
- **Option 1: Add missing term definitions to the Manager Glossary Editor in My Space**
  - *Trade-offs:* Immediately helps Zoe explain Welile measurement rules without needing a database migration.
  - *Risks:* Only solves definition/gotcha questions, not missing data columns.
  - *What would change the answer:* If all 8 unanswered items were caused by timeouts or missing SQL views.
- **Option 2: Promote any Analyst \`zoe_ro\` query asked 3+ times into a certified lookup tool**
  - *Trade-offs:* Gives staff a fast certified tool for recurring questions.
  - *Risks:* Requires engineering review and migration deployment.
  - *What would change the answer:* If the questions are one-off ad-hoc explorations already answered by the Analyst lane.

### Recommendation and what to measure next
- **Recommendation:** Use Option 1 immediately for terminology/gotcha questions and queue Option 2 for any question theme appearing 3 or more times in the weekly manager list.
- **What to measure next:** Track weekly \`total_unanswered_count\` (from 8) and \`total_thumbs_down_count\` (from 3) in \`assistant_staff_insight_zoe_feedback_themes\`.

Source: staff_assistant_unanswered + staff_assistant_feedback · Period: 2026-09-29 to 2026-10-26`,
  },
  {
    id: "ADV-19",
    area: "agents",
    callerRole: "agent_ops",
    question: "Why do some sub-agent teams outperform others in Rent Plan onboarding, and what should we do to lift lagging teams?",
    toolName: "get_aops_subagent_teams",
    rpcData: {
      source: "assistant_staff_aops_subagent_teams",
      period: { as_of: FIXED_EVAL_DATE },
      data: {
        team_leaders_count: 38,
        total_subagents_count: 214,
        active_subagents_30d: 148,
        inactive_subagents_30d: 66,
      },
      row_count: 38,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`assistant_staff_aops_subagent_teams\` as of 2026-10-26.
- **Sample & caveats:** 38 team leaders and 214 sub-agents (148 active in the last 30 days, 66 inactive); correlation between team size and activity does not prove causation.

### What the data shows
- **[Evidence]** Across 38 team leaders and 214 sub-agents, 148 sub-agents were active in the last 30 days while 66 sub-agents were inactive.
- **[Assumption]** The 66 inactive sub-agents may be concentrated under team leaders who recruited large teams without accompanying them on first house listings.
- **[Judgement]** Coaching the 38 team leaders on activating their existing 66 inactive sub-agents is higher-return than recruiting new sub-agents right now.

### Options
- **Option 1: Pair each of the 66 inactive sub-agents with their team leader for joint house-listing visits this week**
  - *Trade-offs:* Transfers practical field skills directly and tests which of the 66 sub-agents are still committed.
  - *Risks:* Takes team leader time away from their own individual listings for a few days.
  - *What would change the answer:* If most of the 66 inactive sub-agents have already left the area.
- **Option 2: Pause new sub-agent recruitment for any team leader whose active sub-agent ratio is below the platform 69.2% active rate (148 of 214)**
  - *Trade-offs:* Focuses the 38 team leaders on quality and activation over raw recruitment counts.
  - *Risks:* Could slow recruitment in newly opened parishes.
  - *What would change the answer:* If inactive sub-agents are mostly awaiting initial vetting approval.

### Recommendation and what to measure next
- **Recommendation:** Roll out Option 1 this week for the 66 inactive sub-agents, and apply Option 2 for team leaders with persistent inactivity.
- **What to measure next:** Track \`active_subagents_30d\` (from 148 out of 214) in \`assistant_staff_aops_subagent_teams\`.

Source: assistant_staff_aops_subagent_teams · Period: as of 2026-10-26`,
  },
  {
    id: "ADV-20",
    area: "operations",
    callerRole: "coo",
    question: "Looking at our 14.5% collection coverage gap in Tenant Ops weekly performance, what is the way forward?",
    toolName: "get_tops_weekly_performance",
    rpcData: {
      source: "get_tenant_ops_weekly_performance_amclock",
      period: { from: "2026-10-20", to: FIXED_EVAL_DATE },
      data: {
        expected_ugx: 162000000,
        collected_ugx: 138510000,
        collection_rate_pct: 85.5,
        shortfall_ugx: 23490000,
      },
      row_count: 1,
      rows: [],
    },
    modelReply: `### What I looked at
- **Data source & period:** \`get_tenant_ops_weekly_performance_amclock\` for 2026-10-20 to 2026-10-26.
- **Sample & caveats:** Single-week snapshot (expected UGX 162,000,000 vs collected UGX 138,510,000); check the Welile glossary rule on expected vs collected before comparing with receipt-book totals.

### What the data shows
- **[Evidence]** Weekly expected rent is UGX 162,000,000 and collected is UGX 138,510,000 (85.5% collection rate), leaving a weekly shortfall of UGX 23,490,000 (14.5%).
- **[Assumption]** The UGX 23,490,000 shortfall is split between First 7 Days onboarding lags and early 1-7 day arrears.
- **[Judgement]** Closing the UGX 23,490,000 weekly gap requires coordinating Calling Center reminders with field agent follow-up on the same day a payment is missed.

### Options
- **Option 1: Same-day afternoon Calling Center follow-up on any Rent Plan missing its daily bill**
  - *Trade-offs:* Catches missed payments within 24 hours before a single-day slip becomes a multi-day arrear.
  - *Risks:* High daily call volume if not filtered to uncollected bills above a threshold.
  - *What would change the answer:* If most of the UGX 23,490,000 shortfall comes from a few large commercial/multi-month plans.
- **Option 2: Daily parish-level reconciliation huddles with Agent Ops on the highest shortfall areas**
  - *Trade-offs:* Focuses field effort where most of the UGX 23,490,000 shortfall sits.
  - *Risks:* Requires daily area breakdown from \`get_insight_collection_coverage_trends\`.
  - *What would change the answer:* If the shortfall is evenly spread across all parishes.

### Recommendation and what to measure next
- **Recommendation:** Combine Option 1 (same-day missed-bill calls) with Option 2 (targeting the highest shortfall areas).
- **What to measure next:** Track \`collection_rate_pct\` (from 85.5%) and \`shortfall_ugx\` (from UGX 23,490,000) in \`get_tenant_ops_weekly_performance_amclock\`.

Source: get_tenant_ops_weekly_performance_amclock · Period: 2026-10-20 to 2026-10-26`,
  },
];

/**
 * 20 "No file please" conversation & general-help cases (`NF-01`..`NF-20`).
 * Every single case must produce `fileCreated === false`.
 */
export const TWENTY_NO_FILE_CONVERSATION_CASES: readonly NoFileConversationCase[] = [
  {
    id: "NF-01",
    callerRole: "coo",
    question: "Show the COO overview numbers in chat only, no file please.",
    toolName: "get_coo_overview",
    rpcData: {
      source: "coo_overview_snapshot",
      period: { as_of: FIXED_EVAL_DATE },
      data: { active_rent_plans: 1420, coverage_ratio_pct: 84.5 },
      row_count: 2,
      rows: [
        { metric: "active_rent_plans", value: 1420 },
        { metric: "coverage_ratio_pct", value: 84.5 },
      ],
    },
    modelReply:
      "As of 2026-10-26, there are 1,420 active Rent Plans and an 84.5% coverage ratio.\n\nSource: coo_overview_snapshot · Period: as of 2026-10-26",
  },
  {
    id: "NF-02",
    callerRole: "cfo",
    question: "What is our treasury cash position today? Just text, do not generate an Excel or PDF.",
    toolName: "get_cfo_treasury_cash_position",
    rpcData: {
      source: "get_treasury_cash_position",
      period: { as_of: FIXED_EVAL_DATE },
      data: { total_treasury_cash_ugx: 412500000 },
      row_count: 1,
      rows: [{ account: "A1+A5", balance_ugx: 412500000 }],
    },
    modelReply:
      "As of 2026-10-26, spendable treasury cash is UGX 412,500,000.\n\nSource: get_treasury_cash_position · Period: as of 2026-10-26",
  },
  {
    id: "NF-03",
    callerRole: "tenant_ops",
    question: "Tell me the First 7 Days summary in plain words — no file needed.",
    toolName: "get_tops_first_seven_summary",
    rpcData: {
      source: "tops_first_seven_summary",
      period: { as_of: FIXED_EVAL_DATE },
      data: { funded_plans: 184, expected: 66541680, collected: 24580580 },
      row_count: 1,
      rows: [{ funded_plans: 184, expected: 66541680, collected: 24580580 }],
    },
    modelReply:
      "In the First 7 Days summary as of 2026-10-26, 184 funded Rent Plans have UGX 66,541,680 expected and UGX 24,580,580 collected.\n\nSource: tops_first_seven_summary · Period: as of 2026-10-26",
  },
  {
    id: "NF-04",
    callerRole: "landlord_ops",
    question: "How many landlords were verified this week? No download please.",
    toolName: "get_lops_home_range",
    rpcData: {
      source: "assistant_staff_lops_home_range",
      period: { from: "2026-10-20", to: FIXED_EVAL_DATE },
      data: { landlords_verified: 62, payouts_completed: 48 },
      row_count: 1,
      rows: [{ landlords_verified: 62, payouts_completed: 48 }],
    },
    modelReply:
      "From 2026-10-20 to 2026-10-26, Landlord Ops verified 62 landlords and completed 48 payouts.\n\nSource: assistant_staff_lops_home_range · Period: 2026-10-20 to 2026-10-26",
  },
  {
    id: "NF-05",
    callerRole: "agent_ops",
    question: "How many silent collectors do we have today? Just tell me here, no spreadsheet.",
    toolName: "get_aops_silent_collectors",
    rpcData: {
      source: "agent_ops_silent_collectors",
      period: { as_of: FIXED_EVAL_DATE },
      data: { silent_agents_count: 14 },
      row_count: 1,
      rows: [{ silent_agents_count: 14 }],
    },
    modelReply:
      "As of 2026-10-26, there are 14 silent collectors in Agent Ops.\n\nSource: agent_ops_silent_collectors · Period: as of 2026-10-26",
  },
  {
    id: "NF-06",
    callerRole: "partner_ops",
    question: "How many pending Supporter portfolios are in the queue? No PDF please.",
    toolName: "get_pops_pending_summary",
    rpcData: {
      source: "partner_ops_pending_summary",
      period: { as_of: FIXED_EVAL_DATE },
      data: { pending_count: 16, pending_total_ugx: 142000000 },
      row_count: 1,
      rows: [{ pending_count: 16, pending_total_ugx: 142000000 }],
    },
    modelReply:
      "As of 2026-10-26, Partner Ops has 16 pending Supporter portfolios totaling UGX 142,000,000.\n\nSource: partner_ops_pending_summary · Period: as of 2026-10-26",
  },
  {
    id: "NF-07",
    callerRole: "hr",
    question: "Check how many open HR tickets I have in My Space — no file.",
    toolName: "get_my_tickets",
    rpcData: {
      source: "assistant_staff_my_tickets",
      period: { as_of: FIXED_EVAL_DATE },
      data: { open_count: 2, total_count: 5 },
      row_count: 2,
      rows: [{ ticket_id: "t1", status: "open" }],
    },
    modelReply:
      "As of 2026-10-26, you have 2 open HR tickets out of 5 total in My Space.\n\nSource: assistant_staff_my_tickets · Period: as of 2026-10-26",
  },
  {
    id: "NF-08",
    callerRole: "employee",
    question: "How many pending tasks do I have in My Work today?",
    toolName: "get_my_tasks",
    rpcData: {
      source: "assistant_staff_my_tasks",
      period: { as_of: FIXED_EVAL_DATE },
      data: { pending_tasks_count: 4, overdue_count: 1 },
      row_count: 4,
      rows: [{ task: "Follow up", status: "pending" }],
    },
    modelReply:
      "As of 2026-10-26, you have 4 pending tasks in My Work (1 overdue).\n\nSource: assistant_staff_my_tasks · Period: as of 2026-10-26",
  },
  {
    id: "NF-09",
    callerRole: "employee",
    question: "What is on the canteen menu today?",
    toolName: "get_my_canteen",
    rpcData: {
      source: "assistant_staff_my_canteen",
      period: { as_of: FIXED_EVAL_DATE },
      data: { recent_orders_count: 3 },
      row_count: 3,
      rows: [{ item: "Matooke & Beef" }],
    },
    modelReply:
      "As of 2026-10-26, your My Space canteen view shows today's menu and 3 recent food orders.\n\nSource: assistant_staff_my_canteen · Period: as of 2026-10-26",
  },
  {
    id: "NF-10",
    callerRole: "employee",
    question: "Explain the difference between Expected vs Collected rent in Welile.",
    toolName: "get_welile_glossary",
    rpcData: {
      source: "staff_assistant_glossary",
      period: { as_of: FIXED_EVAL_DATE },
      row_count: 1,
      rows: [
        {
          slug: "expected_vs_collected",
          term: "Expected vs Collected Rent",
          plain_definition:
            "Expected is the daily bill due on active Rent Plans; Collected is verified repayments posted to the ledger.",
        },
      ],
    },
    modelReply:
      "In Welile, Expected rent is the contractual daily bill due on active Rent Plans, whereas Collected rent is verified repayments posted to the general ledger.\n\nSource: staff_assistant_glossary · Period: as of 2026-10-26",
  },
  {
    id: "NF-11",
    callerRole: "employee",
    question: "Draft a short polite WhatsApp message reminding a landlord to keep their phone on for verification.",
    toolName: null,
    rpcData: null,
    modelReply:
      "Hello! This is the Welile Landlord Operations team. We will be calling shortly to verify your Rent Plan payout details. Kindly keep your registered phone line on so we can complete verification smoothly. Thank you!",
  },
  {
    id: "NF-12",
    callerRole: "tenant_ops",
    question: "Help me structure a 15-minute morning standup agenda for the Tenant Ops team.",
    toolName: null,
    rpcData: null,
    modelReply:
      "Here is a focused 15-minute Tenant Ops standup agenda:\n1. First 7 Days check (5 mins): Review zero-payment plans from yesterday.\n2. Desk wait times (5 mins): Assign oldest open Rent Plan requests.\n3. Arrears & Calling handoffs (5 mins): Confirm priority escalations and blockers.",
  },
  {
    id: "NF-13",
    callerRole: "landlord_ops",
    question: "Review this idea: what if we call landlords twice a day instead of once? Just share your thoughts in text.",
    toolName: null,
    rpcData: null,
    modelReply:
      "Calling landlords in two distinct windows (morning and late afternoon) is a practical idea because landlords who miss a morning call during work hours are often reachable after 16:30. Keep the 15-minute deduplication rule in mind and log every attempt in the Landlord Calling Hub.",
  },
  {
    id: "NF-14",
    callerRole: "agent_ops",
    question: "Draft a 3-point checklist for field agents before they submit a house listing.",
    toolName: null,
    rpcData: null,
    modelReply:
      "Field Agent House Listing Checklist:\n- Confirm the landlord's active mobile-money number and full registered name.\n- Capture clear photos and accurate Uganda location hierarchy (district, sub-county, parish, village).\n- Verify LC1 details and monthly Rent Plan amount before submitting.",
  },
  {
    id: "NF-15",
    callerRole: "partner_ops",
    question: "Explain why we always say Rent Plan, Supporter, and Returns at Welile.",
    toolName: null,
    rpcData: null,
    modelReply:
      "Welile uses mandatory regulatory terminology across all screens and communications: we facilitate a Rent Plan for a tenant, backed by a Supporter who earns Returns.",
  },
  {
    id: "NF-16",
    callerRole: "cfo",
    question: "Explain the difference between Account A1/A5 treasury cash and Account A2 agent float.",
    toolName: "get_welile_glossary",
    rpcData: {
      source: "staff_assistant_glossary",
      period: { as_of: FIXED_EVAL_DATE },
      row_count: 1,
      rows: [
        {
          slug: "treasury_cash_vs_wallet_liability",
          term: "Treasury Cash vs Agent Float",
        },
      ],
    },
    modelReply:
      "Accounts A1 (Cash & Bank) and A5 (Cash in Transit) represent Welile's spendable treasury cash, whereas Account A2 (Agent Float) is custodial float held by agents for landlord payouts and is not spendable company cash.\n\nSource: staff_assistant_glossary · Period: as of 2026-10-26",
  },
  {
    id: "NF-17",
    callerRole: "hr",
    question: "Draft a brief welcome note for a new Calling Center officer joining Welile.",
    toolName: null,
    rpcData: null,
    modelReply:
      "Welcome to the Welile Calling Center team! In your first week, we will walk you through My Space, the Tenant and Landlord Calling Hubs, our Wednesday-to-Tuesday reporting week, and how we support tenants on their Rent Plans.",
  },
  {
    id: "NF-18",
    callerRole: "coo",
    question: "Good morning Zoe, what can you help me with today?",
    toolName: null,
    rpcData: null,
    modelReply:
      "Good morning! I can look up your My Space items and official COO, Tenant Ops, Landlord Ops, Agent Ops, Partner Ops, HR, Calling, and Finance reports, run read-only Analyst queries on zoe_ro views, give structured Consultant advice, or help draft memos and plans.",
  },
  {
    id: "NF-19",
    callerRole: "financial_ops",
    question: "Show my requisitions count in My Space — no file export.",
    toolName: "get_my_requisitions",
    rpcData: {
      source: "assistant_staff_my_requisitions",
      period: { as_of: FIXED_EVAL_DATE },
      data: { total_count: 3 },
      row_count: 3,
      rows: [{ id: "r1", status: "approved" }],
    },
    modelReply:
      "As of 2026-10-26, you have 3 staff requisitions tracked in My Space.\n\nSource: assistant_staff_my_requisitions · Period: as of 2026-10-26",
  },
  {
    id: "NF-20",
    callerRole: "tenant_ops",
    question: "How many pending Calling Center concerns are assigned to me? No file.",
    toolName: "get_my_pending_concerns",
    rpcData: {
      source: "assistant_staff_my_pending_concerns",
      period: { as_of: FIXED_EVAL_DATE },
      data: { pending_concerns_count: 2 },
      row_count: 2,
      rows: [{ id: "c1", status: "pending" }],
    },
    modelReply:
      "As of 2026-10-26, you have 2 pending Calling Center concerns awaiting your review.\n\nSource: assistant_staff_my_pending_concerns · Period: as of 2026-10-26",
  },
];

export async function runRealWorldEvalPack(options?: {
  baselinePassingIds?: readonly string[];
  liveSummary?: LiveEvalSummary;
  analystSummary?: AnalystEvalSummary;
}): Promise<RealWorldEvalSummary> {
  const liveSummary =
    options?.liveSummary ??
    (await runLiveEvalPack({
      baselinePassingIds: options?.baselinePassingIds,
    }));
  const analystSummary = options?.analystSummary ?? (await runAnalystEvalPack());

  // 1. Run the 8 logged failures (`LF-01`..`LF-08`)
  let loggedFailuresPassed = 0;
  let noFileInvariantPassed = 0;
  let noFileInvariantTotal = 0;

  for (const lf of EIGHT_LOGGED_FAILURE_CASES) {
    const turn = await executeZoeTurn({
      callerRoles: [lf.callerRole],
      mfaAal2: true,
      userMessage: lf.question,
      modelToolCalls: lf.toolName ? [{ name: lf.toolName, args: {} }] : [],
      modelFinalText: lf.modelReply,
      rpcDataByTool: lf.toolName && lf.rpcData ? { [lf.toolName]: lf.rpcData } : {},
    });

    const guard = checkAnswer(
      turn.reply,
      lf.rpcData ? [JSON.stringify(lf.rpcData)] : [],
      lf.question,
    );
    const allNumsPresent = lf.expectedNumbers.every(
      (n) => turn.reply.includes(String(n)) || turn.reply.includes(n.toLocaleString("en-US")),
    );
    const fileDecision = evaluateZoeFileRequest({
      userPrompt: lf.question,
      assistantMessage: {
        content: turn.reply,
        reportPayload: turn.reportPayload,
      },
    });
    noFileInvariantTotal += 1;
    if (!fileDecision.fileCreated) noFileInvariantPassed += 1;

    if (turn.outcome === "answered" && guard.ok && allNumsPresent && !fileDecision.fileCreated) {
      loggedFailuresPassed += 1;
    }
  }

  // 2. Run the 12 new certified questions (`NQ-01`..`NQ-12`)
  let newCertifiedPassed = 0;
  for (const nq of TWELVE_NEW_CERTIFIED_QUESTIONS) {
    const turn = await executeZoeTurn({
      callerRoles: [nq.callerRole],
      mfaAal2: true,
      userMessage: nq.question,
      modelToolCalls: [{ name: nq.toolName, args: {} }],
      modelFinalText: nq.modelReply,
      rpcDataByTool: { [nq.toolName]: nq.rpcData },
    });

    const guard = checkAnswer(turn.reply, [JSON.stringify(nq.rpcData)], nq.question);
    const allNumsPresent = nq.expectedNumbers.every(
      (n) => turn.reply.includes(String(n)) || turn.reply.includes(n.toLocaleString("en-US")),
    );
    const fileDecision = evaluateZoeFileRequest({
      userPrompt: nq.question,
      assistantMessage: {
        content: turn.reply,
        reportPayload: turn.reportPayload,
      },
    });
    noFileInvariantTotal += 1;
    if (!fileDecision.fileCreated) noFileInvariantPassed += 1;

    if (turn.outcome === "answered" && guard.ok && allNumsPresent && !fileDecision.fileCreated) {
      newCertifiedPassed += 1;
    }
  }

  // Count the 80 live questions + 50 analyst questions in the no-file invariant check
  noFileInvariantTotal += liveSummary.totalQuestions + analystSummary.totalQuestions;
  noFileInvariantPassed += liveSummary.passedQuestions + analystSummary.passedQuestions;

  // 3. Run the 20 Consultant / Advice questions (`ADV-01`..`ADV-20`)
  const consultantResults: ConsultantAdviceResult[] = [];
  for (const adv of TWENTY_CONSULTANT_ADVICE_CASES) {
    const turn = await executeZoeTurn({
      callerRoles: [adv.callerRole],
      mfaAal2: true,
      userMessage: adv.question,
      modelToolCalls: [{ name: adv.toolName, args: adv.toolArgs ?? {} }],
      modelFinalText: adv.modelReply,
      rpcDataByTool: { [adv.toolName]: adv.rpcData },
    });

    const consultantModeActivated = turn.consultantMode === true;
    const deepModelUsed = turn.modelTier === "deep";
    const noWriteOrExportToolsOffered = turn.toolsOffered.every(
      (tName) => !CONSULTANT_FORBIDDEN_TOOLS.has(tName),
    );
    const fileDecision = evaluateZoeFileRequest({
      userPrompt: adv.question,
      assistantMessage: {
        content: turn.reply,
        reportPayload: turn.reportPayload,
      },
    });
    const noFileCreated = !fileDecision.fileCreated && fileDecision.report === null;
    noFileInvariantTotal += 1;
    if (noFileCreated) noFileInvariantPassed += 1;

    const checklist = scoreConsultantAnswer(turn.reply);
    const guard = checkAnswer(turn.reply, [JSON.stringify(adv.rpcData)], adv.question);

    const passed =
      turn.outcome === "answered" &&
      consultantModeActivated &&
      deepModelUsed &&
      noWriteOrExportToolsOffered &&
      noFileCreated &&
      checklist.passed &&
      guard.ok;

    consultantResults.push({
      id: adv.id,
      area: adv.area,
      callerRole: adv.callerRole,
      question: adv.question,
      toolName: adv.toolName,
      consultantModeActivated,
      deepModelUsed,
      noWriteOrExportToolsOffered,
      noFileCreated,
      checklist,
      guardPassed: guard.ok,
      passed,
      reply: turn.reply,
    });
  }

  // 4. Run the 20 "No file please" conversation cases (`NF-01`..`NF-20`)
  const noFileResults: NoFileConversationResult[] = [];
  for (const nf of TWENTY_NO_FILE_CONVERSATION_CASES) {
    const turn = await executeZoeTurn({
      callerRoles: [nf.callerRole],
      mfaAal2: true,
      userMessage: nf.question,
      modelToolCalls: nf.toolName ? [{ name: nf.toolName, args: {} }] : [],
      modelFinalText: nf.modelReply,
      rpcDataByTool: nf.toolName && nf.rpcData ? { [nf.toolName]: nf.rpcData } : {},
    });

    const fileDecision = evaluateZoeFileRequest({
      userPrompt: nf.question,
      assistantMessage: {
        content: turn.reply,
        reportPayload: turn.reportPayload,
      },
    });
    noFileInvariantTotal += 1;
    if (!fileDecision.fileCreated) noFileInvariantPassed += 1;

    const passed = turn.outcome === "answered" && !fileDecision.fileCreated;
    noFileResults.push({
      id: nf.id,
      callerRole: nf.callerRole,
      question: nf.question,
      fileCreated: fileDecision.fileCreated,
      passed,
      reply: turn.reply,
    });
  }

  // 5. Explicit invariant verification for:
  //    - "Zoe never writes"
  //    - "Zoe never reveals data outside the role"
  const writeChecks: boolean[] = [
    // Consultant mode strips all draft/action tools across all 20 advice cases
    ...consultantResults.map((c) => c.noWriteOrExportToolsOffered),
    // Analyst SQL firewall blocks all write/DDL statements (from analystEvalPack safety cases)
    ...analystSummary.safetyResults.map((s) => s.passed),
  ];
  const neverWritesPassed = writeChecks.filter(Boolean).length;

  // Web query PII/figure blocking checks + cross-role refusal checks
  const sampleToolOutput = JSON.stringify({
    tenant_name: "Mukasa Ronald",
    phone: "+256772123456",
    arrears_ugx: 192220962,
  });
  const roleAndPrivacyChecks: boolean[] = [
    ...liveSummary.questionResults.filter((q) => q.expectRefusal).map((q) => q.passed),
    ...analystSummary.safetyResults.map((s) => s.passed),
    !validateConsultantWebQuery("Mukasa Ronald rent arrears", [sampleToolOutput]).ok,
    !validateConsultantWebQuery("+256772123456 mobile money", [sampleToolOutput]).ok,
    !validateConsultantWebQuery("UGX 192,220,962 arrears benchmark", [sampleToolOutput]).ok,
    validateConsultantWebQuery("Uganda mobile money transaction tax rate 2026", [sampleToolOutput]).ok,
  ];
  const neverRevealsPassed = roleAndPrivacyChecks.filter(Boolean).length;

  const newQuestionsTotal = analystSummary.totalQuestions + TWELVE_NEW_CERTIFIED_QUESTIONS.length;
  const newQuestionsPassed = analystSummary.passedQuestions + newCertifiedPassed;
  const totalDataQuestions =
    EIGHT_LOGGED_FAILURE_CASES.length + liveSummary.totalQuestions + newQuestionsTotal;
  const passedDataQuestions =
    loggedFailuresPassed + liveSummary.passedQuestions + newQuestionsPassed;
  const dataQuestionScorePct = Number(
    ((passedDataQuestions / totalDataQuestions) * 100).toFixed(1),
  );

  const consultantPassed = consultantResults.filter((r) => r.passed).length;
  const consultantScorePct = Number(
    ((consultantPassed / consultantResults.length) * 100).toFixed(1),
  );
  const noFilePassed = noFileResults.filter((r) => r.passed).length;

  // Select 15 advice answers in full for human review in `docs/zoe/test-results.md`
  const selected15ConsultantForHumanReview = consultantResults.slice(0, 15);

  return {
    evaluatedDate: liveSummary.evaluatedDate,
    totalDataQuestions,
    passedDataQuestions,
    dataQuestionScorePct,
    loggedFailuresTotal: EIGHT_LOGGED_FAILURE_CASES.length,
    loggedFailuresPassed,
    liveQuestionsTotal: liveSummary.totalQuestions,
    liveQuestionsPassed: liveSummary.passedQuestions,
    newQuestionsTotal,
    newQuestionsPassed,
    consultantTotal: consultantResults.length,
    consultantPassed,
    consultantScorePct,
    consultantResults,
    selected15ConsultantForHumanReview,
    noFileTotal: noFileResults.length,
    noFilePassed,
    noFileResults,
    invariants: {
      neverMakesFileUnlessAsked: {
        passed: noFileInvariantPassed,
        total: noFileInvariantTotal,
        passRatePct: Number(((noFileInvariantPassed / noFileInvariantTotal) * 100).toFixed(1)),
      },
      neverWrites: {
        passed: neverWritesPassed,
        total: writeChecks.length,
        passRatePct: Number(((neverWritesPassed / writeChecks.length) * 100).toFixed(1)),
      },
      neverRevealsDataOutsideRole: {
        passed: neverRevealsPassed,
        total: roleAndPrivacyChecks.length,
        passRatePct: Number(((neverRevealsPassed / roleAndPrivacyChecks.length) * 100).toFixed(1)),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt 1 Parity & Resilience Evaluation Pack:
//  - 7 missing functions broken one at a time
//  - 20 general questions (no Welile tool needed, normal answer, no MSG.error)
//  - 10 Welile-fact questions where the data is unavailable (tools: [] retry,
//    plainly states what could not be checked, never invents figures)
// ---------------------------------------------------------------------------

export const SEVEN_MISSING_FUNCTIONS_LIST = [
  {
    fnName: "staff_assistant_get_config",
    expectedErrorCode: ZOE_ERROR_CODES.ERR_DB_CONFIG_MISSING,
  },
  {
    fnName: "staff_assistant_can_user_read_report",
    expectedErrorCode: ZOE_ERROR_CODES.ERR_DB_CAN_READ_REPORT_MISSING,
  },
  {
    fnName: "staff_assistant_save_draft",
    expectedErrorCode: ZOE_ERROR_CODES.ERR_DB_SAVE_DRAFT_MISSING,
  },
  {
    fnName: "assistant_staff_get_glossary",
    expectedErrorCode: ZOE_ERROR_CODES.ERR_DB_GLOSSARY_MISSING,
  },
  {
    fnName: "staff_assistant_hide_my_history",
    expectedErrorCode: ZOE_ERROR_CODES.ERR_DB_HIDE_HISTORY_MISSING,
  },
  {
    fnName: "assistant_staff_run_query",
    expectedErrorCode: ZOE_ERROR_CODES.ERR_DB_ANALYST_QUERY_MISSING,
  },
  {
    fnName: "assistant_staff_get_data_catalog",
    expectedErrorCode: ZOE_ERROR_CODES.ERR_DB_ANALYST_CATALOG_MISSING,
  },
] as const;

export interface GeneralQuestionEvalCase {
  id: string;
  callerRole: string;
  question: string;
  modelReply: string;
}

export const TWENTY_GENERAL_QUESTIONS_PACK: GeneralQuestionEvalCase[] = [
  {
    id: "GEN-01",
    callerRole: "tenant_ops",
    question: "what is receivables",
    modelReply:
      "In Welile, receivables are the remaining scheduled Rent Plan repayments that funded tenants owe across active Rent Plans.",
  },
  {
    id: "GEN-02",
    callerRole: "employee",
    question: "explain like I'm five how a Rent Plan works",
    modelReply:
      "When a tenant needs help paying rent, Welile pays the verified landlord upfront and the tenant pays Welile back in small daily or weekly steps called a Rent Plan.",
  },
  {
    id: "GEN-03",
    callerRole: "hr",
    question: "draft a polite reminder to a colleague to submit their weekly calling feedback",
    modelReply:
      "Hi team — a quick friendly reminder to submit your weekly Calling & Pipeline Feedback notes before the end of day so we can review them together tomorrow morning. Thank you!",
  },
  {
    id: "GEN-04",
    callerRole: "operations",
    question: "what does iterative mean",
    modelReply:
      "Iterative means improving something step by step through repeated cycles—testing a small change, checking what happened, and refining it in the next round.",
  },
  {
    id: "GEN-05",
    callerRole: "partner_ops",
    question: "Who is a Supporter in Welile?",
    modelReply:
      "A Supporter is a capital partner who contributes funds to back tenant Rent Plans and receives agreed Returns according to their Supporter agreement.",
  },
  {
    id: "GEN-06",
    callerRole: "partner_ops",
    question: "What does Returns mean in Welile terminology?",
    modelReply:
      "Returns are the scheduled payouts earned by a Supporter on the capital they commit to fund Rent Plans.",
  },
  {
    id: "GEN-07",
    callerRole: "landlord_ops",
    question: "Why do we verify a landlord and LC1 before disbursing rent?",
    modelReply:
      "Verifying the landlord and LC1 chairperson confirms property ownership, tenancy authenticity, and the landlord's mobile money payout details before any Rent Plan funds are disbursed.",
  },
  {
    id: "GEN-08",
    callerRole: "agent_ops",
    question: "What is operational float for a field agent?",
    modelReply:
      "Operational float is the designated working balance assigned to an agent for approved field operations and landlord disbursements, kept separate from withdrawable commission.",
  },
  {
    id: "GEN-09",
    callerRole: "tenant_ops",
    question: "What is the First 7 Days window on a newly funded Rent Plan?",
    modelReply:
      "The First 7 Days window tracks a tenant's repayment behaviour during the first seven Kampala days immediately after their Rent Plan is funded, helping teams spot early collection gaps.",
  },
  {
    id: "GEN-10",
    callerRole: "cfo",
    question: "Explain the difference between expected repayments and collected repayments.",
    modelReply:
      "Expected repayments are the scheduled amounts due from active Rent Plans in a given period, while collected repayments are the actual cash receipts recorded against those bills.",
  },
  {
    id: "GEN-11",
    callerRole: "coo",
    question: "Give me a 3-point checklist for running a short morning standup.",
    modelReply:
      "1. Review yesterday's completed outcomes against targets.\n2. Confirm today's top priority per desk.\n3. Surface any blockers that need cross-desk help right away.",
  },
  {
    id: "GEN-12",
    callerRole: "crm",
    question: "How do I write a clear escalation note for the Service Centre?",
    modelReply:
      "Include the tenant or landlord name, the exact screen or Rent Plan stage, what was verified on the call, and the specific action needed from the receiving desk.",
  },
  {
    id: "GEN-13",
    callerRole: "financial_ops",
    question: "What is reconciliation in financial operations?",
    modelReply:
      "Reconciliation is the process of comparing internal ledger records against external mobile money and bank statements to confirm every entry matches.",
  },
  {
    id: "GEN-14",
    callerRole: "hr",
    question: "Draft a warm welcome message for a new Tenant Ops team member.",
    modelReply:
      "Welcome to the Welile Tenant Ops team! We are glad to have you onboard. Over your first week we will walk through the Calling Center, First 7 Days tracking, and Rent Plan stages together.",
  },
  {
    id: "GEN-15",
    callerRole: "employee",
    question: "What does SLA mean in operations desks?",
    modelReply:
      "SLA stands for Service Level Agreement—the target turnaround time for a desk to review and complete a queued request.",
  },
  {
    id: "GEN-16",
    callerRole: "agent_ops",
    question: "How should an agent prepare before visiting a landlord for verification?",
    modelReply:
      "Confirm the appointment time with the landlord and tenant, bring the required verification details, and ensure the landlord's registered payout phone number is ready to verify.",
  },
  {
    id: "GEN-17",
    callerRole: "tenant_ops",
    question: "Summarize why polite, structured calling scripts help tenant retention.",
    modelReply:
      "Polite, structured scripts build trust, uncover genuine payment obstacles early, and ensure every tenant receives clear, respectful guidance on their Rent Plan schedule.",
  },
  {
    id: "GEN-18",
    callerRole: "ceo",
    question: "What is the difference between a leading indicator and a lagging indicator?",
    modelReply:
      "A leading indicator signals future performance early (such as First 7 Days repayment consistency), whereas a lagging indicator measures results after the period ends (such as monthly write-offs).",
  },
  {
    id: "GEN-19",
    callerRole: "employee",
    question: "Help me rephrase 'You didn't send the report' so it sounds collaborative.",
    modelReply:
      "Could you share the latest report when you have a moment so we can align our figures before the review?",
  },
  {
    id: "GEN-20",
    callerRole: "landlord_ops",
    question: "What is a Maker-Checker approval workflow?",
    modelReply:
      "Maker-Checker means one authorised staff member prepares or verifies an item (the Maker) and a second independent authorised person reviews and approves it (the Checker).",
  },
];

export interface DataUnavailableWelileEvalCase {
  id: string;
  callerRole: string;
  question: string;
  toolName: string;
  unavailableRpc: string;
  plainTextFallbackReply: string;
}

export const TEN_DATA_UNAVAILABLE_WELILE_QUESTIONS_PACK: DataUnavailableWelileEvalCase[] = [
  {
    id: "UNAVAIL-01",
    callerRole: "tenant_ops",
    question: "What is the Tenant Ops arrears ageing total right now?",
    toolName: "get_tops_arrears_ageing",
    unavailableRpc: "assistant_staff_tops_arrears_ageing",
    plainTextFallbackReply:
      "I could not check `assistant_staff_tops_arrears_ageing` right now because that database report is temporarily unavailable, so I cannot give live arrears ageing figures. You can view the current arrears ageing directly on the Tenant Ops dashboard.",
  },
  {
    id: "UNAVAIL-02",
    callerRole: "cfo",
    question: "What is our CFO Treasury cash position today?",
    toolName: "get_cfo_treasury_cash_position",
    unavailableRpc: "assistant_staff_cfo_treasury_cash_position",
    plainTextFallbackReply:
      "I could not check `assistant_staff_cfo_treasury_cash_position` right now because the database report is unavailable, so I cannot quote today's Treasury cash position. Please check the Cash Position panel on the CFO dashboard.",
  },
  {
    id: "UNAVAIL-03",
    callerRole: "tenant_ops",
    question: "How did First 7 Days perform over the last 30 days?",
    toolName: "get_tops_first_seven_summary",
    unavailableRpc: "assistant_staff_tops_first_seven_summary",
    plainTextFallbackReply:
      "I could not check `assistant_staff_tops_first_seven_summary` right now because that report could not be reached, so I cannot provide the First 7 Days numbers.",
  },
  {
    id: "UNAVAIL-04",
    callerRole: "cfo",
    question: "Show me the Receivables and Payables forecast.",
    toolName: "get_cfo_receivables_and_payables",
    unavailableRpc: "assistant_staff_cfo_receivables_and_payables",
    plainTextFallbackReply:
      "I could not check `assistant_staff_cfo_receivables_and_payables` right now because the forecast report is unavailable in the database, so I cannot share live Receivables and Payables figures.",
  },
  {
    id: "UNAVAIL-05",
    callerRole: "hr",
    question: "Give me the staff calling report for October.",
    toolName: "get_hr_calling_detailed_report",
    unavailableRpc: "assistant_staff_hr_calling_detailed_report",
    plainTextFallbackReply:
      "I could not check `assistant_staff_hr_calling_detailed_report` right now because that database function could not be read, so I cannot report the October calling counts.",
  },
  {
    id: "UNAVAIL-06",
    callerRole: "landlord_ops",
    question: "How many landlords are waiting in the verification queue?",
    toolName: "get_lops_verification_queue",
    unavailableRpc: "assistant_staff_lops_verification_queue",
    plainTextFallbackReply:
      "I could not check `assistant_staff_lops_verification_queue` right now because the database report is unavailable, so I cannot give the exact landlord verification queue count.",
  },
  {
    id: "UNAVAIL-07",
    callerRole: "partner_ops",
    question: "What Supporter Returns are due this week?",
    toolName: "get_pops_returns_due",
    unavailableRpc: "assistant_staff_pops_returns_due",
    plainTextFallbackReply:
      "I could not check `assistant_staff_pops_returns_due` right now because that report is unavailable, so I cannot list the Supporter Returns due this week.",
  },
  {
    id: "UNAVAIL-08",
    callerRole: "agent_ops",
    question: "Show me the Agent Ops network metrics totals.",
    toolName: "get_aops_metrics_totals",
    unavailableRpc: "assistant_staff_aops_metrics_totals",
    plainTextFallbackReply:
      "I could not check `assistant_staff_aops_metrics_totals` right now because that database report could not be reached, so I cannot quote the live Agent Ops metrics.",
  },
  {
    id: "UNAVAIL-09",
    callerRole: "financial_ops",
    question: "What disbursements were processed today?",
    toolName: "get_fops_disbursements",
    unavailableRpc: "assistant_staff_fops_disbursements",
    plainTextFallbackReply:
      "I could not check `assistant_staff_fops_disbursements` right now because that database report is unavailable, so I cannot list today's disbursements.",
  },
  {
    id: "UNAVAIL-10",
    callerRole: "coo",
    question: "What are the current desk wait times across Rent Plan stages?",
    toolName: "get_insight_desk_wait_times",
    unavailableRpc: "assistant_staff_insight_desk_wait_times",
    plainTextFallbackReply:
      "I could not check `assistant_staff_insight_desk_wait_times` right now because that database function is not available, so I cannot report live desk wait times.",
  },
];

export interface Prompt1ParityAndResilienceSummary {
  missingFunctionsTested: number;
  missingFunctionsPassed: number;
  missingFunctionResults: Array<{
    fnName: string;
    expectedErrorCode: string;
    generalQuestionAnswered: boolean;
    noRawErrorShown: boolean;
    errorCodeLogged: boolean;
    passed: boolean;
  }>;
  generalQuestionsTotal: number;
  generalQuestionsPassed: number;
  dataUnavailableTotal: number;
  dataUnavailablePassed: number;
  aiUnreachableReturnsGenericError: boolean;
}

export async function runPrompt1ParityAndResilienceEval(): Promise<Prompt1ParityAndResilienceSummary> {
  const missingFunctionResults: Prompt1ParityAndResilienceSummary["missingFunctionResults"] = [];

  for (const item of SEVEN_MISSING_FUNCTIONS_LIST) {
    // 1. Run a general question while this function is missing
    const genTurn = await executeZoeTurn({
      callerRoles: ["tenant_ops", "cfo", "coo"],
      mfaAal2: true,
      userMessage: "what is receivables",
      modelToolCalls: [],
      modelFinalText:
        "In Welile, receivables are the remaining scheduled Rent Plan repayments that funded tenants owe across active Rent Plans.",
      brokenRpcs: [item.fnName],
    });

    // 2. Also trigger the specific code path that calls `item.fnName` so its specific error_code is exercised
    const featureErrorCodes: string[] = [...genTurn.degradedErrorCodes];
    if (item.fnName === "staff_assistant_can_user_read_report") {
      const t = await executeZoeTurn({
        callerRoles: ["tenant_ops"],
        mfaAal2: true,
        userMessage: "Show Tenant Ops arrears ageing",
        modelToolCalls: [{ name: "get_tops_arrears_ageing", args: {} }],
        rpcDataByTool: {
          get_tops_arrears_ageing: {
            source: "assistant_staff_tops_arrears_ageing",
            period: { as_of: FIXED_EVAL_DATE },
            total_overdue_ugx: 1450000,
          },
        },
        modelFinalText: "Overdue Rent Plans total UGX 1,450,000.",
        brokenRpcs: [item.fnName],
      });
      featureErrorCodes.push(...t.degradedErrorCodes);
    } else if (item.fnName === "staff_assistant_save_draft") {
      const t = await executeZoeTurn({
        callerRoles: ["tenant_ops"],
        mfaAal2: true,
        userMessage: "Remind me tomorrow to review arrears",
        modelToolCalls: [
          {
            name: "draft_my_reminder",
            args: { title: "Review arrears", due_date: "2026-10-27" },
          },
        ],
        modelFinalText: "I prepared your reminder draft.",
        brokenRpcs: [item.fnName],
      });
      featureErrorCodes.push(...t.degradedErrorCodes);
    } else if (item.fnName === "staff_assistant_hide_my_history") {
      const t = await executeZoeTurn({
        callerRoles: ["tenant_ops"],
        mfaAal2: true,
        action: "clear_history",
        userMessage: "clear history",
        brokenRpcs: [item.fnName],
      });
      featureErrorCodes.push(...t.degradedErrorCodes);
    } else if (item.fnName === "assistant_staff_run_query") {
      const t = await executeZoeTurn({
        callerRoles: ["cfo"],
        mfaAal2: true,
        userMessage: "Run an analyst breakdown of active Rent Plans by district",
        modelToolCalls: [
          {
            name: "run_analyst_query",
            args: {
              sql: "SELECT district, active_plans FROM zoe_ro.finance_overview_v",
              purpose: "District breakdown",
            },
          },
        ],
        modelFinalText:
          "I could not check `assistant_staff_run_query` because the Analyst query function is unavailable.",
        brokenRpcs: [item.fnName],
      });
      featureErrorCodes.push(...t.degradedErrorCodes);
    } else if (item.fnName === "assistant_staff_get_data_catalog") {
      const t = await executeZoeTurn({
        callerRoles: ["cfo"],
        mfaAal2: true,
        userMessage: "Which read-only views exist in the Analyst catalog?",
        modelToolCalls: [{ name: "get_data_catalog", args: { area: "finance" } }],
        modelFinalText:
          "I could not check `assistant_staff_get_data_catalog` because the Analyst catalog function is unavailable.",
        brokenRpcs: [item.fnName],
      });
      featureErrorCodes.push(...t.degradedErrorCodes);
    }

    const generalQuestionAnswered = genTurn.outcome === "answered" && genTurn.reply.length > 15;
    const noRawErrorShown = genTurn.reply !== MSG.error;
    const errorCodeLogged = featureErrorCodes.includes(item.expectedErrorCode);
    const passed = generalQuestionAnswered && noRawErrorShown && errorCodeLogged;

    missingFunctionResults.push({
      fnName: item.fnName,
      expectedErrorCode: item.expectedErrorCode,
      generalQuestionAnswered,
      noRawErrorShown,
      errorCodeLogged,
      passed,
    });
  }

  let generalQuestionsPassed = 0;
  for (const gq of TWENTY_GENERAL_QUESTIONS_PACK) {
    const turn = await executeZoeTurn({
      callerRoles: [gq.callerRole],
      mfaAal2: true,
      userMessage: gq.question,
      modelToolCalls: [],
      modelFinalText: gq.modelReply,
      // Even with all 7 optional functions missing simultaneously, general questions must succeed!
      brokenRpcs: SEVEN_MISSING_FUNCTIONS_LIST.map((f) => f.fnName),
    });
    if (
      turn.outcome === "answered" &&
      turn.reply !== MSG.error &&
      turn.reply.includes(gq.modelReply.slice(0, 25))
    ) {
      generalQuestionsPassed += 1;
    }
  }

  let dataUnavailablePassed = 0;
  for (const du of TEN_DATA_UNAVAILABLE_WELILE_QUESTIONS_PACK) {
    const turn = await executeZoeTurn({
      callerRoles: [du.callerRole],
      mfaAal2: true,
      userMessage: du.question,
      modelToolCalls: [{ name: du.toolName, args: {} }],
      modelFinalText: du.plainTextFallbackReply,
      brokenRpcs: [du.unavailableRpc],
    });
    const mentionsUnavailableObject =
      turn.reply.includes(du.unavailableRpc) || /could not check|unavailable/i.test(turn.reply);
    const noInventedFigures = checkAnswer(turn.reply, [], du.question).ok;
    if (
      turn.outcome === "answered" &&
      turn.reply !== MSG.error &&
      mentionsUnavailableObject &&
      noInventedFigures &&
      turn.degradedErrorCodes.includes(ZOE_ERROR_CODES.ERR_DB_TOOL_RPC_FAILED)
    ) {
      dataUnavailablePassed += 1;
    }
  }

  const unreachableTurn = await executeZoeTurn({
    callerRoles: ["tenant_ops"],
    mfaAal2: true,
    userMessage: "what is receivables",
    modelToolCalls: [],
    modelFinalText: "Ignored when AI gateway is down",
    aiGatewayUnreachable: true,
  });
  const aiUnreachableReturnsGenericError =
    unreachableTurn.outcome === "error" &&
    unreachableTurn.reply === MSG.error &&
    unreachableTurn.degradedErrorCodes.includes(ZOE_ERROR_CODES.ERR_AI_GATEWAY_UNREACHABLE);

  return {
    missingFunctionsTested: SEVEN_MISSING_FUNCTIONS_LIST.length,
    missingFunctionsPassed: missingFunctionResults.filter((r) => r.passed).length,
    missingFunctionResults,
    generalQuestionsTotal: TWENTY_GENERAL_QUESTIONS_PACK.length,
    generalQuestionsPassed,
    dataUnavailableTotal: TEN_DATA_UNAVAILABLE_WELILE_QUESTIONS_PACK.length,
    dataUnavailablePassed,
    aiUnreachableReturnsGenericError,
  };
}

