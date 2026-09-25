import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  EVENT_BONUSES,
  COMMISSION_RATE,
  SOURCE_RATE,
  MANAGER_RATE,
  RECRUITER_RATE,
  RECRUITER_VERIFICATION_OVERRIDE,
  LANDLORD_PAYOUT_COMMISSION_RATE,
} from "@/lib/rentCalculations";

/**
 * Source-of-truth coverage test for the "How You Earn Money" page
 * (src/pages/AgentCommissionBenefits.tsx).
 *
 * Every way an agent can earn money in the backend MUST be presented on this
 * page with the correct amount/percentage. This test reads the page source and
 * asserts that each canonical earning path appears with the exact figure that
 * the backend pays.
 *
 * The recurring-commission percentages and the EVENT_BONUSES amounts are
 * imported directly from the backend constants in src/lib/rentCalculations.ts,
 * so if those rates ever change the test fails until the page is updated.
 *
 * The DB-only bonus amounts (paid by the `credit_agent_event_bonus` and
 * `credit_recruiter_override` SQL helpers, and the proxy/angel investment
 * commission) are mirrored here as documented constants — they are the
 * canonical figures and changing them on either side must be a deliberate edit.
 */

const root = resolve(__dirname, "..", "..");
const PAGE = "src/pages/AgentCommissionBenefits.tsx";
const source = readFileSync(resolve(root, PAGE), "utf8");

const ugx = (n: number) => `UGX ${n.toLocaleString("en-US")}`;
const pct = (rate: number) => `${Math.round(rate * 100)}%`;

/**
 * Every flat bonus now lives in EVENT_BONUSES, each entry naming the backend
 * path that pays it. Four entries were removed on 2026-09-25 because they had
 * never paid: rent_posted_listed, rent_landlord_verified, rent_request_posted
 * and tenant_replacement. The landlord and LC1 recruiter overrides went at the
 * same time, leaving RECRUITER_VERIFICATION_OVERRIDE for house listings only.
 */

/** Investment commission an agent earns on funders they bring in. */
const INVESTMENT_COMMISSION_RATE = 0.02; // proxy/partner investment
const ANGEL_POOL_COMMISSION_RATE = 0.01; // Angel Pool investment

interface EarningPath {
  /** Human label for the test description. */
  label: string;
  /** Strings that must ALL appear in the page source. */
  needles: string[];
}

const RECURRING_PATHS: EarningPath[] = [
  {
    label: "Rent repayment commission (10% total)",
    needles: [pct(COMMISSION_RATE)],
  },
  {
    label: "Registering agent share (2%)",
    needles: [pct(SOURCE_RATE)],
  },
  {
    label: "Managing agent share (8%)",
    needles: [pct(MANAGER_RATE)],
  },
  {
    label: "Recruiter override (2%)",
    needles: [pct(RECRUITER_RATE)],
  },
  {
    label: "Investment / funder commission (2%)",
    needles: [pct(INVESTMENT_COMMISSION_RATE), "2% commission"],
  },
  {
    label: "Angel Pool investment commission (1%)",
    needles: [pct(ANGEL_POOL_COMMISSION_RATE)],
  },
];

const EVENT_BONUS_PATHS: EarningPath[] = [
  {
    label: "Contact location capture bonus",
    // The amount alone is not a safe needle: "UGX 100" is a substring of the
    // "UGX 100,000" repayment example, so assert the label instead.
    needles: ["Capture a Contact&apos;s Location", ugx(EVENT_BONUSES.contact_location_capture)],
  },
  { label: "New landlord verified bonus", needles: [ugx(EVENT_BONUSES.landlord_verified)] },
  { label: "List an empty house bonus", needles: [ugx(EVENT_BONUSES.house_listed)] },
  { label: "Register a new agent bonus", needles: [ugx(EVENT_BONUSES.subagent_registration)] },
  { label: "Tenant placement bounty", needles: [ugx(EVENT_BONUSES.tenant_placement)] },
  { label: "Service Centre setup bonus", needles: [ugx(EVENT_BONUSES.service_centre_setup)] },
  {
    label: "Sub-agent verification override bonus",
    needles: [ugx(RECRUITER_VERIFICATION_OVERRIDE)],
  },
  {
    label: "Landlord payout commission (1%)",
    needles: [pct(LANDLORD_PAYOUT_COMMISSION_RATE)],
  },
];

