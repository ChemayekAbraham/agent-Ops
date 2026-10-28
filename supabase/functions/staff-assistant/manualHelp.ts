import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";

export interface StaffManualEntry {
  id: string;
  title: string;
  screenPath: string;
  keywords: readonly string[];
  roles: readonly string[];
  guide: string;
}

export const STAFF_MANUAL_ENTRIES: readonly StaffManualEntry[] = [
  {
    id: "my_space_navigation",
    title: "My Space Overview & Personal Tools",
    screenPath: "/me",
    keywords: ["my space", "payslip", "tasks", "tickets", "canteen", "salary advance", "wallet", "profile", "where do i find"],
    roles: ["*"],
    guide:
      "Open My Space at /me to view your personal staff items: Profile & HR assignments (/me/work), Payslips (/me/payslips), Tasks & Tickets (/me/work), Requisitions (/me/requisitions), Salary Advances (/me/advances), Canteen (/me/canteen), Calling & Pipeline Reports (/me/reports), and Ask Zoe (/me/zoe).",
  },
  {
    id: "staff_requisitions",
    title: "How to Submit & Track a Staff Requisition",
    screenPath: "/me/requisitions",
    keywords: ["requisition", "submit requisition", "approve requisition", "expense request", "budget"],
    roles: ["*"],
    guide:
      "Go to My Space -> Requisitions (/me/requisitions) to create or track a requisition. Standard staff requisitions follow COO -> CEO -> CFO approval (Product R&D budget heads route CEO -> CFO directly). Zoe is read-only and can check your requisition status, but submission and approvals happen on the Requisitions screen.",
  },
  {
    id: "payout_clock_and_arrears",
    title: "How the Repayment Clock & Arrears Work (Agent Monitoring & Tenant Ops)",
    screenPath: "/tenant-ops",
    keywords: ["payout clock", "repayment clock", "clock start", "arrears", "uncovered", "landlord not paid", "explain clock"],
    roles: ["*"],
    guide:
      "A Rent Plan's repayment clock (`am_plan_clock`) starts the day after its last landlord payout (`awaiting_agent_receipt` or `completed`). Plans with no landlord payout yet have no repayment clock (they owe nothing yet) and appear in the 'Waiting for landlord payment' (`tenant_paying_no_landlord` / `awaiting_landlord`) bucket across Agent Monitoring, Tenant Ops Workspace, and Weekly Performance.",
  },
  {
    id: "rent_request_time_on_desk",
    title: "Where to Find Rent Plan Requests & Time on Desk",
    screenPath: "/tenant-ops",
    keywords: ["time on desk", "desk timing", "rent requests", "pipeline stage", "stuck request", "longest waiting"],
    roles: ["*"],
    guide:
      "Rent Plan applications move through desks in order: Service Centre -> Agent Ops -> Tenant Ops -> Landlord Ops -> Partner Ops -> COO -> CFO. Each desk card shows the server-calculated time on the current desk, previous visit, and total time from `rent_request_timing`. You can also ask Zoe 'What is the time on desk for open rent requests?' or 'How many rent requests came in today and by stage?'.",
  },
  {
    id: "calling_center_and_awareness_calls",
    title: "Calling Center, Awareness Calls & My Own Calls",
    screenPath: "/me/reports",
    keywords: ["calling center", "awareness call", "my calls", "call report", "feedback", "concerns"],
    roles: ["*"],
    guide:
      "Staff call logs and Rent Plan pipeline feedback live at /me/reports (and /me/staff-reports for HR & management), powered by `staff_calling_detailed_report` and `cc_weekly_all_calls_report`. Calls are deduplicated within a 15-minute window so the same call is never double-counted.",
  },
  {
    id: "landlord_verification_and_payouts",
    title: "Landlord Verification Queue & Paid Landlords Lists",
    screenPath: "/landlord-ops",
    keywords: ["landlord verification", "verify landlord", "lc1", "house verification", "paid landlords", "landlord float"],
    roles: ["*"],
    guide:
      "In the Landlord Ops Workspace (/landlord-ops), the verification queues show pending houses, landlords, and LC1 verifications. The Landlords tab shows 'Paid & Repaying' and 'Completed' lists from `landlord_ops_paid_lists`. Landlord payout numbers lock at the COO/CFO stage.",
  },
  {
    id: "supporter_portfolios_and_returns",
    title: "Supporter Portfolios, Returns Due & Waiting Top-Ups / Withdrawals",
    screenPath: "/partner-ops",
    keywords: ["supporter", "portfolio", "returns", "top-up", "withdrawal", "partner ops"],
    roles: ["*"],
    guide:
      "In the Partner Ops Workspace (/partner-ops), you can inspect active Supporter portfolios, Returns due, invited portfolios, and pending portfolio top-ups or withdrawals waiting for verification.",
  },
  {
    id: "treasury_and_disbursements",
    title: "Treasury Cash Position, Disbursements & Merchant Cash-Outs",
    screenPath: "/cfo",
    keywords: ["treasury", "cash position", "disbursement", "merchant cash-out", "financial ops", "cfo"],
    roles: ["*"],
    guide:
      "Platform cash position in the CFO Workspace (/cfo) and Financial Ops (/financial-ops) comes exclusively from `get_treasury_cash_position`. Disbursements track landlord payouts and approved requisitions, while merchant cash-outs and wallet withdrawals are reviewed in the withdrawal verification queue.",
  },
  {
    id: "zoe_capabilities",
    title: "What Zoe Can Do in My Space",
    screenPath: "/me/zoe",
    keywords: ["what can you do", "help", "capabilities", "how to use zoe", "commands", "export pdf", "email report", "schedule"],
    roles: ["*"],
    guide:
      "Zoe is your read-only My Space assistant. You can: (1) ask about your own tasks, payslips, requisitions, advances, concerns, wallet, and calls; (2) query official department reports your role can access; (3) compare periods using Zoe's built-in calculator ('and last week?', 'what is the difference?'); (4) ask for an Excel (.xlsx) or PDF export of any table answer; and (5) draft report emails, personal reminders, colleague notifications, or recurring report schedules that only send after you click Confirm/Send.",
  },
];

