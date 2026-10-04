import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { buildSignupLinks } from "../links";
import { enforceRateLimit } from "../rateLimit";
import { publicToolResult, pointRange } from "../response";
import { ROLE_GUIDES, ROLE_KEYS, matchRole } from "../roles";

// PUBLIC, no-auth tool. Walks a prospective user through exactly what happens,
// step by step, from signing up to being active as a tenant, agent, landlord, or
// Supporter — what they do at each step, what to bring, and how long it takes.
// Pass `step` to zoom into one step. Nothing here is an approval; timings are
// typical, not promised.

export default defineTool({
  name: "get_onboarding_steps",
  title: "Step-by-step Welile onboarding",
  description:
    "Return the step-by-step onboarding walkthrough for a Welile role — 'how do I become an agent?', 'what are the steps to get a Rent Plan?', 'how do I start supporting tenants?', 'how do I list my house?'. No sign-in required. Each step says what the user does, what to bring (national ID, photos, mobile money, transaction ID…), and how long it typically takes, plus the free role-targeted signup link. Pass `role` (tenant, agent, landlord, supporter — or free text) and optionally `step` (1-based) to zoom into one step. Omit `role` to list what each role's onboarding involves. Amounts are UGX; timings are typical, not guaranteed.",
  inputSchema: {
    role: z
      .string()
      .describe(
        "Role to onboard: tenant, agent, landlord, or supporter — or free text like 'I want to earn commission'. Omit to compare all four.",
      )
      .optional(),
    step: z
      .number()
      .describe("Optional 1-based step number to expand on a single step of that role's onboarding.")
      .optional(),
    referral_code: z
      .string()
      .describe("Optional referral code (the referrer's Welile user id) to build a referral signup link.")
      .optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ role, step, referral_code }) => {
    const limited = await enforceRateLimit("get_onboarding_steps");
    if (limited) return limited;

    const matched = matchRole(role);

    // ---------------------------------------------------------------- //
    // No role → show how long each path is so the assistant can ask.
    // ---------------------------------------------------------------- //
    if (!matched) {
      const paths = ROLE_KEYS.map((key) => {
        const guide = ROLE_GUIDES[key];
        const { signupUrl, landingUrl } = buildSignupLinks({
          referralCode: referral_code,
          role: guide.signup_role,
        });
        return {
          role: key,
          headline: guide.headline,
          step_count: guide.steps.length,
          steps: guide.steps.map((s) => s.title),
          landing_url: landingUrl,
          signup_url: signupUrl,
        };
      });

      const { signupUrl, landingUrl } = buildSignupLinks({ referralCode: referral_code });
      return publicToolResult({
        tool: "get_onboarding_steps",
        kind: "info",
        summary:
          "Every Welile role starts the same way — sign up free, confirm your phone, verify your national ID — then the path differs by role.",
        body: [
          paths
            .map((p) => `${p.role.toUpperCase()} (${p.step_count} steps) — ${p.headline}\n    ${p.steps.join(" → ")}`)
            .join("\n\n"),
        ],
        assumptions: [
          "No role was given, so the outline of all four onboarding paths is shown.",
          "Step timings are typical, not guaranteed.",
        ],
        data: { matched_role: null, paths },
        next_steps: ROLE_KEYS.map((r) => `Ask: "What are the steps to become a Welile ${r}?"`),
        links: { landing_url: landingUrl, signup_url: signupUrl },
      });
    }

    const guide = ROLE_GUIDES[matched];
    const { signupUrl, referralUrl, landingUrl } = buildSignupLinks({
      referralCode: referral_code,
      role: guide.signup_role,
    });
    const links = {
      landing_url: landingUrl,
      signup_url: signupUrl,
      referral_url: referralUrl,
      role: guide.signup_role,
    };

    // ---------------------------------------------------------------- //
    // A single step, when asked for.
    // ---------------------------------------------------------------- //
    if (step != null) {
      const wanted = Math.round(step);
      const one = guide.steps.find((s) => s.step === wanted);
      if (!one) {
        return publicToolResult({
          tool: "get_onboarding_steps",
          summary: `Welile ${matched} onboarding has ${guide.steps.length} steps, so there is no step ${wanted}. Ask for a step between 1 and ${guide.steps.length}.`,
          data: {
            matched_role: matched,
            step_count: guide.steps.length,
            steps: guide.steps.map((s) => ({ step: s.step, title: s.title })),
          },
          next_steps: [`Ask: "Step 1 of becoming a Welile ${matched}"`],
          links,
          error: {
            code: "step_out_of_range",
            message: `Step must be between 1 and ${guide.steps.length}.`,
            details: { requested_step: wanted, step_count: guide.steps.length },
          },
        });
      }

      const nextStep = guide.steps.find((s) => s.step === one.step + 1) ?? null;
      return publicToolResult({
        tool: "get_onboarding_steps",
        kind: "info",
        summary: `Step ${one.step} of ${guide.steps.length} to become a Welile ${matched}: ${one.title}.`,
        body: [
          one.what_you_do,
          one.what_to_bring.length
            ? `What to bring:\n${one.what_to_bring.map((b) => `    • ${b}`).join("\n")}`
            : "Nothing to bring for this step.",
          `Typically takes: ${one.typical_duration}.`,
        ],
        assumptions: [
          "Step timings are typical, not guaranteed.",
          "All amounts on Welile are in Ugandan Shillings (UGX).",
        ],
        data: {
          matched_role: matched,
          step: one,
          step_count: guide.steps.length,
          next_step: nextStep ? { step: nextStep.step, title: nextStep.title } : null,
        },
        disclaimers: guide.disclaimers,
        next_steps: nextStep
          ? [`Ask: "Step ${nextStep.step} of becoming a Welile ${matched}" — ${nextStep.title}.`]
          : [`Create a free ${matched} account and start at step 1.`],
        links,
      });
    }

    // ---------------------------------------------------------------- //
    // The full walkthrough.
    // ---------------------------------------------------------------- //
    const bring = Array.from(new Set(guide.steps.flatMap((s) => s.what_to_bring)));
    return publicToolResult({
      tool: "get_onboarding_steps",
      kind: "info",
      summary: `Becoming a Welile ${matched} takes ${guide.steps.length} steps: ${guide.steps.map((s) => s.title.toLowerCase()).join(" → ")}.`,
      body: [
        `${guide.headline}\n${guide.who_it_is_for}`,
        guide.steps
          .map(
            (s) =>
              `Step ${s.step} — ${s.title}\n    ${s.what_you_do}${
                s.what_to_bring.length ? `\n    Bring: ${s.what_to_bring.join(", ")}` : ""
              }\n    Typically: ${s.typical_duration}`,
          )
          .join("\n\n"),
        bring.length ? `Have these ready before you start:\n${bring.map((b) => `    • ${b}`).join("\n")}` : "",
      ],
      assumptions: [
        "Step timings are typical and depend on agent availability in your area — they are not guaranteed.",
        "All amounts on Welile are in Ugandan Shillings (UGX).",
      ],
      estimates: {
        basis: "Number of onboarding steps published for this role.",
        confidence: "actual",
        currency: "UGX",
        ranges: [pointRange(`Onboarding steps for a ${matched}`, "onboarding_step_count", guide.steps.length, "count")],
      },
      data: {
        matched_role: matched,
        headline: guide.headline,
        who_it_is_for: guide.who_it_is_for,
        step_count: guide.steps.length,
        steps: guide.steps,
        bring_checklist: bring,
      },
      disclaimers: [
        "Completing these steps is not an approval — Welile confirms verification and terms in the app.",
        ...guide.disclaimers,
      ],
      next_steps: [
        `Create a free ${matched} account and complete step 1 now.`,
        `Ask: "Am I eligible to be a Welile ${matched}?" to check the requirements first.`,
      ],
      links,
    });
  },
});
