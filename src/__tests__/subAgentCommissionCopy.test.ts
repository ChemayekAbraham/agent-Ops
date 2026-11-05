import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Guards the canonical sub-agent commission split across every agent-facing surface
 * (since the 2026-11-04 change from 10% to 8%):
 *   - Sub-agent (manager) keeps 6%
 *   - Recruiter (upline) earns a 2% override
 *   - Total system payout is 8%
 *   - Whitelisted / elite sub-agents keep the full 8%
 *
 * These are source-level assertions: they read the actual component/page source
 * and verify the displayed copy uses the canonical figures, and that the old
 * 10% total / 8% sub-agent figures and the older 1% override / 4% sub-agent /
 * 5% total figures never reappear.
 */

const root = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

/** Files that present the recruiter/sub-agent split to agents. */
const SURFACES: Record<string, { mustInclude: string[]; mustNotInclude: string[] }> = {
  "src/pages/SubAgentAnalytics.tsx": {
    mustInclude: [
      "Your 2% Earnings (UGX)",
      "Your 2% Share (UGX)",
      "earn 2% of all their tenants",
      "your 2%",
      "2% of all collections facilitated",
    ],
    mustNotInclude: ["Your 1%", "earn 1%", "1% from Sub-Agents", "your 1%", "1% of all collections"],
  },
  "src/components/agent/RecruitSubAgentCTA.tsx": {
    mustInclude: ["2%</span> from all their collections", "2% their earnings"],
    mustNotInclude: ["1%</span> from all their collections", "1% their earnings"],
  },
  "src/components/agent/SubAgentsPanel.tsx": {
    mustInclude: ["You earn 2% on every collection"],
    mustNotInclude: ["You earn 1% on every collection"],
  },
  "src/components/agent/ShareSubAgentLink.tsx": {
    mustInclude: ["Earning 6% commission on repayments", "you earn 2% of their earnings"],
    mustNotInclude: ["Earning 8% commission", "Earning 4% commission", "you earn 1% of their earnings"],
  },
  "src/components/agent/QuickShareSubAgentSheet.tsx": {
    mustInclude: ["6% commission on every rent collection", "2% of all their collections forever"],
    mustNotInclude: ["8% commission on every rent collection", "4% commission on every rent collection", "1% of all their collections"],
  },
  "src/components/agent/SubAgentsList.tsx": {
    // Reworded 2026-09-24 (050139d006): the list shows "Rent 2% UGX …" per sub-agent.
    mustInclude: ["Rent 2%", "the 2% override"],
    mustNotInclude: ["your 1%", "Rent 1%"],
  },
  "src/components/agent/AgentMenuDrawer.tsx": {
    mustInclude: [">2%</span> of their collections"],
    mustNotInclude: [">1%</span> of their collections"],
  },
  "src/components/agent/EarningsRankSystemSheet.tsx": {
    mustInclude: [">6%</Badge>", ">2%</Badge>", ">8% (Fixed)</Badge>"],
    mustNotInclude: [">10% (Fixed)</Badge>", ">4%</Badge>", ">1%</Badge>", ">5% (Fixed)</Badge>"],
  },
  "src/components/agent/agreement/AgentAgreementContent.ts": {
    mustInclude: [
      "Direct Agent Commission (8%)",
      "Sub-Agent Commission (6%)",
      "you earn 6% commission on every rent repayment",
      "remaining 2% goes to your recruiting",
      "Sub-Agents keep the full 8%",
      "Super Agent Override Commission (2%)",
      "you earn 2% override commission",
      "Earn 2% on every tenant your sub-agents bring",
    ],
    mustNotInclude: [
      "Direct Agent Commission (5%)",
      "Sub-Agent Commission (8%)",
      "(recruited by another agent), you earn 8% commission",
      "Sub-Agent Commission (4%)",
      "you earn 4% commission on every rent repayment",
      "remaining 1% goes",
      "Super Agent Override Commission (1%)",
      "you earn 1% override commission",
    ],
  },
  "src/components/wallet/WalletBreakdown.tsx": {
    mustInclude: ["You earned 2% ="],
    mustNotInclude: ["You earned 1% ="],
  },
  "src/components/wallet/WalletStatement.tsx": {
    mustInclude: ["You earned 2% because a sub-agent"],
    mustNotInclude: ["You earned 1% because a sub-agent"],
  },
  "src/pages/Terms.tsx": {
    mustInclude: ["Sub-agent overrides (2%)"],
    mustNotInclude: ["Sub-agent overrides (1%)"],
  },
  "src/pages/AgentCommissionBenefits.tsx": {
    mustInclude: [
      "The agent COLLECTING the rent gets *8%*",
      "If you are a sub-agent, you get *6%*",
      "the agent who recruited you gets *2%*",
      "keep the full *8%*",
    ],
    mustNotInclude: [
      "you keep the full *10%*",
      "MANAGING the tenant gets *8%*",
      "REGISTERED the tenant gets *1%*",
      "MANAGING the tenant gets *4%*",
    ],
  },
};

describe("Sub-agent commission split copy (2% override / 6% share / 8% total)", () => {
  for (const [file, { mustInclude, mustNotInclude }] of Object.entries(SURFACES)) {
    describe(file, () => {
      const source = read(file);

      for (const needle of mustInclude) {
        it(`shows canonical copy: "${needle}"`, () => {
          expect(source).toContain(needle);
        });
      }

      for (const forbidden of mustNotInclude) {
        it(`does not show stale copy: "${forbidden}"`, () => {
          expect(source).not.toContain(forbidden);
        });
      }
    });
  }
});

describe("Split arithmetic invariant", () => {
  it("recruiter override + sub-agent share equals total payout", () => {
    const RECRUITER_OVERRIDE = 2;
    const SUB_AGENT_SHARE = 6;
    const TOTAL_PAYOUT = 8;
    expect(RECRUITER_OVERRIDE + SUB_AGENT_SHARE).toBe(TOTAL_PAYOUT);
  });
});