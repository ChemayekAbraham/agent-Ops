import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { buildSignupLinks } from "../links";
import { enforceRateLimit } from "../rateLimit";
import { publicToolResult, pointRange, spanRange, ugx, type EstimateRange } from "../response";
import {
  MAX_MONTHLY_RENT,
  MIN_MONTHLY_RENT,
  MIN_SUPPORT_AMOUNT,
  ROLE_GUIDES,
  ROLE_KEYS,
  matchRole,
  type Declared,
  type RoleKey,
  type Requirement,
} from "../roles";

// PUBLIC, no-auth tool. Answers "can I join / do I qualify?" for each Welile
// role by returning the general requirement checklist, and — when the caller
// volunteers facts about themselves — marking each requirement met, not met, or
// still to confirm. It NEVER issues an approval: real eligibility is decided in
// the app after verification. Amounts are UGX only.

type Status = "met" | "not_met" | "to_confirm";

function evaluate(req: Requirement, declared: Declared): Status {
  const verdict = req.check?.(declared);
  if (verdict === true) return "met";
  if (verdict === false) return "not_met";
  return "to_confirm";
}

const STATUS_MARK: Record<Status, string> = {
  met: "✓",
  not_met: "✗",
  to_confirm: "•",
};

function rangesFor(role: RoleKey, declared: Declared): EstimateRange[] {
  const ranges: EstimateRange[] = [];
  if (role === "tenant") {
    ranges.push(
      spanRange("Monthly rent Welile plans cover", "eligible_monthly_rent", MIN_MONTHLY_RENT, MAX_MONTHLY_RENT, "UGX_per_month", {
        unit: "months",
        value: 1,
      }),
    );
    if (declared.monthly_rent != null) {
      ranges.push(
        pointRange("Monthly rent you gave", "declared_monthly_rent", declared.monthly_rent, "UGX_per_month", {
          unit: "months",
          value: 1,
        }),
      );
    }
  }
  if (role === "supporter") {
    ranges.push(pointRange("Minimum support amount", "minimum_support_amount", MIN_SUPPORT_AMOUNT));
    if (declared.support_amount != null) {
      ranges.push(pointRange("Amount you gave", "declared_support_amount", declared.support_amount));
    }
  }
  return ranges;
}