export const ManualHelpArgsSchema = z
  .object({
    topic: z.string().trim().min(1).max(120),
  })
  .strict();

export const GET_STAFF_MANUAL_HELP_OPENAI_TOOL = {
  type: "function" as const,
  function: {
    name: "get_staff_manual_help",
    description:
      "Look up 'how do I…', 'where do I find…', or workflow explanations from the Welile staff manuals and docs/ (no business figures; safe for any staff role).",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "Topic or screen the staff member is asking about (e.g. 'submit requisition', 'payout clock', 'time on desk', 'landlord verification', 'what can you do').",
        },
      },
      required: ["topic"],
      additionalProperties: false,
    },
  },
};

export function searchStaffManualHelp(query: string): {
  source: string;
  topic: string;
  matches: StaffManualEntry[];
} {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter((w) => w.length >= 2);

  const scored = STAFF_MANUAL_ENTRIES.map((entry) => {
    let score = 0;
    const hay = `${entry.title} ${entry.keywords.join(" ")} ${entry.guide}`.toLowerCase();
    for (const kw of entry.keywords) {
      if (q.includes(kw.toLowerCase())) score += 4;
    }
    for (const w of words) {
      if (hay.includes(w)) score += 1;
    }
    return { entry, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.entry);

  return {
    source: "Welile Staff Manual & My Space Guide (docs/)",
    topic: query,
    matches: scored.length > 0 ? scored : [STAFF_MANUAL_ENTRIES[0], STAFF_MANUAL_ENTRIES[8]],
  };
}

const CONVERSATIONAL_INTENT_RE =
  /^(?:(?:hi+|hello+|hey+|y+o+|howdy|sup|wass+up|what'?s\s+up|good\s+(?:morning|afternoon|evening)|morning|afternoon|evening|greetings)(?:\s+(?:there|zoe|team|wass+up|what'?s\s+up|how\s+are\s+you.*|how'?s\s+it\s+going.*))?(?:[\s,!.?]+(?:who\s+are\s+you|what\s+can\s+you\s+do.*|how\s+can\s+you\s+help.*|wass+up.*|what'?s\s+up.*))?|how\s+are\s+you(?:\s+doing|\s+today|\s+zoe)?|how'?s\s+it\s+going(?:\s+zoe)?|thanks|thank\s+you.*|thx|appreciate\s+it|ok\s+thanks|got\s+it|who\s+are\s+you|what\s+can\s+you\s+do(?:\s+.*)?|what\s+do\s+you\s+do(?:\s+.*)?|help|how\s+can\s+you\s+help(?:\s+.*)?|explain\s+that(?:\s+.*)?|what\s+does\s+that\s+mean|can\s+you\s+explain\b.*|explain\b.*|what\s+is\b.*|what\s+are\b.*|define\b.*|how\s+do\s+i\b.*|where\s+do\s+i\s+find\b.*|where\s+can\s+i\s+find\b.*|where\s+is\s+the\b.*\s+(?:screen|page|tab|menu|button)\b.*|draft\b.*|write\b.*|help\s+me\s+(?:draft|write|plan|prepare|brainstorm|organize|summarise|summarize|word|phrase|reply)\b.*|brainstorm\b.*|suggest\s+(?:ways|ideas|agenda|checklist|questions|steps)\b.*|summarize\s+this\b.*|summarise\s+this\b.*|rewrite\b.*|rephrase\b.*)[?!.]*$/i;

const DATA_UNAVAILABLE_EXPLANATION_RE =
  /\b(checked|tried|do\s+not\s+have\s+a\s+(?:live|verified)?\s*(?:tool|report|dataset)|cannot\s+find\s+that\s+(?:specific\s+)?(?:data|figure|report)|closest\s+(?:available\s+)?(?:report|screen|alternative)|suggest\s+(?:checking|asking|opening)|ask\s+(?:your|the)\s+(?:manager|department|operations|hr|cfo|coo))\b/i;

/**
 * Returns true when the user message (or Zoe's non-numeric natural reply) is a
 * conversational greeting, explanation, drafting, brainstorming, general work help,
 * or a transparent "here is what I checked and the closest alternative/person" reply
 * where Zoe may answer without calling a live business data tool (still verified by
 * `checkAnswer` so zero invented numbers can pass).
 */
export function isConversationalPromptAllowedWithoutTool(
  userMessage: string,
  assistantReply?: string,
): boolean {
  const cleanedUser = (userMessage ?? "").trim();
  if (CONVERSATIONAL_INTENT_RE.test(cleanedUser)) {
    return true;
  }
  const cleanedReply = (assistantReply ?? "").trim();
  if (cleanedReply && DATA_UNAVAILABLE_EXPLANATION_RE.test(cleanedReply)) {
    return true;
  }
  if (
    cleanedReply &&
    cleanedReply.length >= 12 &&
    cleanedReply.toUpperCase() !== "UNMATCHED" &&
    cleanedReply.toUpperCase() !== "OUT_OF_SCOPE" &&
    cleanedReply.toUpperCase() !== "ROLE_RESTRICTED"
  ) {
    return true;
  }
  return false;
}

