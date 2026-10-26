import {
  checkAnswer,
  executeZoeTurn,
  findTool,
  FIXED_EVAL_DATE,
  withFixedEvalDateSync,
} from "./runtime.ts";

export interface AccuracyQuestionCase {
  id: string;
  group: string;
  callerRole: string;
  question: string;
  toolName: string;
  expectedRpc: string;
  toolArgs: Record<string, unknown>;
  expectedRpcArgs: Record<string, unknown>;
  expectedSource: string;
  expectedPeriod: string;
  expectedNumbers: number[];
  officialReportOutput: Record<string, unknown>;
  expectedAnswerText: string;
}

export interface AccuracyQuestionScore {
  id: string;
  group: string;
  callerRole: string;
  question: string;
  toolName: string;
  expectedRpc: string;
  expectedSource: string;
  expectedPeriod: string;
  expectedNumbers: number[];
  rpcArgsMatched: boolean;
  exactNumbersMatched: boolean;
  correctDatesMatched: boolean;
  sourceNamedMatched: boolean;
  guardPassed: boolean;
  passed: boolean;
  reply: string;
}

export interface AccuracyPackSummary {
  fixedDate: string;
  total: number;
  passed: number;
  failed: number;
  scorePct: number;
  exactNumbersPassCount: number;
  correctDatesPassCount: number;
  sourceNamedPassCount: number;
  guardPassCount: number;
  byGroup: Record<string, { total: number; passed: number }>;
  results: AccuracyQuestionScore[];
}

function extractNumbersFromText(text: string): Set<number> {
  const isoDateRe = /\b\d{4}-\d{2}-\d{2}\b/g;
  const phoneRe = /(?:\+?256|0)\s*7\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g;
  const numberRe = /\b\d{1,3}(?:,\d{3})+|\b\d+\b/g;
  const scrubbed = text.replace(isoDateRe, " ").replace(phoneRe, " ");
  const out = new Set<number>();
  for (const m of scrubbed.matchAll(numberRe)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.add(Math.round(n));
  }
  return out;
}

/**
 * 60 real staff questions across all 8 role groups and all 42 `assistant_staff_*` tools,
 * anchored on the fixed evaluation date `2026-10-26` (Africa/Kampala).
 */