export default defineTool({
  name: "check_eligibility",
  title: "Check eligibility for a Welile role",
  description:
    "Answer a prospective user's eligibility question — 'can I be a Welile agent?', 'do I qualify for a Rent Plan?', 'can I become a Supporter?', 'can I list my house?' — by returning the requirement checklist for that role plus the free role-targeted signup link. No sign-in required. Optionally pass what the user has told you (age, has_national_id, has_phone, has_mobile_money, district, monthly_rent in UGX, support_amount in UGX, houses_to_list) and each requirement comes back marked met / not_met / to_confirm. This is a general checklist, NEVER an approval: real eligibility is confirmed in the app after verification. Omit `role` to get the requirements for all four roles. Amounts are UGX.",
  inputSchema: {
    role: z
      .string()
      .describe(
        "Role to check: tenant, agent, landlord, or supporter — or free text like 'I want to collect rent'. Omit to compare all four.",
      )
      .optional(),
    age: z.number().describe("The user's age in years, if they gave it.").optional(),
    has_national_id: z.boolean().describe("Whether they hold a Ugandan national ID.").optional(),
    has_phone: z.boolean().describe("Whether they have a phone number they control.").optional(),
    has_mobile_money: z
      .boolean()
      .describe("Whether they have a mobile money account registered in their own names.")
      .optional(),
    district: z.string().describe("District or area they live/work in, if given.").optional(),
    monthly_rent: z.number().describe("Tenant only: their monthly rent in UGX.").optional(),
    support_amount: z.number().describe("Supporter only: the amount in UGX they can commit.").optional(),
    houses_to_list: z.number().describe("Landlord only: how many rental houses they control.").optional(),
    referral_code: z
      .string()
      .describe("Optional referral code (the referrer's Welile user id) to build a referral signup link.")
      .optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (input) => {
    const limited = await enforceRateLimit("check_eligibility");
    if (limited) return limited;

    const { role, referral_code, ...rest } = input;
    const declared: Declared = {
      age: rest.age,
      has_national_id: rest.has_national_id,
      has_phone: rest.has_phone,
      has_mobile_money: rest.has_mobile_money,
      district: rest.district,
      monthly_rent: rest.monthly_rent,
      support_amount: rest.support_amount,
      houses_to_list: rest.houses_to_list,
    };
    const declaredGiven = Object.entries(declared)
      .filter(([, v]) => v != null && v !== "")
      .map(([k]) => k);

    const matched = matchRole(role);

    // ---------------------------------------------------------------- //
    // No role given → compare all four so the assistant can steer.
    // ---------------------------------------------------------------- //
    if (!matched) {
      const roles = ROLE_KEYS.map((key) => {
        const guide = ROLE_GUIDES[key];
        const { signupUrl, landingUrl } = buildSignupLinks({
          referralCode: referral_code,
          role: guide.signup_role,
        });
        return {
          role: key,
          headline: guide.headline,
          who_it_is_for: guide.who_it_is_for,
          requirement_count: guide.requirements.length,
          key_requirements: guide.requirements.slice(0, 4).map((r) => r.label),
          landing_url: landingUrl,
          signup_url: signupUrl,
        };
      });

      const { signupUrl, landingUrl } = buildSignupLinks({ referralCode: referral_code });
      return publicToolResult({
        tool: "check_eligibility",
        kind: "info",
        summary: `Welile has ${roles.length} roles you can join — everyone needs a Ugandan national ID, a phone number, and mobile money in their own names; the rest depends on the role.`,
        body: [
          roles
            .map((r) => `${r.role.toUpperCase()} — ${r.headline}\n    ${r.who_it_is_for}`)
            .join("\n\n"),
        ],
        assumptions: [
          "No role was given, so the shared requirements and all four roles are listed.",
          "All amounts on Welile are in Ugandan Shillings (UGX).",
        ],
        data: { matched_role: null, roles, declared_fields: declaredGiven },
        disclaimers: [
          "This is a general checklist, not an eligibility decision. Eligibility is confirmed in the app after verification.",
        ],
        next_steps: ROLE_KEYS.map((r) => `Ask: "Am I eligible to be a Welile ${r}?"`),
        links: { landing_url: landingUrl, signup_url: signupUrl },
      });
    }

    // ---------------------------------------------------------------- //
    // A specific role → checklist, marked against whatever was declared.
    // ---------------------------------------------------------------- //
    const guide = ROLE_GUIDES[matched];
    const checklist = guide.requirements.map((req) => {
      const status = evaluate(req, declared);
      return {
        key: req.key,
        label: req.label,
        detail: req.detail,
        status,
        verified_in_app: req.verified_in_app,
      };
    });

    const met = checklist.filter((c) => c.status === "met");
    const notMet = checklist.filter((c) => c.status === "not_met");
    const toConfirm = checklist.filter((c) => c.status === "to_confirm");

    const verdict = notMet.length
      ? "blocked_for_now"
      : declaredGiven.length
        ? "nothing_blocking_so_far"
        : "requirements_listed";

    const summary = notMet.length
      ? `Based on what you've told me, ${notMet.length} requirement${notMet.length === 1 ? "" : "s"} for the Welile ${matched} role ${notMet.length === 1 ? "is" : "are"} not met yet — the rest can still be confirmed when you sign up.`
      : declaredGiven.length
        ? `Nothing in what you've told me blocks you from the Welile ${matched} role — ${met.length} of ${checklist.length} requirement${checklist.length === 1 ? "" : "s"} already look met, and the rest are confirmed in the app.`
        : `To join Welile as a ${matched} you need ${checklist.length} things — all confirmed in the app after you sign up free.`;

    const body = [
      `${guide.headline}\n${guide.who_it_is_for}`,
      checklist
        .map(
          (c) =>
            `${STATUS_MARK[c.status]} ${c.label}${c.status === "not_met" ? " — not met yet" : c.status === "to_confirm" ? " — to confirm" : ""}\n    ${c.detail}`,
        )
        .join("\n"),
    ];
    if (matched === "tenant" && declared.monthly_rent != null) {
      body.push(
        `You gave a monthly rent of ${ugx(declared.monthly_rent)}. Ask for a rent-access estimate to see an indicative daily amount for it.`,
      );
    }
    if (matched === "supporter" && declared.support_amount != null) {
      body.push(
        `You gave a support amount of ${ugx(declared.support_amount)} (minimum ${ugx(MIN_SUPPORT_AMOUNT)}). Ask for a Supporter Returns illustration to see how that could grow.`,
      );
    }

    const ranges = rangesFor(matched, declared);
    const { signupUrl, referralUrl, landingUrl } = buildSignupLinks({
      referralCode: referral_code,
      role: guide.signup_role,
    });

    return publicToolResult({
      tool: "check_eligibility",
      kind: "info",
      summary,
      body,
      assumptions: [
        declaredGiven.length
          ? `Marked against what you told me: ${declaredGiven.join(", ")}. Everything else is left to confirm.`
          : "Nothing was declared about the user, so every requirement is listed as something to confirm.",
        "Self-declared facts are taken at face value here — Welile verifies them in the app.",
        "All amounts on Welile are in Ugandan Shillings (UGX).",
      ],
      estimates: ranges.length
        ? {
            basis: "Programme thresholds published for this role, plus any amount the user gave.",
            confidence: "indicative",
            currency: "UGX",
            ranges,
          }
        : null,
      data: {
        matched_role: matched,
        verdict,
        headline: guide.headline,
        who_it_is_for: guide.who_it_is_for,
        requirements: checklist,
        counts: { met: met.length, not_met: notMet.length, to_confirm: toConfirm.length },
        declared_fields: declaredGiven,
        onboarding_step_count: guide.steps.length,
      },
      disclaimers: [
        "This is a general checklist, not an eligibility decision or an approval. Eligibility is confirmed in the app after verification.",
        ...guide.disclaimers,
      ],
      next_steps: [
        notMet.length
          ? `Sort out: ${notMet.map((c) => c.label.toLowerCase()).join("; ")} — then sign up free as a ${matched}.`
          : `Create a free ${matched} account to be verified and confirmed.`,
        `Ask: "What are the steps to become a Welile ${matched}?" for the full step-by-step onboarding.`,
      ],
      links: {
        landing_url: landingUrl,
        signup_url: signupUrl,
        referral_url: referralUrl,
        role: guide.signup_role,
      },
    });
  },
});
