// ============================================================================
// Shared, PUBLIC-safe role knowledge for the no-auth MCP tools.
//
// Two tools read this file:
//   • check_eligibility     — "can I join / do I qualify?"
//   • get_onboarding_steps  — "what exactly do I do, step by step?"
//
// Everything here is general programme information, never a personal decision:
// eligibility is only ever confirmed in the app after verification. Amounts are
// strictly UGX. Terminology follows the compliance rules (Rent Plan, Supporter,
// Returns — never loan/lender/interest).
// ============================================================================

import type { SignupRole } from "./links";

export const ROLE_KEYS = ["tenant", "agent", "landlord", "supporter"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

/** Guard rails mirrored from the estimate tools, so the two agree. */
export const MIN_MONTHLY_RENT = 10_000;
export const MAX_MONTHLY_RENT = 5_000_000;
export const MIN_SUPPORT_AMOUNT = 20_000;

/** Minimum age to hold a Ugandan national ID and therefore a Welile account. */
export const MIN_AGE = 18;

/**
 * One eligibility requirement. `check` is optional: when the caller declares
 * the relevant fact we can mark the requirement met/unmet, otherwise it stays
 * "unknown" and is reported as something to confirm — never as a failure.
 */
export type Requirement = {
  key: string;
  label: string;
  detail: string;
  /** Verified by Welile staff/agents rather than self-declared. */
  verified_in_app: boolean;
  check?: (d: Declared) => boolean | undefined;
};

/** Facts a prospective user may volunteer. All optional. */
export type Declared = {
  age?: number;
  has_national_id?: boolean;
  has_phone?: boolean;
  has_mobile_money?: boolean;
  district?: string;
  monthly_rent?: number;
  support_amount?: number;
  houses_to_list?: number;
};

export type OnboardingStep = {
  step: number;
  title: string;
  what_you_do: string;
  what_to_bring: string[];
  typical_duration: string;
};

export type RoleGuide = {
  role: RoleKey;
  signup_role: SignupRole;
  headline: string;
  who_it_is_for: string;
  requirements: Requirement[];
  steps: OnboardingStep[];
  /** Extra caveats specific to this role. */
  disclaimers: string[];
};

/* ------------------------------------------------------------------ *
 * Requirements shared by every role.
 * ------------------------------------------------------------------ */

const AGE_REQUIREMENT: Requirement = {
  key: "age_18_plus",
  label: `At least ${MIN_AGE} years old`,
  detail: `You must be ${MIN_AGE} or older to hold a Welile account, because a national ID is required.`,
  verified_in_app: true,
  check: (d) => (d.age == null ? undefined : d.age >= MIN_AGE),
};

const NATIONAL_ID_REQUIREMENT: Requirement = {
  key: "national_id",
  label: "A Ugandan national ID",
  detail:
    "Your national ID number is captured once and must be unique on Welile — it is the basis of your verified identity and your Welile Trust Score.",
  verified_in_app: true,
  check: (d) => d.has_national_id,
};

const PHONE_REQUIREMENT: Requirement = {
  key: "phone_number",
  label: "A working phone number",
  detail:
    "Welile confirms your phone number by SMS and uses it for payment receipts and one-time codes, so it must be a line you control.",
  verified_in_app: true,
  check: (d) => d.has_phone,
};

const MOBILE_MONEY_REQUIREMENT: Requirement = {
  key: "mobile_money",
  label: "A mobile money account in your own names",
  detail:
    "Payments and payouts move by mobile money (MTN or Airtel), so the registered names on the line must match your Welile profile.",
  verified_in_app: false,
  check: (d) => d.has_mobile_money,
};

const BASE_REQUIREMENTS: Requirement[] = [
  AGE_REQUIREMENT,
  NATIONAL_ID_REQUIREMENT,
  PHONE_REQUIREMENT,
  MOBILE_MONEY_REQUIREMENT,
];

/* ------------------------------------------------------------------ *
 * Role guides.
 * ------------------------------------------------------------------ */

export const ROLE_GUIDES: Record<RoleKey, RoleGuide> = {
  tenant: {
    role: "tenant",
    signup_role: "tenant",
    headline: "Access rent with a flexible Rent Plan",
    who_it_is_for:
      "Someone renting a home in Uganda who can repay in small, regular UGX amounts but cannot raise the full rent on the due date.",
    requirements: [
      ...BASE_REQUIREMENTS,
      {
        key: "residence_verified",
        label: "A home an agent can verify",
        detail:
          "A Welile agent confirms where you live (and your landlord) on the ground. Rent Plans are only issued for a verified residence.",
        verified_in_app: true,
      },
      {
        key: "rent_in_range",
        label: `Monthly rent between UGX ${MIN_MONTHLY_RENT.toLocaleString("en-US")} and UGX ${MAX_MONTHLY_RENT.toLocaleString("en-US")}`,
        detail:
          "Rent Plans are sized to normal residential rent. Ask for a rent-access estimate to see an indicative daily amount for your rent.",
        verified_in_app: false,
        check: (d) =>
          d.monthly_rent == null
            ? undefined
            : d.monthly_rent >= MIN_MONTHLY_RENT && d.monthly_rent <= MAX_MONTHLY_RENT,
      },
      {
        key: "income_for_daily_repayment",
        label: "Regular income for the daily repayment",
        detail:
          "You repay a small amount over the plan length, so you need income that arrives regularly — daily, weekly, or monthly.",
        verified_in_app: true,
      },
    ],
    steps: [
      {
        step: 1,
        title: "Create a free tenant account",
        what_you_do:
          "Sign up with your phone number and your real names as they appear on your national ID and mobile money line.",
        what_to_bring: ["Phone number you control", "Your full legal names"],
        typical_duration: "About 3 minutes",
      },
      {
        step: 2,
        title: "Confirm your phone by SMS",
        what_you_do: "Enter the one-time code sent to your phone so receipts and codes can reach you.",
        what_to_bring: ["Your phone, in hand"],
        typical_duration: "Under a minute",
      },
      {
        step: 3,
        title: "Complete identity verification",
        what_you_do:
          "Add your national ID number and a photo of the ID. This starts your Welile Trust Score.",
        what_to_bring: ["Ugandan national ID"],
        typical_duration: "About 5 minutes",
      },
      {
        step: 4,
        title: "Meet an agent and verify your home",
        what_you_do:
          "A Welile agent visits your home, records the location, and links your landlord and house on the platform.",
        what_to_bring: ["Your landlord's name and phone number", "Your rental agreement, if you have one"],
        typical_duration: "One agent visit, usually within a few days",
      },
      {
        step: 5,
        title: "Request your Rent Plan",
        what_you_do:
          "Your agent posts a rent request for your house. Welile reviews it and, once approved, pays your landlord directly.",
        what_to_bring: ["Your agreed monthly rent amount"],
        typical_duration: "Reviewed after the visit; timing varies",
      },
      {
        step: 6,
        title: "Repay in small amounts and build your score",
        what_you_do:
          "Pay your daily or agreed instalment by mobile money or to your agent. Every on-time payment raises your Welile Trust Score and your future access.",
        what_to_bring: ["Mobile money, or cash for your agent"],
        typical_duration: "Over the length of your plan",
      },
    ],
    disclaimers: [
      "Meeting these requirements is not an approval — your Rent Plan is confirmed in the app after verification.",
    ],
  },

  agent: {
    role: "agent",
    signup_role: "agent",
    headline: "Earn commission as a Welile field agent",
    who_it_is_for:
      "Someone who knows their community well, can move around it daily, and wants to earn UGX commission by registering tenants, listing houses, and collecting rent.",
    requirements: [
      ...BASE_REQUIREMENTS,
      {
        key: "smartphone",
        label: "A smartphone with internet",
        detail:
          "All agent work — registrations, house photos, GPS-stamped visits, and collections — is recorded in the Welile app in the field.",
        verified_in_app: false,
      },
      {
        key: "local_area",
        label: "An area you can work daily",
        detail:
          "You are assigned around where you live. Agents visit tenants and landlords in person, so you need to be present in that area.",
        verified_in_app: true,
        check: (d) => (d.district == null ? undefined : d.district.trim().length > 1),
      },
      {
        key: "field_verification",
        label: "Willingness to be verified and supervised",
        detail:
          "Agent work is accountable: visits are location-stamped, and your performance and collections are reviewed by Agent Operations.",
        verified_in_app: true,
      },
    ],
    steps: [
      {
        step: 1,
        title: "Create a free agent account",
        what_you_do:
          "Sign up as an agent with your real names (at least two) and the phone number you will work with.",
        what_to_bring: ["Phone number you control", "Your full legal names"],
        typical_duration: "About 3 minutes",
      },
      {
        step: 2,
        title: "Verify your identity",
        what_you_do: "Add your national ID and confirm your phone by SMS.",
        what_to_bring: ["Ugandan national ID"],
        typical_duration: "About 5 minutes",
      },
      {
        step: 3,
        title: "Get onboarded by Agent Operations",
        what_you_do:
          "Complete agent orientation and have your working area confirmed. You are told exactly what each task pays before you start.",
        what_to_bring: ["Smartphone with internet"],
        typical_duration: "Usually within a few days of signing up",
      },
      {
        step: 4,
        title: "List houses and register landlords",
        what_you_do:
          "Photograph and list available houses, register the landlord, and have them verified. Verified listings and landlords each earn a bonus in UGX.",
        what_to_bring: ["Smartphone for photos and GPS", "Landlord's names and phone number"],
        typical_duration: "Ongoing field work",
      },
      {
        step: 5,
        title: "Place tenants and post rent requests",
        what_you_do:
          "Register verified tenants, place them in houses, and post rent requests for review. You earn a placement bonus when a tenant moves in.",
        what_to_bring: ["Tenant's national ID details"],
        typical_duration: "Ongoing field work",
      },
      {
        step: 6,
        title: "Collect rent and withdraw your commission",
        what_you_do:
          "Collect daily repayments from your tenants and record each one in the app. Commission lands in your agent wallet, and you withdraw it to mobile money.",
        what_to_bring: ["Mobile money line in your own names"],
        typical_duration: "Commission is credited as you collect",
      },
    ],
    disclaimers: [
      "Agent earnings depend entirely on the work you do — nothing is a salary or a guaranteed amount.",
      "Your exact commission rates, bonuses, and wallet balance are shown in the app once you sign in.",
    ],
  },

  landlord: {
    role: "landlord",
    signup_role: "landlord",
    headline: "Guaranteed, on-time rent for your houses",
    who_it_is_for:
      "Someone who owns or manages rental houses in Uganda and would rather receive rent on time than chase tenants each month.",
    requirements: [
      ...BASE_REQUIREMENTS,
      {
        key: "property_to_list",
        label: "At least one rental house you control",
        detail:
          "You must own the house or be the recognised manager of it. An agent verifies the house and your ownership on the ground.",
        verified_in_app: true,
        check: (d) => (d.houses_to_list == null ? undefined : d.houses_to_list >= 1),
      },
      {
        key: "local_confirmation",
        label: "Local confirmation of the property",
        detail:
          "Welile confirms the house through its agent network, and in many areas through the LC1 chairperson of the area.",
        verified_in_app: true,
      },
      {
        key: "accept_platform_collection",
        label: "Willingness to let Welile handle collection",
        detail:
          "Welile collects from the tenant on your behalf and pays you, so rent arrives on schedule instead of in pieces.",
        verified_in_app: false,
      },
    ],
    steps: [
      {
        step: 1,
        title: "Create a free landlord account",
        what_you_do: "Sign up as a landlord with your real names and your phone number.",
        what_to_bring: ["Phone number you control", "Your full legal names"],
        typical_duration: "About 3 minutes",
      },
      {
        step: 2,
        title: "Verify your identity",
        what_you_do: "Add your national ID and confirm your phone by SMS.",
        what_to_bring: ["Ugandan national ID"],
        typical_duration: "About 5 minutes",
      },
      {
        step: 3,
        title: "List your house or houses",
        what_you_do:
          "Add each house with its district, area, monthly rent in UGX, and photos. An agent can do this with you.",
        what_to_bring: ["Photos of the house", "The monthly rent you charge", "District and area"],
        typical_duration: "About 10 minutes per house",
      },
      {
        step: 4,
        title: "Have the house verified",
        what_you_do:
          "A Welile agent visits and verifies the house and your ownership. Only verified houses can be matched to tenants.",
        what_to_bring: ["Proof of ownership or management, if asked"],
        typical_duration: "One agent visit, usually within a few days",
      },
      {
        step: 5,
        title: "Receive tenants and on-time rent",
        what_you_do:
          "Welile matches verified tenants to your house, pays the rent for the plan, and collects from the tenant afterwards. You are paid to your mobile money.",
        what_to_bring: ["Mobile money line in your own names"],
        typical_duration: "Rent arrives on the agreed schedule",
      },
    ],
    disclaimers: [
      "Payment terms for each house are agreed in the app after the house is verified.",
    ],
  },

  supporter: {
    role: "supporter",
    signup_role: "supporter",
    headline: "Support tenants and earn Returns",
    who_it_is_for:
      "Someone with funds they can commit for a period, who wants those funds to help Ugandan tenants access rent and to earn periodic Returns in UGX.",
    requirements: [
      ...BASE_REQUIREMENTS,
      {
        key: "minimum_support",
        label: `At least UGX ${MIN_SUPPORT_AMOUNT.toLocaleString("en-US")} to commit`,
        detail: `Support is taken in units from UGX ${MIN_SUPPORT_AMOUNT.toLocaleString("en-US")}. You can add more later through a top-up.`,
        verified_in_app: false,
        check: (d) => (d.support_amount == null ? undefined : d.support_amount >= MIN_SUPPORT_AMOUNT),
      },
      {
        key: "funds_you_can_commit",
        label: "Funds you can leave in place",
        detail:
          "Your support funds real Rent Plans, so it is committed for a period. Withdrawing requires giving notice — it is not an instant-access savings account.",
        verified_in_app: false,
      },
      {
        key: "understand_notice",
        label: "Comfort with the notice period",
        detail:
          "Exiting requires a notice period, during which Returns stop accruing. The exact notice and terms are shown in the app before you commit.",
        verified_in_app: false,
      },
    ],
    steps: [
      {
        step: 1,
        title: "Create a free Supporter account",
        what_you_do: "Sign up as a Supporter with your real names and your phone number.",
        what_to_bring: ["Phone number you control", "Your full legal names"],
        typical_duration: "About 3 minutes",
      },
      {
        step: 2,
        title: "Verify your identity",
        what_you_do:
          "Add your national ID and confirm your phone by SMS. Verification is required before funds are accepted.",
        what_to_bring: ["Ugandan national ID"],
        typical_duration: "About 5 minutes",
      },
      {
        step: 3,
        title: "Review the current terms",
        what_you_do:
          "Read the Supporter terms in the app: the current reward rate, the cycle on which Returns are paid, and the notice period for exiting.",
        what_to_bring: [],
        typical_duration: "About 10 minutes",
      },
      {
        step: 4,
        title: "Deposit your support",
        what_you_do:
          "Send your support amount by mobile money and submit the transaction ID, or hand cash to a verified agent and keep the receipt. Finance confirms every deposit.",
        what_to_bring: [
          `Mobile money with at least UGX ${MIN_SUPPORT_AMOUNT.toLocaleString("en-US")}`,
          "The transaction ID of your payment",
        ],
        typical_duration: "Confirmed after finance verification",
      },
      {
        step: 5,
        title: "Track your portfolio and Returns",
        what_you_do:
          "Watch your portfolio in the app: Returns accrue on the stated cycle, and you choose to take them out or reinvest them.",
        what_to_bring: [],
        typical_duration: "Returns accrue on the stated cycle",
      },
    ],
    disclaimers: [
      "Returns are not a guarantee — rates and terms are shown in the app and can change.",
      "Terminology: Supporter, not lender; Returns, not interest.",
    ],
  },
};

/** Resolve free text like "I want to be an agent" to a role key. */
export function matchRole(input?: string): RoleKey | null {
  const term = (input ?? "").trim().toLowerCase();
  if (!term) return null;
  const exact = ROLE_KEYS.find((r) => r === term);
  if (exact) return exact;

  const aliases: Record<RoleKey, string[]> = {
    tenant: ["tenant", "renter", "rent", "rent plan", "pay rent", "occupant"],
    agent: ["agent", "field", "commission", "work", "job", "collector", "sales"],
    landlord: ["landlord", "landlady", "owner", "house owner", "property", "rentals"],
    supporter: ["supporter", "support", "invest", "investor", "funder", "returns", "lender"],
  };
  for (const role of ROLE_KEYS) {
    if (aliases[role].some((a) => term.includes(a))) return role;
  }
  return null;
}