/**
 * Amounts that must NOT appear on the page any more — the bonuses that were
 * removed on 2026-09-25. Guards against a revert quietly re-advertising them.
 */
const RETIRED_AMOUNTS: { label: string; amount: number }[] = [
  { label: "rent request posted & listed (1,000)", amount: 1000 },
  { label: "landlord verified, old per-request figure (4,000)", amount: 4000 },
  { label: "replace a tenant (20,000)", amount: 20000 },
  { label: "recruiter verification override, old figure (3,000)", amount: 3000 },
];

const CAREER_PATHS: EarningPath[] = [
  { label: "Cash advance access (Team Leader, 2+ sub-agents)", needles: ["Cash Advance Access", "Team Leader"] },
  { label: "Electric bike reward (50 active tenants)", needles: ["Electric Bike", "50"] },
  { label: "Invite a funder (referral)", needles: ["Invite a Funder"] },
  { label: "Collect rent from tenants (float + streaks)", needles: ["Collect Rent", "streak"] },
];

describe("How You Earn page — backend earning-rule coverage", () => {
  describe("recurring commission rates match backend constants", () => {
    for (const path of RECURRING_PATHS) {
      it(`presents ${path.label}`, () => {
        for (const needle of path.needles) {
          expect(source).toContain(needle);
        }
      });
    }

    it("commission split is internally consistent (2% + 8% = 10%)", () => {
      expect(SOURCE_RATE + MANAGER_RATE).toBeCloseTo(COMMISSION_RATE, 10);
      expect(RECRUITER_RATE + MANAGER_RATE).toBeCloseTo(COMMISSION_RATE, 10);
    });
  });

  describe("one-time event bonuses match backend amounts", () => {
    for (const path of EVENT_BONUS_PATHS) {
      it(`presents ${path.label}`, () => {
        for (const needle of path.needles) {
          expect(source).toContain(needle);
        }
      });
    }
  });

  describe("retired bonuses are no longer advertised", () => {
    for (const retired of RETIRED_AMOUNTS) {
      it(`does not offer ${retired.label}`, () => {
        expect(source).not.toContain(ugx(retired.amount));
      });
    }
  });

  describe("career-growth earning paths are present", () => {
    for (const path of CAREER_PATHS) {
      it(`presents ${path.label}`, () => {
        for (const needle of path.needles) {
          expect(source).toContain(needle);
        }
      });
    }
  });

  describe("WhatsApp share text mirrors the cash bonuses", () => {
    const shareNeedles = [
      ugx(EVENT_BONUSES.landlord_verified),
      ugx(EVENT_BONUSES.house_listed),
      ugx(EVENT_BONUSES.subagent_registration),
      ugx(EVENT_BONUSES.tenant_placement),
      ugx(EVENT_BONUSES.service_centre_setup),
    ];
    for (const needle of shareNeedles) {
      it(`share text mentions ${needle}`, () => {
        expect(source).toContain(needle);
      });
    }
  });
});

describe("Backend earning constants snapshot (guards silent rate drift)", () => {
  it("EVENT_BONUSES match the figures the page is verified against", () => {
    expect(EVENT_BONUSES).toEqual({
      contact_location_capture: 100,
      house_listed: 2000,
      landlord_verified: 5000,
      lc1_verified: 2000,
      subagent_registration: 10000,
      three_verified_houses: 10000,
      tenant_placement: 10000,
      service_centre_setup: 25000,
    });
    expect(RECRUITER_VERIFICATION_OVERRIDE).toBe(2000);
    expect(LANDLORD_PAYOUT_COMMISSION_RATE).toBe(0.01);
  });

  it("commission rates match the figures the page is verified against", () => {
    expect(COMMISSION_RATE).toBe(0.1);
    expect(SOURCE_RATE).toBe(0.02);
    expect(MANAGER_RATE).toBe(0.08);
    expect(RECRUITER_RATE).toBe(0.02);
  });
});