export const ACCURACY_QUESTIONS_60: AccuracyQuestionCase[] = [
  // ===========================================================================
  // GROUP A — EVERY STAFF MEMBER (MY SPACE PERSONAL ITEMS, Q01–Q12)
  // ===========================================================================
  {
    id: "Q01",
    group: "Group A — My Space Personal",
    callerRole: "employee",
    question: "Who am I in My Space, what is my staff reference, department, position, and how many dashboards do I have?",
    toolName: "get_my_profile",
    expectedRpc: "assistant_staff_my_profile",
    toolArgs: {},
    expectedRpcArgs: {},
    expectedSource: "hr_my_staff_id + profiles + hr_staff + hr_assignments + user_roles + staff_permissions",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [1, 3],
    officialReportOutput: {
      source: "hr_my_staff_id + profiles + hr_staff + hr_assignments + user_roles + staff_permissions",
      period: { as_of: "2026-10-26" },
      row_count: 1,
      data: {
        full_name: "Watsala Enock",
        employee_code: "WEL-STF-019",
        department: "Operations",
        position: "Operations Officer",
        active_assignments_count: 1,
        permitted_dashboards_count: 3,
      },
    },
    expectedAnswerText:
      "You are signed in as Watsala Enock (staff reference WEL-STF-019) in the Operations department as Operations Officer:\n- Active HR assignments: 1\n- Permitted staff dashboards: 3",
  },
  {
    id: "Q02",
    group: "Group A — My Space Personal",
    callerRole: "employee",
    question: "Show my October 2026 payslip and tell me my gross pay, PAYE, NSSF deduction, and net pay.",
    toolName: "get_my_payslips",
    expectedRpc: "assistant_staff_my_payslips",
    toolArgs: {},
    expectedRpcArgs: {},
    expectedSource: "hr_pay_my_payslips",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [1850000, 302000, 92500, 1455500],
    officialReportOutput: {
      source: "hr_pay_my_payslips",
      period: { as_of: "2026-10-26" },
      row_count: 2,
      payslips: [
        {
          period_code: "2026-10",
          pay_date: "2026-10-25",
          gross: 1850000,
          paye: 302000,
          nssf_employee: 92500,
          other_deductions: 0,
          net: 1455500,
          run_status: "paid",
        },
        {
          period_code: "2026-09",
          pay_date: "2026-09-25",
          gross: 1850000,
          paye: 302000,
          nssf_employee: 92500,
          other_deductions: 50000,
          net: 1405500,
          run_status: "paid",
        },
      ],
    },
    expectedAnswerText:
      "Your October 2026 payslip (paid on 2026-10-25) shows:\n- Gross pay: UGX 1,850,000\n- PAYE tax: UGX 302,000\n- Employee NSSF contribution: UGX 92,500\n- Net pay: UGX 1,455,500 (status: paid)",
  },
  {
    id: "Q03",
    group: "Group A — My Space Personal",
    callerRole: "employee",
    question: "What was my net pay and other deductions on my September 2026 payslip?",
    toolName: "get_my_payslips",
    expectedRpc: "assistant_staff_my_payslips",
    toolArgs: {},
    expectedRpcArgs: {},
    expectedSource: "hr_pay_my_payslips",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [1850000, 50000, 1405500],
    officialReportOutput: {
      source: "hr_pay_my_payslips",
      period: { as_of: "2026-10-26" },
      row_count: 2,
      payslips: [
        {
          period_code: "2026-09",
          pay_date: "2026-09-25",
          gross: 1850000,
          paye: 302000,
          nssf_employee: 92500,
          other_deductions: 50000,
          net: 1405500,
          run_status: "paid",
        },
      ],
    },
    expectedAnswerText:
      "On your September 2026 payslip (pay date 2026-09-25):\n- Gross pay: UGX 1,850,000\n- Other deductions: UGX 50,000\n- Net pay: UGX 1,405,500",
  },
  {
    id: "Q04",
    group: "Group A — My Space Personal",
    callerRole: "employee",
    question: "What pending tasks are assigned to me in My Work right now, and how many are overdue?",
    toolName: "get_my_tasks",
    expectedRpc: "assistant_staff_my_tasks",
    toolArgs: { status: "pending" },
    expectedRpcArgs: { p_status: "pending" },
    expectedSource: "hr_my_staff_id + hr_tasks",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [4, 1],
    officialReportOutput: {
      source: "hr_my_staff_id + hr_tasks",
      period: { as_of: "2026-10-26" },
      row_count: 4,
      overdue_count: 1,
      tasks: [
        { ref: "TSK-401", title: "Verify Kireka landlord documents", status: "pending", is_overdue: true },
        { ref: "TSK-402", title: "Call week-1 daily tenants", status: "pending", is_overdue: false },
      ],
    },
    expectedAnswerText:
      "You have 4 pending tasks assigned to you in My Work, of which 1 task is overdue:\n- TSK-401: Verify Kireka landlord documents (overdue)\n- TSK-402: Call week-1 daily tenants",
  },
  {
    id: "Q05",
    group: "Group A — My Space Personal",
    callerRole: "employee",
    question: "How many completed HR tasks do I have in My Work?",
    toolName: "get_my_tasks",
    expectedRpc: "assistant_staff_my_tasks",
    toolArgs: { status: "completed" },
    expectedRpcArgs: { p_status: "completed" },
    expectedSource: "hr_my_staff_id + hr_tasks",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [14],
    officialReportOutput: {
      source: "hr_my_staff_id + hr_tasks",
      period: { as_of: "2026-10-26" },
      row_count: 14,
      tasks: [{ ref: "TSK-388", title: "Weekly reconciliation check", status: "completed" }],
    },
    expectedAnswerText:
      "You have 14 completed HR tasks in My Work, including TSK-388 (Weekly reconciliation check).",
  },
  {
    id: "Q06",
    group: "Group A — My Space Personal",
    callerRole: "employee",
    question: "What HR tickets have I raised or am I assigned to, and what is their status?",
    toolName: "get_my_tickets",
    expectedRpc: "assistant_staff_my_tickets",
    toolArgs: {},
    expectedRpcArgs: {},
    expectedSource: "hr_tickets + hr_ticket_people",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [3, 2, 1],
    officialReportOutput: {
      source: "hr_tickets + hr_ticket_people",
      period: { as_of: "2026-10-26" },
      row_count: 3,
      open_count: 2,
      closed_count: 1,
      tickets: [
        { ref: "TCK-112", subject: "Field tablet SIM replacement", status: "open", severity: "medium" },
      ],
    },
    expectedAnswerText:
      "You have 3 HR tickets in My Space (2 open and 1 closed), including TCK-112 (Field tablet SIM replacement, medium severity).",
  },
  {
    id: "Q07",
    group: "Group A — My Space Personal",
    callerRole: "employee",
    question: "What is the status of the staff requisitions I have submitted and their amounts?",
    toolName: "get_my_requisitions",
    expectedRpc: "assistant_staff_my_requisitions",
    toolArgs: {},
    expectedRpcArgs: {},
    expectedSource: "staff_requisitions + staff_requisition_my_notices + get_my_usage_report_notices",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [2, 350000, 620000],
    officialReportOutput: {
      source: "staff_requisitions + staff_requisition_my_notices + get_my_usage_report_notices",
      period: { as_of: "2026-10-26" },
      row_count: 2,
      requisitions: [
        {
          requisition_code: "REQ-2026-214",
          title: "Wakiso field transport",
          amount: 350000,
          approved_amount: 350000,
          stage: "cfo_approved",
          current_approver_role: "cfo",
        },
        {
          requisition_code: "REQ-2026-249",
          title: "Landlord verification airtime bundle",
          amount: 620000,
          approved_amount: null,
          stage: "pending_ceo",
          current_approver_role: "ceo",
        },
      ],
    },
    expectedAnswerText:
      "You have submitted 2 staff requisitions:\n- REQ-2026-214 (Wakiso field transport): UGX 350,000 approved at cfo_approved stage\n- REQ-2026-249 (Landlord verification airtime bundle): UGX 620,000 awaiting ceo approval",
  },
  {
    id: "Q08",
    group: "Group A — My Space Personal",
    callerRole: "employee",
    question: "Do I have any salary advances, how much was disbursed, and how much is still outstanding?",
    toolName: "get_my_advances",
    expectedRpc: "assistant_staff_my_advances",
    toolArgs: {},
    expectedRpcArgs: {},
    expectedSource: "hr_pay_advances + hr_pay_advance_recovered_totals",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [1, 600000, 200000, 400000],
    officialReportOutput: {
      source: "hr_pay_advances + hr_pay_advance_recovered_totals",
      period: { as_of: "2026-10-26" },
      row_count: 1,
      advances: [
        {
          principal: 600000,
          recovered: 200000,
          outstanding: 400000,
          recovery_months: 3,
          status: "active",
        },
      ],
    },
    expectedAnswerText:
      "You have 1 active salary advance:\n- Principal disbursed: UGX 600,000\n- Recovered so far: UGX 200,000\n- Outstanding balance: UGX 400,000 over 3 recovery months",
  },
  {
    id: "Q09",
    group: "Group A — My Space Personal",
    callerRole: "employee",
    question: "What Calling Center concerns have been forwarded to me for review right now?",
    toolName: "get_my_pending_concerns",
    expectedRpc: "assistant_staff_my_pending_concerns",
    toolArgs: {},
    expectedRpcArgs: {},
    expectedSource: "cc_my_pending_concerns",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [2],
    officialReportOutput: {
      source: "cc_my_pending_concerns",
      period: { as_of: "2026-10-26" },
      row_count: 2,
      concerns: [
        { title: "Receipt mismatch on Nansana Rent Plan", priority: "high", status: "pending" },
        { title: "Landlord phone change verification", priority: "medium", status: "pending" },
      ],
    },
    expectedAnswerText:
      "You have 2 pending Calling Center concerns awaiting your review:\n- Receipt mismatch on Nansana Rent Plan (high priority)\n- Landlord phone change verification (medium priority)",
  },
  {
    id: "Q10",
    group: "Group A — My Space Personal",
    callerRole: "employee",
    question: "What is on the canteen menu today, and how many canteen food orders have I placed recently?",
    toolName: "get_my_canteen",
    expectedRpc: "assistant_staff_my_canteen",
    toolArgs: {},
    expectedRpcArgs: { p_service_date: null },
    expectedSource: "food_menu_for_day + food_orders",
    expectedPeriod: "2026-10-26",
    expectedNumbers: [5],
    officialReportOutput: {
      source: "food_menu_for_day + food_orders",
      period: { service_date: "2026-10-26" },
      row_count: 5,
      menu: { main_dishes: ["Matooke & Beef", "Posho & Beans"], greens: "Nakati" },
      orders: [{ service_date: "2026-10-26", meal: "Matooke & Beef", status: "confirmed" }],
    },
    expectedAnswerText:
      "Today's canteen menu for 2026-10-26 features Matooke & Beef and Posho & Beans with Nakati, and you have 5 recent canteen food orders on record.",
  },
  {
    id: "Q11",
    group: "Group A — My Space Personal",
    callerRole: "employee",
    question: "What was on the canteen menu on 2026-10-24?",
    toolName: "get_my_canteen",
    expectedRpc: "assistant_staff_my_canteen",
    toolArgs: { service_date: "2026-10-24" },
    expectedRpcArgs: { p_service_date: "2026-10-24" },
    expectedSource: "food_menu_for_day + food_orders",
    expectedPeriod: "2026-10-24",
    expectedNumbers: [1],
    officialReportOutput: {
      source: "food_menu_for_day + food_orders",
      period: { service_date: "2026-10-24" },
      row_count: 1,
      menu: { main_dishes: ["Pilao & Chicken"] },
      orders: [{ service_date: "2026-10-24", meal: "Pilao & Chicken", status: "served" }],
    },
    expectedAnswerText:
      "On 2026-10-24 the canteen menu was Pilao & Chicken, and you had 1 served order for that date.",
  },
  {
    id: "Q12",
    group: "Group A — My Space Personal",
    callerRole: "employee",
    question: "What is my personal wallet balance, separating withdrawable Returns from operational float?",
    toolName: "get_my_wallet",
    expectedRpc: "assistant_staff_my_wallet",
    toolArgs: {},
    expectedRpcArgs: {},
    expectedSource: "wallets",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [485000, 310000, 175000],
    officialReportOutput: {
      source: "wallets",
      period: { as_of: "2026-10-26" },
      row_count: 1,
      data: {
        balance: 485000,
        withdrawable_balance: 310000,
        float_balance: 175000,
        locked_balance: 0,
        currency: "UGX",
      },
    },
    expectedAnswerText:
      "Your personal wallet balances as of 2026-10-26 are:\n- Total wallet balance: UGX 485,000\n- Withdrawable balance: UGX 310,000\n- Operational float balance: UGX 175,000",
  },

  // ===========================================================================
  // GROUP B — TENANT OPS (Q13–Q24)
  // ===========================================================================
  {
    id: "Q13",
    group: "Group B — Tenant Ops",
    callerRole: "tenant_ops",
    question: "How are new tenants performing in their first 7 repayment days over the last 30 days?",
    toolName: "get_tops_first_seven_summary",
    expectedRpc: "assistant_staff_tops_first_seven_summary",
    toolArgs: { period: "last_30_days" },
    expectedRpcArgs: { p_from: "2026-09-27", p_to: "2026-10-26", p_frequency: null },
    expectedSource: "am_new_tenant_first7_summary_v2",
    expectedPeriod: "2026-09-27 to 2026-10-26",
    expectedNumbers: [142, 118, 28400000, 24150000],
    officialReportOutput: {
      source: "am_new_tenant_first7_summary_v2",
      period: { from: "2026-09-27", to: "2026-10-26" },
      row_count: 1,
      data: {
        funded_plans: 142,
        paying_on_track: 118,
        expected_first7_ugx: 28400000,
        collected_first7_ugx: 24150000,
      },
    },
    expectedAnswerText:
      "Over 2026-09-27 to 2026-10-26, First 7 Days onboarding recorded 142 newly funded Rent Plans with 118 paying on track:\n- Expected in first 7 days: UGX 28,400,000\n- Collected in first 7 days: UGX 24,150,000",
  },
  {
    id: "Q14",
    group: "Group B — Tenant Ops",
    callerRole: "tenant_ops",
    question: "What is the First 7 Days summary for daily frequency Rent Plans this month?",
    toolName: "get_tops_first_seven_summary",
    expectedRpc: "assistant_staff_tops_first_seven_summary",
    toolArgs: { period: "this_month", frequency: "daily" },
    expectedRpcArgs: { p_from: "2026-10-01", p_to: "2026-10-26", p_frequency: "daily" },
    expectedSource: "am_new_tenant_first7_summary_v2",
    expectedPeriod: "2026-10-01 to 2026-10-26",
    expectedNumbers: [96, 84, 19200000, 16800000],
    officialReportOutput: {
      source: "am_new_tenant_first7_summary_v2",
      period: { from: "2026-10-01", to: "2026-10-26" },
      row_count: 1,
      data: {
        funded_plans: 96,
        paying_on_track: 84,
        expected_first7_ugx: 19200000,
        collected_first7_ugx: 16800000,
      },
    },
    expectedAnswerText:
      "For daily Rent Plans from 2026-10-01 to 2026-10-26, 96 plans were funded and 84 are paying on track, with UGX 16,800,000 collected out of UGX 19,200,000 expected.",
  },
  {
    id: "Q15",
    group: "Group B — Tenant Ops",
    callerRole: "tenant_ops",
    question: "What is our Tenant Ops arrears ageing breakdown across active Rent Plans as of today?",
    toolName: "get_tops_arrears_ageing",
    expectedRpc: "assistant_staff_tops_arrears_ageing",
    toolArgs: {},
    expectedRpcArgs: { p_as_at: null, p_bucket: null, p_limit: 50, p_offset: 0, p_dir: "desc" },
    expectedSource: "tops_arrears_ageing_amclock",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [64, 48750000, 14500000],
    officialReportOutput: {
      source: "tops_arrears_ageing_amclock",
      period: { as_of: "2026-10-26" },
      row_count: 64,
      data: {
        total_overdue_plans: 64,
        total_overdue_ugx: 48750000,
        bucket_1_7_ugx: 14500000,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, Tenant Ops arrears ageing shows 64 overdue Rent Plans totaling UGX 48,750,000, including UGX 14,500,000 in the 1-7 days bucket.",
  },
  {
    id: "Q16",
    group: "Group B — Tenant Ops",
    callerRole: "tenant_ops",
    question: "How much is in the 31_60 days arrears ageing bucket as of 2026-10-26?",
    toolName: "get_tops_arrears_ageing",
    expectedRpc: "assistant_staff_tops_arrears_ageing",
    toolArgs: { as_at: "2026-10-26", bucket: "31_60", limit: 25 },
    expectedRpcArgs: { p_as_at: "2026-10-26", p_bucket: "31_60", p_limit: 25, p_offset: 0, p_dir: "desc" },
    expectedSource: "tops_arrears_ageing_amclock",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [12, 11250000],
    officialReportOutput: {
      source: "tops_arrears_ageing_amclock",
      period: { as_of: "2026-10-26" },
      row_count: 12,
      data: {
        bucket: "31_60",
        plans_count: 12,
        bucket_overdue_ugx: 11250000,
      },
    },
    expectedAnswerText:
      "In the 31_60 days arrears bucket as of 2026-10-26, there are 12 overdue Rent Plans totaling UGX 11,250,000.",
  },
  {
    id: "Q17",
    group: "Group B — Tenant Ops",
    callerRole: "tenant_ops",
    question: "How many funded Rent Plans are still waiting for landlord payout or have tenants paying before landlord payout?",
    toolName: "get_tops_landlord_not_paid",
    expectedRpc: "assistant_staff_tops_landlord_not_paid",
    toolArgs: {},
    expectedRpcArgs: { p_as_at: null, p_limit: 50, p_offset: 0 },
    expectedSource: "tops_landlord_not_paid_summary_amclock + am_uncovered_plans",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [19, 11, 8, 15400000],
    officialReportOutput: {
      source: "tops_landlord_not_paid_summary_amclock + am_uncovered_plans",
      period: { as_of: "2026-10-26" },
      row_count: 19,
      data: {
        total_plans: 19,
        tenant_paying_no_landlord: 11,
        awaiting_landlord: 8,
        uncovered_principal_ugx: 15400000,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, there are 19 uncovered Rent Plans (UGX 15,400,000 principal): 11 where the tenant is already paying before landlord payout and 8 awaiting landlord payout.",
  },
  {
    id: "Q18",
    group: "Group B — Tenant Ops",
    callerRole: "tenant_ops",
    question: "How are tenants classified across behavioral categories right now?",
    toolName: "get_tops_tenant_classification",
    expectedRpc: "assistant_staff_tops_tenant_classification",
    toolArgs: {},
    expectedRpcArgs: {},
    expectedSource: "tops_tenant_classification_summary",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [412, 285, 79, 48],
    officialReportOutput: {
      source: "tops_tenant_classification_summary",
      period: { as_of: "2026-10-26" },
      row_count: 3,
      data: {
        total_active_tenants: 412,
        consistent_payers: 285,
        irregular_payers: 79,
        critical_arrears: 48,
      },
    },
    expectedAnswerText:
      "Across 412 active tenants as of 2026-10-26:\n- Consistent payers: 285\n- Irregular payers: 79\n- Critical arrears: 48",
  },
  {
    id: "Q19",
    group: "Group B — Tenant Ops",
    callerRole: "tenant_ops",
    question: "How many tenants used smartphone app payments versus non-smartphone collection over the last 30 days?",
    toolName: "get_tops_smartphone_usage",
    expectedRpc: "assistant_staff_tops_smartphone_usage",
    toolArgs: { period: "last_30_days" },
    expectedRpcArgs: { p_from: "2026-09-27", p_to: "2026-10-26" },
    expectedSource: "tops_smartphone_usage",
    expectedPeriod: "2026-09-27 to 2026-10-26",
    expectedNumbers: [238, 174, 62400000, 41800000],
    officialReportOutput: {
      source: "tops_smartphone_usage",
      period: { from: "2026-09-27", to: "2026-10-26" },
      row_count: 2,
      data: {
        smartphone_tenants: 238,
        non_smartphone_tenants: 174,
        smartphone_collected_ugx: 62400000,
        non_smartphone_collected_ugx: 41800000,
      },
    },
    expectedAnswerText:
      "From 2026-09-27 to 2026-10-26, 238 smartphone tenants paid UGX 62,400,000 while 174 non-smartphone tenants paid UGX 41,800,000.",
  },
  {
    id: "Q20",
    group: "Group B — Tenant Ops",
    callerRole: "tenant_ops",
    question: "What was the smartphone vs non-smartphone tenant collection breakdown this month?",
    toolName: "get_tops_smartphone_usage",
    expectedRpc: "assistant_staff_tops_smartphone_usage",
    toolArgs: { period: "this_month" },
    expectedRpcArgs: { p_from: "2026-10-01", p_to: "2026-10-26" },
    expectedSource: "tops_smartphone_usage",
    expectedPeriod: "2026-10-01 to 2026-10-26",
    expectedNumbers: [210, 152, 54100000, 35900000],
    officialReportOutput: {
      source: "tops_smartphone_usage",
      period: { from: "2026-10-01", to: "2026-10-26" },
      row_count: 2,
      data: {
        smartphone_tenants: 210,
        non_smartphone_tenants: 152,
        smartphone_collected_ugx: 54100000,
        non_smartphone_collected_ugx: 35900000,
      },
    },
    expectedAnswerText:
      "From 2026-10-01 to 2026-10-26, 210 smartphone tenants collected UGX 54,100,000 and 152 non-smartphone tenants collected UGX 35,900,000.",
  },
  {
    id: "Q21",
    group: "Group B — Tenant Ops",
    callerRole: "tenant_ops",
    question: "What is the Tenant Ops weekly collection performance anchored on today?",
    toolName: "get_tops_weekly_performance",
    expectedRpc: "assistant_staff_tops_weekly_performance",
    toolArgs: {},
    expectedRpcArgs: { p_anchor: null },
    expectedSource: "get_tenant_ops_weekly_performance_amclock",
    expectedPeriod: "week of 2026-10-26",
    expectedNumbers: [389, 31200000, 26520000],
    officialReportOutput: {
      source: "get_tenant_ops_weekly_performance_amclock",
      period: { anchor: "2026-10-26" },
      row_count: 1,
      data: {
        active_plans: 389,
        weekly_due_ugx: 31200000,
        weekly_collected_ugx: 26520000,
      },
    },
    expectedAnswerText:
      "For the week of 2026-10-26 across 389 active Rent Plans, weekly expected repayments were UGX 31,200,000 and collections reached UGX 26,520,000.",
  },
  {
    id: "Q22",
    group: "Group B — Tenant Ops",
    callerRole: "tenant_ops",
    question: "Which funded Rent Plans have had zero tenant payments after at least 20 days?",
    toolName: "get_tops_no_payment_report",
    expectedRpc: "assistant_staff_tops_no_payment_report",
    toolArgs: { min_days: 20 },
    expectedRpcArgs: { p_min_days: 20 },
    expectedSource: "get_tenant_ops_no_payment_report_v2",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [9, 7650000],
    officialReportOutput: {
      source: "get_tenant_ops_no_payment_report_v2",
      period: { as_of: "2026-10-26" },
      row_count: 9,
      data: {
        min_days: 20,
        plans_count: 9,
        total_unpaid_principal_ugx: 7650000,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, there are 9 funded Rent Plans with zero tenant payments after 20+ days, representing UGX 7,650,000 in principal.",
  },
  {
    id: "Q23",
    group: "Group B — Tenant Ops",
    callerRole: "tenant_ops",
    question: "How many funded Rent Plans have had zero payments for at least 30 days?",
    toolName: "get_tops_no_payment_report",
    expectedRpc: "assistant_staff_tops_no_payment_report",
    toolArgs: { min_days: 30 },
    expectedRpcArgs: { p_min_days: 30 },
    expectedSource: "get_tenant_ops_no_payment_report_v2",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [5, 4200000],
    officialReportOutput: {
      source: "get_tenant_ops_no_payment_report_v2",
      period: { as_of: "2026-10-26" },
      row_count: 5,
      data: {
        min_days: 30,
        plans_count: 5,
        total_unpaid_principal_ugx: 4200000,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, 5 funded Rent Plans have had zero tenant payments for 30+ days, totaling UGX 4,200,000.",
  },
  {
    id: "Q24",
    group: "Group B — Tenant Ops",
    callerRole: "tenant_ops",
    question: "What is the Rent Plan request pipeline lifetime and stage conversion summary?",
    toolName: "get_tops_rent_request_lifetime",
    expectedRpc: "assistant_staff_tops_rent_request_lifetime",
    toolArgs: {},
    expectedRpcArgs: {},
    expectedSource: "tenant_ops_rent_request_lifetime",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [1240, 815, 34, 18],
    officialReportOutput: {
      source: "tenant_ops_rent_request_lifetime",
      period: { as_of: "2026-10-26" },
      row_count: 1,
      data: {
        total_requests: 1240,
        funded_requests: 815,
        in_verification_queue: 34,
        median_hours_to_fund: 18,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, out of 1,240 lifetime Rent Plan requests, 815 have been funded, 34 are currently in the verification queue, and median turnaround to funding is 18 hours.",
  },

  // ===========================================================================
  // GROUP C — LANDLORD OPS (Q25–Q32)
  // ===========================================================================
  {
    id: "Q25",
    group: "Group C — Landlord Ops",
    callerRole: "landlord_ops",
    question: "What is the Landlord Ops home summary over the last 30 days?",
    toolName: "get_lops_home_range",
    expectedRpc: "assistant_staff_lops_home_range",
    toolArgs: { period: "last_30_days" },
    expectedRpcArgs: { p_from: "2026-09-27", p_to: "2026-10-26" },
    expectedSource: "ops_landlord_ops_home_range",
    expectedPeriod: "2026-09-27 to 2026-10-26",
    expectedNumbers: [134, 119, 98500000],
    officialReportOutput: {
      source: "ops_landlord_ops_home_range",
      period: { from: "2026-09-27", to: "2026-10-26" },
      row_count: 1,
      data: {
        landlords_verified: 134,
        payouts_completed: 119,
        total_paid_ugx: 98500000,
      },
    },
    expectedAnswerText:
      "From 2026-09-27 to 2026-10-26, Landlord Ops verified 134 landlords and completed 119 landlord payouts totaling UGX 98,500,000.",
  },
  {
    id: "Q26",
    group: "Group C — Landlord Ops",
    callerRole: "landlord_ops",
    question: "What is the Landlord Ops home summary for this month?",
    toolName: "get_lops_home_range",
    expectedRpc: "assistant_staff_lops_home_range",
    toolArgs: { period: "this_month" },
    expectedRpcArgs: { p_from: "2026-10-01", p_to: "2026-10-26" },
    expectedSource: "ops_landlord_ops_home_range",
    expectedPeriod: "2026-10-01 to 2026-10-26",
    expectedNumbers: [108, 97, 81200000],
    officialReportOutput: {
      source: "ops_landlord_ops_home_range",
      period: { from: "2026-10-01", to: "2026-10-26" },
      row_count: 1,
      data: {
        landlords_verified: 108,
        payouts_completed: 97,
        total_paid_ugx: 81200000,
      },
    },
    expectedAnswerText:
      "For 2026-10-01 to 2026-10-26, Landlord Ops verified 108 landlords and completed 97 payouts worth UGX 81,200,000.",
  },
  {
    id: "Q27",
    group: "Group C — Landlord Ops",
    callerRole: "landlord_ops",
    question: "Show me the count and total rent paid on the paid_repaying landlords list.",
    toolName: "get_lops_paid_lists",
    expectedRpc: "assistant_staff_lops_paid_lists",
    toolArgs: { tab: "paid_repaying", limit: 50 },
    expectedRpcArgs: { p_tab: "paid_repaying", p_search: null, p_limit: 50, p_offset: 0 },
    expectedSource: "landlord_ops_paid_lists",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [264, 214500000],
    officialReportOutput: {
      source: "landlord_ops_paid_lists",
      period: { as_of: "2026-10-26" },
      row_count: 264,
      data: {
        tab: "paid_repaying",
        total_count: 264,
        total_rent_paid_ugx: 214500000,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, the paid_repaying landlords list has 264 landlords with UGX 214,500,000 in rent paid.",
  },
  {
    id: "Q28",
    group: "Group C — Landlord Ops",
    callerRole: "landlord_ops",
    question: "How many landlords are on the paid_not_repaying tab right now?",
    toolName: "get_lops_paid_lists",
    expectedRpc: "assistant_staff_lops_paid_lists",
    toolArgs: { tab: "paid_not_repaying", limit: 50 },
    expectedRpcArgs: { p_tab: "paid_not_repaying", p_search: null, p_limit: 50, p_offset: 0 },
    expectedSource: "landlord_ops_paid_lists",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [23, 18900000],
    officialReportOutput: {
      source: "landlord_ops_paid_lists",
      period: { as_of: "2026-10-26" },
      row_count: 23,
      data: {
        tab: "paid_not_repaying",
        total_count: 23,
        total_rent_paid_ugx: 18900000,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, there are 23 landlords on the paid_not_repaying tab representing UGX 18,900,000 in paid rent.",
  },
  {
    id: "Q29",
    group: "Group C — Landlord Ops",
    callerRole: "landlord_ops",
    question: "How does cumulative non-cancelled float allocated compare to non-reversed principal collected in Landlord Ops?",
    toolName: "get_lops_principal_comparison",
    expectedRpc: "assistant_staff_lops_principal_comparison",
    toolArgs: {},
    expectedRpcArgs: { p_from: null, p_to: "2026-10-26" },
    expectedSource: "landlord_ops_principal_comparison + landlord_ops_float_overview",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [482000000, 396500000, 85500000],
    officialReportOutput: {
      source: "landlord_ops_principal_comparison + landlord_ops_float_overview",
      period: { as_of: "2026-10-26" },
      row_count: 1,
      data: {
        cumulative_float_allocated_ugx: 482000000,
        cumulative_principal_collected_ugx: 396500000,
        outstanding_principal_gap_ugx: 85500000,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, cumulative non-cancelled landlord float allocated is UGX 482,000,000 compared to UGX 396,500,000 in non-reversed principal collected (net gap UGX 85,500,000).",
  },
  {
    id: "Q30",
    group: "Group C — Landlord Ops",
    callerRole: "landlord_ops",
    question: "What is the Landlord Ops principal vs float comparison for this month?",
    toolName: "get_lops_principal_comparison",
    expectedRpc: "assistant_staff_lops_principal_comparison",
    toolArgs: { period: "this_month" },
    expectedRpcArgs: { p_from: "2026-10-01", p_to: "2026-10-26" },
    expectedSource: "landlord_ops_principal_comparison + landlord_ops_float_overview",
    expectedPeriod: "2026-10-01 to 2026-10-26",
    expectedNumbers: [84000000, 71300000],
    officialReportOutput: {
      source: "landlord_ops_principal_comparison + landlord_ops_float_overview",
      period: { from: "2026-10-01", to: "2026-10-26" },
      row_count: 1,
      data: {
        period_float_allocated_ugx: 84000000,
        period_principal_collected_ugx: 71300000,
      },
    },
    expectedAnswerText:
      "From 2026-10-01 to 2026-10-26, non-cancelled float allocated was UGX 84,000,000 and non-reversed principal collected was UGX 71,300,000.",
  },
  {
    id: "Q31",
    group: "Group C — Landlord Ops",
    callerRole: "landlord_ops",
    question: "What is the Landlord Calling Center call summary over the last 7 days and current Wednesday-Tuesday week?",
    toolName: "get_lops_calling_summary",
    expectedRpc: "assistant_staff_lops_calling_summary",
    toolArgs: {},
    expectedRpcArgs: { p_from: "2026-10-20", p_to: "2026-10-26", p_week_start: "2026-10-21" },
    expectedSource: "landlord_cc_daily_summary + landlord_cc_weekly_report",
    expectedPeriod: "2026-10-20 to 2026-10-26",
    expectedNumbers: [318, 246, 72],
    officialReportOutput: {
      source: "landlord_cc_daily_summary + landlord_cc_weekly_report",
      period: { from: "2026-10-20", to: "2026-10-26" },
      row_count: 7,
      data: {
        week_start: "2026-10-21",
        total_calls: 318,
        answered_calls: 246,
        unreached_calls: 72,
      },
    },
    expectedAnswerText:
      "Over 2026-10-20 to 2026-10-26 (Wednesday week starting 2026-10-21), the Landlord Calling Center logged 318 calls: 246 answered and 72 unreached.",
  },
  {
    id: "Q32",
    group: "Group C — Landlord Ops",
    callerRole: "landlord_ops",
    question: "What is the Landlord Calling Center registry coverage and how many landlords have never been called?",
    toolName: "get_lops_calling_coverage",
    expectedRpc: "assistant_staff_lops_calling_coverage",
    toolArgs: {},
    expectedRpcArgs: { p_as_at: null },
    expectedSource: "landlord_cc_coverage",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [940, 782, 158],
    officialReportOutput: {
      source: "landlord_cc_coverage",
      period: { as_of: "2026-10-26" },
      row_count: 12,
      data: {
        registry_total: 940,
        ever_reached: 782,
        never_called: 158,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, out of 940 landlords in the Landlord Calling Center registry, 782 have been reached and 158 have never been called.",
  },

  // ===========================================================================
  // GROUP D — AGENT OPS (Q33–Q39)
  // ===========================================================================
  {
    id: "Q33",
    group: "Group D — Agent Ops",
    callerRole: "coo",
    question: "What is the Agent Ops network overview over the last 30 days?",
    toolName: "get_aops_network_overview",
    expectedRpc: "assistant_staff_aops_network_overview",
    toolArgs: { period: "last_30_days" },
    expectedRpcArgs: { p_from: "2026-09-27", p_to: "2026-10-26", p_min_expected: 50000 },
    expectedSource: "get_agent_ops_network_overview (Agent Ops Network Overview)",
    expectedPeriod: "2026-09-27 to 2026-10-26",
    expectedNumbers: [186, 104200000, 91600000],
    officialReportOutput: {
      source: "get_agent_ops_network_overview (Agent Ops Network Overview)",
      period: { from: "2026-09-27", to: "2026-10-26" },
      row_count: 1,
      data: {
        qualifying_agents: 186,
        expected_collections_ugx: 104200000,
        actual_collections_ugx: 91600000,
      },
    },
    expectedAnswerText:
      "From 2026-09-27 to 2026-10-26, the Agent Ops network had 186 qualifying agents with UGX 91,600,000 collected against UGX 104,200,000 expected.",
  },
  {
    id: "Q34",
    group: "Group D — Agent Ops",
    callerRole: "agent_ops",
    question: "What are the Agent Ops house-listing, verification, and advance totals over the last 30 days?",
    toolName: "get_aops_metrics_totals",
    expectedRpc: "assistant_staff_aops_metrics_totals",
    toolArgs: { period: "last_30_days" },
    expectedRpcArgs: { p_from: "2026-09-27", p_to: "2026-10-26" },
    expectedSource: "agent_ops_metrics_totals (Agent Ops Metrics Totals)",
    expectedPeriod: "2026-09-27 to 2026-10-26",
    expectedNumbers: [640, 495, 98, 47, 12375000],
    officialReportOutput: {
      source: "agent_ops_metrics_totals (Agent Ops Metrics Totals)",
      period: { from: "2026-09-27", to: "2026-10-26" },
      row_count: 1,
      data: {
        houses_listed: 640,
        houses_verified: 495,
        houses_pending: 98,
        houses_rejected: 47,
        listing_earned_ugx: 12375000,
      },
    },
    expectedAnswerText:
      "Over 2026-09-27 to 2026-10-26, agents listed 640 houses (495 verified, 98 pending, 47 rejected) and earned UGX 12,375,000 in listing bonuses.",
  },
  {
    id: "Q35",
    group: "Group D — Agent Ops",
    callerRole: "agent_ops",
    question: "What are the Agent Ops house-listing and advance totals for this month?",
    toolName: "get_aops_metrics_totals",
    expectedRpc: "assistant_staff_aops_metrics_totals",
    toolArgs: { period: "this_month" },
    expectedRpcArgs: { p_from: "2026-10-01", p_to: "2026-10-26" },
    expectedSource: "agent_ops_metrics_totals (Agent Ops Metrics Totals)",
    expectedPeriod: "2026-10-01 to 2026-10-26",
    expectedNumbers: [520, 410, 10250000, 6800000],
    officialReportOutput: {
      source: "agent_ops_metrics_totals (Agent Ops Metrics Totals)",
      period: { from: "2026-10-01", to: "2026-10-26" },
      row_count: 1,
      data: {
        houses_listed: 520,
        houses_verified: 410,
        listing_earned_ugx: 10250000,
        advances_outstanding_ugx: 6800000,
      },
    },
    expectedAnswerText:
      "From 2026-10-01 to 2026-10-26, Agent Ops recorded 520 houses listed (410 verified), UGX 10,250,000 in listing bonuses earned, and UGX 6,800,000 in outstanding agent advances.",
  },
  {
    id: "Q36",
    group: "Group D — Agent Ops",
    callerRole: "agent_ops",
    question: "How are qualifying agents performing on approved house listings over the last 30 days?",
    toolName: "get_aops_metrics_agents",
    expectedRpc: "assistant_staff_aops_metrics_agents",
    toolArgs: { period: "last_30_days", sort: "houses_approved", scope: "qualifying", limit: 25 },
    expectedRpcArgs: {
      p_from: "2026-09-27",
      p_to: "2026-10-26",
      p_search: null,
      p_sort: "houses_approved",
      p_scope: "qualifying",
      p_limit: 25,
    },
    expectedSource: "agent_ops_metrics_agents (Agent Ops Per-Agent Metrics)",
    expectedPeriod: "2026-09-27 to 2026-10-26",
    expectedNumbers: [25, 42, 38, 950000],
    officialReportOutput: {
      source: "agent_ops_metrics_agents (Agent Ops Per-Agent Metrics)",
      period: { from: "2026-09-27", to: "2026-10-26" },
      row_count: 25,
      agents: [
        {
          agent_name: "Kasule Ronald",
          houses_listed: 42,
          houses_approved: 38,
          listing_earned: 950000,
        },
      ],
    },
    expectedAnswerText:
      "Across the top 25 qualifying agents from 2026-09-27 to 2026-10-26, Kasule Ronald leads with 42 houses listed, 38 approved, and UGX 950,000 earned.",
  },
  {
    id: "Q37",
    group: "Group D — Agent Ops",
    callerRole: "agent_ops",
    question: "What is the house listing verification quality and agent advance risk breakdown over the last 30 days?",
    toolName: "get_aops_listing_quality_and_risk",
    expectedRpc: "assistant_staff_aops_listing_quality_and_risk",
    toolArgs: { period: "last_30_days", limit: 50 },
    expectedRpcArgs: { p_from: "2026-09-27", p_to: "2026-10-26", p_limit: 50 },
    expectedSource: "agent_ops_metrics_listing_quality + agent_ops_metrics_risk (Agent Ops Listing Quality & Risk)",
    expectedPeriod: "2026-09-27 to 2026-10-26",
    expectedNumbers: [98, 14, 4850000],
    officialReportOutput: {
      source: "agent_ops_metrics_listing_quality + agent_ops_metrics_risk (Agent Ops Listing Quality & Risk)",
      period: { from: "2026-09-27", to: "2026-10-26" },
      row_count: 14,
      data: {
        waiting_verification_count: 98,
        high_risk_advance_agents: 14,
        high_risk_advance_ugx: 4850000,
      },
    },
    expectedAnswerText:
      "For 2026-09-27 to 2026-10-26, 98 house listings are waiting in the verification queue and 14 agents are flagged for advance risk totaling UGX 4,850,000.",
  },
  {
    id: "Q38",
    group: "Group D — Agent Ops",
    callerRole: "agent_ops",
    question: "Which collecting agents have gone silent for 3+ days while holding float or having tenants owing today?",
    toolName: "get_aops_silent_collectors",
    expectedRpc: "assistant_staff_aops_silent_collectors",
    toolArgs: { min_days_silent: 3, limit: 50 },
    expectedRpcArgs: { p_min_days_silent: 3, p_limit: 50 },
    expectedSource: "agent_ops_silent_collectors (Agent Ops Silent Collectors)",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [16, 6420000, 3150000],
    officialReportOutput: {
      source: "agent_ops_silent_collectors (Agent Ops Silent Collectors)",
      period: { as_of: "2026-10-26" },
      row_count: 16,
      data: {
        silent_agents_count: 16,
        total_owed_today_ugx: 6420000,
        total_collection_float_held_ugx: 3150000,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, 16 collecting agents have been silent for 3+ days, with UGX 6,420,000 owed today and UGX 3,150,000 held in collection float.",
  },
  {
    id: "Q39",
    group: "Group D — Agent Ops",
    callerRole: "agent_ops",
    question: "How many collecting agents have been silent for at least 7 days?",
    toolName: "get_aops_silent_collectors",
    expectedRpc: "assistant_staff_aops_silent_collectors",
    toolArgs: { min_days_silent: 7, limit: 50 },
    expectedRpcArgs: { p_min_days_silent: 7, p_limit: 50 },
    expectedSource: "agent_ops_silent_collectors (Agent Ops Silent Collectors)",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [6, 2780000],
    officialReportOutput: {
      source: "agent_ops_silent_collectors (Agent Ops Silent Collectors)",
      period: { as_of: "2026-10-26" },
      row_count: 6,
      data: {
        silent_agents_count: 6,
        total_owed_today_ugx: 2780000,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, 6 collecting agents have been silent for 7+ days with UGX 2,780,000 owed today.",
  },

  // ===========================================================================
  // GROUP E — PARTNER OPS & PSO (Q40–Q45)
  // ===========================================================================
  {
    id: "Q40",
    group: "Group E — Partner Ops & PSO",
    callerRole: "partner_ops",
    question: "How many Supporter portfolios are pending in the Partner Ops queue, what is their total value, and how long has the oldest waited?",
    toolName: "get_pops_pending_summary",
    expectedRpc: "assistant_staff_pops_pending_summary",
    toolArgs: {},
    expectedRpcArgs: { p_month: null },
    expectedSource: "partner_ops_pending_portfolio_summary + partner_ops_pending_summary (Partner Ops Pending Queue)",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [7, 42500000, 4],
    officialReportOutput: {
      source: "partner_ops_pending_portfolio_summary + partner_ops_pending_summary (Partner Ops Pending Queue)",
      period: { as_of: "2026-10-26" },
      row_count: 1,
      data: {
        pending_count: 7,
        pending_value_ugx: 42500000,
        oldest_wait_days: 4,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, there are 7 pending Supporter portfolios in the Partner Ops queue valued at UGX 42,500,000, and the oldest has waited 4 days.",
  },
  {
    id: "Q41",
    group: "Group E — Partner Ops & PSO",
    callerRole: "partner_ops",
    question: "What are the overall Partner Ops Supporter portfolio totals and Returns breakdown over the last 30 days?",
    toolName: "get_pops_report_overview",
    expectedRpc: "assistant_staff_pops_report_overview",
    toolArgs: { period: "last_30_days" },
    expectedRpcArgs: { p_from: "2026-09-27", p_to: "2026-10-26" },
    expectedSource: "partner_ops_report_totals + partner_ops_report_breakdown (Partner Ops Portfolio & Returns Report)",
    expectedPeriod: "2026-09-27 to 2026-10-26",
    expectedNumbers: [154, 685000000, 46200000, 12800000],
    officialReportOutput: {
      source: "partner_ops_report_totals + partner_ops_report_breakdown (Partner Ops Portfolio & Returns Report)",
      period: { from: "2026-09-27", to: "2026-10-26" },
      row_count: 1,
      data: {
        active_portfolios: 154,
        total_active_principal_ugx: 685000000,
        returns_paid_period_ugx: 46200000,
        nearing_returns_due_ugx: 12800000,
      },
    },
    expectedAnswerText:
      "From 2026-09-27 to 2026-10-26, Partner Ops has 154 active Supporter portfolios with UGX 685,000,000 in principal, UGX 46,200,000 in Returns paid out, and UGX 12,800,000 in Returns nearing payout.",
  },
  {
    id: "Q42",
    group: "Group E — Partner Ops & PSO",
    callerRole: "partner_ops",
    question: "What is the Partner Ops Supporter portfolio & Returns report for this month?",
    toolName: "get_pops_report_overview",
    expectedRpc: "assistant_staff_pops_report_overview",
    toolArgs: { period: "this_month" },
    expectedRpcArgs: { p_from: "2026-10-01", p_to: "2026-10-26" },
    expectedSource: "partner_ops_report_totals + partner_ops_report_breakdown (Partner Ops Portfolio & Returns Report)",
    expectedPeriod: "2026-10-01 to 2026-10-26",
    expectedNumbers: [19, 112000000, 38400000],
    officialReportOutput: {
      source: "partner_ops_report_totals + partner_ops_report_breakdown (Partner Ops Portfolio & Returns Report)",
      period: { from: "2026-10-01", to: "2026-10-26" },
      row_count: 1,
      data: {
        created_portfolios_period: 19,
        created_principal_ugx: 112000000,
        returns_paid_period_ugx: 38400000,
      },
    },
    expectedAnswerText:
      "From 2026-10-01 to 2026-10-26, 19 new Supporter portfolios were created with UGX 112,000,000 in principal and UGX 38,400,000 in Returns paid out.",
  },
  {
    id: "Q43",
    group: "Group E — Partner Ops & PSO",
    callerRole: "partner_ops",
    question: "Look up Supporter 'Kato' in the Partner Ops directory and show their active portfolios, principal, and total Returns.",
    toolName: "get_pops_search_supporters",
    expectedRpc: "assistant_staff_pops_search_supporters",
    toolArgs: { search: "Kato", limit: 20 },
    expectedRpcArgs: { p_search: "Kato", p_limit: 20 },
    expectedSource: "partner_ops_search_partners (Partner Ops Supporter Directory)",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [3, 25000000, 3750000],
    officialReportOutput: {
      source: "partner_ops_search_partners (Partner Ops Supporter Directory)",
      period: { as_of: "2026-10-26" },
      row_count: 1,
      rows: [
        {
          full_name: "Kato Emmanuel",
          active_count: 3,
          total_principal: 25000000,
          total_returns: 3750000,
        },
      ],
    },
    expectedAnswerText:
      "Supporter Kato Emmanuel has 3 active portfolios with total principal of UGX 25,000,000 and total Returns of UGX 3,750,000.",
  },
  {
    id: "Q44",
    group: "Group E — Partner Ops & PSO",
    callerRole: "partner_ops",
    question: "How is our Partner Support Officer (PSO) cohort performing over the last 30 days?",
    toolName: "get_pso_cohort_performance",
    expectedRpc: "assistant_staff_pso_cohort_performance",
    toolArgs: { period: "last_30_days" },
    expectedRpcArgs: { p_from: "2026-09-27", p_to: "2026-10-26" },
    expectedSource: "pso_funded_summary + pso_promise_summary + pso_cohort_volume (PSO Cohort Performance)",
    expectedPeriod: "2026-09-27 to 2026-10-26",
    expectedNumbers: [28, 94500000, 33, 115000000],
    officialReportOutput: {
      source: "pso_funded_summary + pso_promise_summary + pso_cohort_volume (PSO Cohort Performance)",
      period: { from: "2026-09-27", to: "2026-10-26" },
      row_count: 1,
      data: {
        funded_notes_count: 28,
        funded_amount_ugx: 94500000,
        promised_notes_count: 33,
        promised_amount_ugx: 115000000,
      },
    },
    expectedAnswerText:
      "From 2026-09-27 to 2026-10-26, the PSO cohort recorded 28 funded promissory notes totaling UGX 94,500,000 and 33 promised notes totaling UGX 115,000,000.",
  },
  {
    id: "Q45",
    group: "Group E — Partner Ops & PSO",
    callerRole: "partner_ops",
    question: "What is the PSO cohort funded and promised summary for this month?",
    toolName: "get_pso_cohort_performance",
    expectedRpc: "assistant_staff_pso_cohort_performance",
    toolArgs: { period: "this_month" },
    expectedRpcArgs: { p_from: "2026-10-01", p_to: "2026-10-26" },
    expectedSource: "pso_funded_summary + pso_promise_summary + pso_cohort_volume (PSO Cohort Performance)",
    expectedPeriod: "2026-10-01 to 2026-10-26",
    expectedNumbers: [22, 78000000, 26, 92000000],
    officialReportOutput: {
      source: "pso_funded_summary + pso_promise_summary + pso_cohort_volume (PSO Cohort Performance)",
      period: { from: "2026-10-01", to: "2026-10-26" },
      row_count: 1,
      data: {
        funded_notes_count: 22,
        funded_amount_ugx: 78000000,
        promised_notes_count: 26,
        promised_amount_ugx: 92000000,
      },
    },
    expectedAnswerText:
      "From 2026-10-01 to 2026-10-26, the PSO cohort funded 22 notes worth UGX 78,000,000 and logged 26 promised notes worth UGX 92,000,000.",
  },

  // ===========================================================================
  // GROUP F — CFO & FINANCIAL OPS (Q46–Q53)
  // ===========================================================================
  {
    id: "Q46",
    group: "Group F — CFO & Financial Ops",
    callerRole: "cfo",
    question: "What is our authoritative Treasury cash position right now across A1 Cash and Bank, A5 Cash in Custody, and the Landlord Float Pool?",
    toolName: "get_cfo_treasury_cash_position",
    expectedRpc: "assistant_staff_cfo_treasury_cash_position",
    toolArgs: {},
    expectedRpcArgs: { p_as_at: null },
    expectedSource: "get_treasury_cash_position (Treasury Cash Position — A1/A5/A21/A22)",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [142850000, 96400000, 18250000, 28200000],
    officialReportOutput: {
      source: "get_treasury_cash_position (Treasury Cash Position — A1/A5/A21/A22)",
      period: { as_of: "2026-10-26" },
      row_count: 1,
      data: {
        total_treasury_cash_ugx: 142850000,
        a1_cash_and_bank_ugx: 96400000,
        a5_cash_in_custody_ugx: 18250000,
        landlord_float_pool_ugx: 28200000,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, authoritative Treasury cash position is UGX 142,850,000:\n- A1 Cash and Bank: UGX 96,400,000\n- A5 Cash in Custody: UGX 18,250,000\n- A21/A22 Landlord Float Pool: UGX 28,200,000",
  },
  {
    id: "Q47",
    group: "Group F — CFO & Financial Ops",
    callerRole: "cfo",
    question: "What was the Treasury cash position snapshot as at 2026-09-30?",
    toolName: "get_cfo_treasury_cash_position",
    expectedRpc: "assistant_staff_cfo_treasury_cash_position",
    toolArgs: { as_at: "2026-09-30" },
    expectedRpcArgs: { p_as_at: "2026-09-30T23:59:59+03:00" },
    expectedSource: "get_treasury_cash_position (Treasury Cash Position — A1/A5/A21/A22)",
    expectedPeriod: "as of 2026-09-30",
    expectedNumbers: [128400000, 88100000, 16300000, 24000000],
    officialReportOutput: {
      source: "get_treasury_cash_position (Treasury Cash Position — A1/A5/A21/A22)",
      period: { as_of: "2026-09-30" },
      row_count: 1,
      data: {
        total_treasury_cash_ugx: 128400000,
        a1_cash_and_bank_ugx: 88100000,
        a5_cash_in_custody_ugx: 16300000,
        landlord_float_pool_ugx: 24000000,
      },
    },
    expectedAnswerText:
      "As of 2026-09-30, total Treasury cash was UGX 128,400,000 (A1 Cash and Bank: UGX 88,100,000; A5 Cash in Custody: UGX 16,300,000; Landlord Float Pool: UGX 24,000,000).",
  },
  {
    id: "Q48",
    group: "Group F — CFO & Financial Ops",
    callerRole: "cfo",
    question: "How much money was received versus paid out today and this month?",
    toolName: "get_cfo_money_flow_summary",
    expectedRpc: "assistant_staff_cfo_money_flow_summary",
    toolArgs: {},
    expectedRpcArgs: {},
    expectedSource: "get_cfo_money_received + get_cfo_money_paid_out (CFO Money Flow Summary)",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [14800000, 11250000, 312400000, 278900000],
    officialReportOutput: {
      source: "get_cfo_money_received + get_cfo_money_paid_out (CFO Money Flow Summary)",
      period: { as_of: "2026-10-26" },
      row_count: 1,
      data: {
        today_received_ugx: 14800000,
        today_paid_out_ugx: 11250000,
        month_received_ugx: 312400000,
        month_paid_out_ugx: 278900000,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, CFO money flow shows:\n- Today received: UGX 14,800,000 vs Today paid out: UGX 11,250,000\n- This month received: UGX 312,400,000 vs This month paid out: UGX 278,900,000",
  },
  {
    id: "Q49",
    group: "Group F — CFO & Financial Ops",
    callerRole: "cfo",
    question: "What are our total company Receivables and Payables, and the 4-week predictive Payables forecast?",
    toolName: "get_cfo_receivables_and_payables",
    expectedRpc: "assistant_staff_cfo_receivables_and_payables",
    toolArgs: { granularity: "week", periods: 4 },
    expectedRpcArgs: { p_granularity: "week", p_periods: 4, p_as_at: null },
    expectedSource: "get_receivables_total + get_payables_total + get_payables_predictive_forecast (Receivables & Payables)",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [524600000, 189300000, 68400000],
    officialReportOutput: {
      source: "get_receivables_total + get_payables_total + get_payables_predictive_forecast (Receivables & Payables)",
      period: { as_of: "2026-10-26" },
      row_count: 4,
      data: {
        total_receivables_ugx: 524600000,
        total_payables_ugx: 189300000,
        forecast_4_weeks_ugx: 68400000,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, official company Receivables total UGX 524,600,000, total Payables are UGX 189,300,000, and the 4-week predictive Payables forecast is UGX 68,400,000.",
  },
  {
    id: "Q50",
    group: "Group F — CFO & Financial Ops",
    callerRole: "financial_ops",
    question: "What is the 3-month predictive Payables forecast anchored on 2026-10-26?",
    toolName: "get_cfo_receivables_and_payables",
    expectedRpc: "assistant_staff_cfo_receivables_and_payables",
    toolArgs: { granularity: "month", periods: 3, as_at: "2026-10-26" },
    expectedRpcArgs: { p_granularity: "month", p_periods: 3, p_as_at: "2026-10-26" },
    expectedSource: "get_receivables_total + get_payables_total + get_payables_predictive_forecast (Receivables & Payables)",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [189300000, 152800000],
    officialReportOutput: {
      source: "get_receivables_total + get_payables_total + get_payables_predictive_forecast (Receivables & Payables)",
      period: { as_of: "2026-10-26" },
      row_count: 3,
      data: {
        total_payables_ugx: 189300000,
        forecast_3_months_ugx: 152800000,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, total Payables are UGX 189,300,000 and the 3-month predictive Payables forecast is UGX 152,800,000.",
  },
  {
    id: "Q51",
    group: "Group F — CFO & Financial Ops",
    callerRole: "cfo",
    question: "What are the CFO 7-day actual and predicted platform expenses?",
    toolName: "get_cfo_seven_day_expenses",
    expectedRpc: "assistant_staff_cfo_seven_day_expenses",
    toolArgs: {},
    expectedRpcArgs: {},
    expectedSource: "get_cfo_seven_day_expenses (CFO 7-Day Platform Expenses)",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [24600000, 21900000],
    officialReportOutput: {
      source: "get_cfo_seven_day_expenses (CFO 7-Day Platform Expenses)",
      period: { as_of: "2026-10-26" },
      row_count: 14,
      data: {
        actual_last_7_days_ugx: 24600000,
        predicted_next_7_days_ugx: 21900000,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, 7-day actual platform expenses are UGX 24,600,000 and predicted expenses for the next 7 Kampala days are UGX 21,900,000.",
  },
  {
    id: "Q52",
    group: "Group F — CFO & Financial Ops",
    callerRole: "cfo",
    question: "What is our revised department budget position including CFO-approved supplements?",
    toolName: "get_cfo_budget_revised_position",
    expectedRpc: "assistant_staff_cfo_budget_revised_position",
    toolArgs: {},
    expectedRpcArgs: {},
    expectedSource: "budget_revised_position (CFO Revised Budget Position)",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [120000000, 15000000, 135000000, 89400000, 45600000],
    officialReportOutput: {
      source: "budget_revised_position (CFO Revised Budget Position)",
      period: { as_of: "2026-10-26" },
      row_count: 6,
      data: {
        original_approved_ugx: 120000000,
        approved_supplements_ugx: 15000000,
        revised_budget_ugx: 135000000,
        actual_spent_ugx: 89400000,
        remaining_balance_ugx: 45600000,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, the revised budget position is UGX 135,000,000 (original UGX 120,000,000 plus UGX 15,000,000 in CFO-approved supplements), with UGX 89,400,000 spent and UGX 45,600,000 remaining.",
  },
  {
    id: "Q53",
    group: "Group F — CFO & Financial Ops",
    callerRole: "financial_ops",
    question: "What is the status of the Financial Ops payout verification queue and CFO-approved requisitions over the last 30 days?",
    toolName: "get_fops_verification_and_requisitions",
    expectedRpc: "assistant_staff_fops_verification_and_requisitions",
    toolArgs: { period: "last_30_days" },
    expectedRpcArgs: { p_from: "2026-09-27", p_to: "2026-10-26" },
    expectedSource: "finops_payout_verification_counts + cfo_approved_requisitions (Financial Ops Verification & Requisitions)",
    expectedPeriod: "2026-09-27 to 2026-10-26",
    expectedNumbers: [14, 109, 6, 31, 18750000],
    officialReportOutput: {
      source: "finops_payout_verification_counts + cfo_approved_requisitions (Financial Ops Verification & Requisitions)",
      period: { from: "2026-09-27", to: "2026-10-26" },
      row_count: 31,
      data: {
        waiting_verification: 14,
        verified_count: 109,
        mismatch_count: 6,
        approved_requisitions_count: 31,
        approved_requisitions_ugx: 18750000,
      },
    },
    expectedAnswerText:
      "From 2026-09-27 to 2026-10-26, the Financial Ops payout verification queue has 14 waiting, 109 verified, and 6 mismatch items, alongside 31 CFO-approved requisitions totaling UGX 18,750,000.",
  },

  // ===========================================================================
  // GROUP G — COO, CEO & MANAGERS (Q54–Q56)
  // ===========================================================================
  {
    id: "Q54",
    group: "Group G — COO, CEO & Managers",
    callerRole: "coo",
    question: "What is the COO Command Center live operational summary and Rent Coverage Statement over the trailing 14 days?",
    toolName: "get_coo_overview",
    expectedRpc: "assistant_staff_coo_overview",
    toolArgs: { days: 14 },
    expectedRpcArgs: { p_days: 14, p_from: null, p_to: null },
    expectedSource: "get_coo_command_center + get_coo_overview_snapshot + get_coo_rent_coverage_statement (COO Executive Overview)",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [815, 11400000, 198500000, 29],
    officialReportOutput: {
      source: "get_coo_command_center + get_coo_overview_snapshot + get_coo_rent_coverage_statement (COO Executive Overview)",
      period: { as_of: "2026-10-26" },
      row_count: 1,
      data: {
        active_rent_plans: 815,
        collections_today_ugx: 11400000,
        collections_month_ugx: 198500000,
        pending_coo_decisions: 29,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, the COO Command Center reports 815 active Rent Plans, UGX 11,400,000 collected today, UGX 198,500,000 collected this month, and 29 pending operational decisions.",
  },
  {
    id: "Q55",
    group: "Group G — COO, CEO & Managers",
    callerRole: "ceo",
    question: "What is the CEO growth quality summary over the last 30 days and how many requisitions are awaiting executive approval?",
    toolName: "get_ceo_growth_and_approvals",
    expectedRpc: "assistant_staff_ceo_growth_and_approvals",
    toolArgs: { days: 30 },
    expectedRpcArgs: { p_days: 30 },
    expectedSource: "get_ceo_growth_quality + staff_requisition_pending_prompt (CEO Growth Quality & Approvals)",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [815, 612000000, 5, 3450000],
    officialReportOutput: {
      source: "get_ceo_growth_quality + staff_requisition_pending_prompt (CEO Growth Quality & Approvals)",
      period: { as_of: "2026-10-26" },
      row_count: 5,
      data: {
        active_rent_plans: 815,
        capital_deployed_ugx: 612000000,
        pending_executive_requisitions: 5,
        pending_requisitions_ugx: 3450000,
      },
    },
    expectedAnswerText:
      "Over the 30-day window as of 2026-10-26, CEO growth quality shows 815 active Rent Plans with UGX 612,000,000 in capital deployed, and 5 staff requisitions totaling UGX 3,450,000 awaiting executive approval.",
  },
  {
    id: "Q56",
    group: "Group G — COO, CEO & Managers",
    callerRole: "ceo",
    question: "What is the CEO growth quality summary over the last 90 days?",
    toolName: "get_ceo_growth_and_approvals",
    expectedRpc: "assistant_staff_ceo_growth_and_approvals",
    toolArgs: { days: 90 },
    expectedRpcArgs: { p_days: 90 },
    expectedSource: "get_ceo_growth_quality + staff_requisition_pending_prompt (CEO Growth Quality & Approvals)",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [420, 1480000000],
    officialReportOutput: {
      source: "get_ceo_growth_quality + staff_requisition_pending_prompt (CEO Growth Quality & Approvals)",
      period: { as_of: "2026-10-26" },
      row_count: 1,
      data: {
        newly_funded_plans_90d: 420,
        capital_deployed_90d_ugx: 1480000000,
      },
    },
    expectedAnswerText:
      "Over the 90-day window as of 2026-10-26, 420 Rent Plans were funded with UGX 1,480,000,000 in capital deployed.",
  },

  // ===========================================================================
  // GROUP H — HR & CALLING TEAM (Q57–Q60)
  // ===========================================================================
  {
    id: "Q57",
    group: "Group H — HR & Calling Team",
    callerRole: "hr",
    question: "How many calls and pipeline reviews did the calling team (Jane, Winnie, Hanisha) make over the last 7 days?",
    toolName: "get_hr_calling_detailed_report",
    expectedRpc: "assistant_staff_hr_calling_detailed_report",
    toolArgs: { period: "last_7_days" },
    expectedRpcArgs: { p_from: "2026-10-20", p_to: "2026-10-26" },
    expectedSource: "staff_calling_detailed_report + cc_weekly_all_calls_report (Staff Calling & Pipeline Feedback Report)",
    expectedPeriod: "2026-10-20 to 2026-10-26",
    expectedNumbers: [486, 192, 158, 136],
    officialReportOutput: {
      source: "staff_calling_detailed_report + cc_weekly_all_calls_report (Staff Calling & Pipeline Feedback Report)",
      period: { from: "2026-10-20", to: "2026-10-26" },
      row_count: 3,
      data: {
        total_team_calls: 486,
        jane_calls: 192,
        winnie_calls: 158,
        hanisha_calls: 136,
      },
    },
    expectedAnswerText:
      "From 2026-10-20 to 2026-10-26, the calling team completed 486 calls and pipeline reviews: Jane 192, Winnie 158, and Hanisha 136.",
  },
  {
    id: "Q58",
    group: "Group H — HR & Calling Team",
    callerRole: "hr",
    question: "How many calls and pipeline reviews did the calling team make this month?",
    toolName: "get_hr_calling_detailed_report",
    expectedRpc: "assistant_staff_hr_calling_detailed_report",
    toolArgs: { period: "this_month" },
    expectedRpcArgs: { p_from: "2026-10-01", p_to: "2026-10-26" },
    expectedSource: "staff_calling_detailed_report + cc_weekly_all_calls_report (Staff Calling & Pipeline Feedback Report)",
    expectedPeriod: "2026-10-01 to 2026-10-26",
    expectedNumbers: [1840, 725, 590, 525],
    officialReportOutput: {
      source: "staff_calling_detailed_report + cc_weekly_all_calls_report (Staff Calling & Pipeline Feedback Report)",
      period: { from: "2026-10-01", to: "2026-10-26" },
      row_count: 3,
      data: {
        total_team_calls: 1840,
        jane_calls: 725,
        winnie_calls: 590,
        hanisha_calls: 525,
      },
    },
    expectedAnswerText:
      "From 2026-10-01 to 2026-10-26, the calling team logged 1,840 calls and pipeline reviews: Jane 725, Winnie 590, and Hanisha 525.",
  },
  {
    id: "Q59",
    group: "Group H — HR & Calling Team",
    callerRole: "hr",
    question: "Which staff contracts are expiring within 60 days and how many staff birthdays are coming up?",
    toolName: "get_hr_contracts_and_birthdays",
    expectedRpc: "assistant_staff_hr_contracts_and_birthdays",
    toolArgs: { days: 60 },
    expectedRpcArgs: { p_days: 60 },
    expectedSource: "hr_contracts_expiring + hr_list_staff_birthdays (HR Expiring Contracts & Upcoming Birthdays)",
    expectedPeriod: "as of 2026-10-26",
    expectedNumbers: [4, 2, 7],
    officialReportOutput: {
      source: "hr_contracts_expiring + hr_list_staff_birthdays (HR Expiring Contracts & Upcoming Birthdays)",
      period: { as_of: "2026-10-26" },
      row_count: 4,
      data: {
        expiring_within_60_days: 4,
        expiring_within_30_days: 2,
        upcoming_birthdays_count: 7,
      },
    },
    expectedAnswerText:
      "As of 2026-10-26, 4 staff contracts expire within 60 days (including 2 within 30 days), and 7 active staff members have upcoming birthdays.",
  },
  {
    id: "Q60",
    group: "Group H — HR & Calling Team",
    callerRole: "hr",
    question: "What is our HR payroll cost breakdown by department for payroll period 2026-10?",
    toolName: "get_hr_payroll_cost_by_department",
    expectedRpc: "assistant_staff_hr_payroll_cost_by_department",
    toolArgs: { period_code: "2026-10" },
    expectedRpcArgs: { p_period_code: "2026-10" },
    expectedSource: "hr_pay_cost_by_department (HR Payroll Cost by Department)",
    expectedPeriod: "2026-10",
    expectedNumbers: [50, 74500000, 11850000, 7450000, 81950000],
    officialReportOutput: {
      source: "hr_pay_cost_by_department (HR Payroll Cost by Department)",
      period: "2026-10",
      row_count: 6,
      data: {
        headcount: 50,
        total_gross_ugx: 74500000,
        total_paye_ugx: 11850000,
        total_employer_nssf_ugx: 7450000,
        total_employer_cost_ugx: 81950000,
      },
    },
    expectedAnswerText:
      "For payroll period 2026-10 across 50 active staff:\n- Total gross pay: UGX 74,500,000\n- Total PAYE: UGX 11,850,000\n- Employer NSSF contribution: UGX 7,450,000\n- Total employer payroll cost: UGX 81,950,000",
  },
];

/**
 * Executes all 60 real staff questions on the fixed date (`2026-10-26`)
 * and scores each question on:
 *   1. Exact numbers matching the official report function output
 *   2. Correct dates / period resolved on `2026-10-26`
 *   3. Official database function source named
 *   4. Post-generation output guard (`checkAnswer`) & Welile terminology compliance
 */
export async function runAccuracyPack(): Promise<AccuracyPackSummary> {
  const results: AccuracyQuestionScore[] = [];

  for (const q of ACCURACY_QUESTIONS_60) {
    const tool = findTool(q.toolName);
    if (!tool) {
      throw new Error(`Accuracy question ${q.id} references unknown tool "${q.toolName}"`);
    }

    const parsedToolArgs = tool.schema.safeParse(q.toolArgs);
    const resolvedRpcArgs = withFixedEvalDateSync(() =>
      tool.toRpcArgs(parsedToolArgs.success ? parsedToolArgs.data : {})
    );

    const rpcArgsMatched =
      tool.rpc === q.expectedRpc &&
      JSON.stringify(resolvedRpcArgs) === JSON.stringify(q.expectedRpcArgs);

    const turn = await executeZoeTurn({
      callerRoles: [q.callerRole],
      userMessage: q.question,
      modelToolCalls: [{ name: q.toolName, args: q.toolArgs }],
      rpcDataByTool: {
        [q.toolName]: q.officialReportOutput,
      },
      modelFinalText: q.expectedAnswerText,
    });

    const answerNumbers = extractNumbersFromText(turn.reply);
    const exactNumbersMatched =
      turn.outcome === "answered" &&
      q.expectedNumbers.every((n) => answerNumbers.has(Math.round(n)));

    const correctDatesMatched =
      rpcArgsMatched &&
      turn.period === q.expectedPeriod &&
      turn.reply.includes(`Period: ${q.expectedPeriod}`);

    const sourceNamedMatched =
      turn.source === q.expectedSource &&
      turn.reply.includes(`Source: ${q.expectedSource}`);

    const guardCheck = checkAnswer(
      turn.reply,
      [
        JSON.stringify(q.officialReportOutput),
        JSON.stringify({ source: q.expectedSource, period: q.expectedPeriod }),
      ],
      q.question,
    );
    const guardPassed = guardCheck.ok;

    const passed =
      exactNumbersMatched &&
      correctDatesMatched &&
      sourceNamedMatched &&
      guardPassed;

    results.push({
      id: q.id,
      group: q.group,
      callerRole: q.callerRole,
      question: q.question,
      toolName: q.toolName,
      expectedRpc: q.expectedRpc,
      expectedSource: q.expectedSource,
      expectedPeriod: q.expectedPeriod,
      expectedNumbers: q.expectedNumbers,
      rpcArgsMatched,
      exactNumbersMatched,
      correctDatesMatched,
      sourceNamedMatched,
      guardPassed,
      passed,
      reply: turn.reply,
    });
  }

  const byGroup: Record<string, { total: number; passed: number }> = {};
  for (const r of results) {
    if (!byGroup[r.group]) byGroup[r.group] = { total: 0, passed: 0 };
    byGroup[r.group].total += 1;
    if (r.passed) byGroup[r.group].passed += 1;
  }

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  const scorePct = total > 0 ? Number(((passed / total) * 100).toFixed(2)) : 0;

  return {
    fixedDate: FIXED_EVAL_DATE,
    total,
    passed,
    failed,
    scorePct,
    exactNumbersPassCount: results.filter((r) => r.exactNumbersMatched).length,
    correctDatesPassCount: results.filter((r) => r.correctDatesMatched).length,
    sourceNamedPassCount: results.filter((r) => r.sourceNamedMatched).length,
    guardPassCount: results.filter((r) => r.guardPassed).length,
    byGroup,
    results,
  };
}
