import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { buildSignupLinks, type SignupRole } from "../links";
import { enforceRateLimit } from "../rateLimit";
import { publicToolResult } from "../response";

// Guided prompts turn a prospective user's read-only question (e.g.
// "check my rent access", "see agent commissions") into a clear explanation of
// what they'll be able to do, plus a role-targeted signup link. This is the
// bridge from "just asking" to "creating an account".
type Feature = {
  intent: string;
  prompt: string; // the natural-language prompt an assistant can suggest
  role?: SignupRole; // pre-selects the signup path where relevant
  headline: string;
  explanation: string; // compliance-safe, UGX-only
  next_step: string;
};

const FEATURES: Feature[] = [
  {
    intent: "rent_access",
    prompt: "Check my rent access",
    role: "tenant",
    headline: "Access rent with a flexible Rent Plan",
    explanation:
      "As a tenant you can get help paying rent through a Rent Plan and repay in small, regular UGX amounts that fit your income. To see the amount you qualify for, you create a free account and complete verification (national ID and residence) — an agent or landlord then connects you to a Rent Plan.",
    next_step:
      "Create a free tenant account to check your personal rent access and start a Rent Plan.",
  },
  {
    intent: "agent_commissions",
    prompt: "See agent commissions",
    role: "agent",
    headline: "Earn commission as a field agent",
    explanation:
      "Agents register tenants, list houses, and collect rent in the field. You earn commission in UGX on the collections and placements you make, tracked in a wallet you can withdraw from. Your exact earnings and wallet balance are shown once you sign in.",
    next_step:
      "Create a free agent account to see your commission wallet and start earning.",
  },
  {
    intent: "supporter_returns",
    prompt: "See supporter Returns",
    role: "supporter",
    headline: "Support tenants and earn Returns",
    explanation:
      "As a Supporter your funds help tenants access rent, and you earn periodic Returns in UGX. Rates and terms are shown in the app when you sign up. (Terminology: Supporter, not lender; Returns, not interest.)",
    next_step:
      "Create a free Supporter account to view current Returns and start supporting tenants.",
  },
  {
    intent: "landlord_payouts",
    prompt: "Get guaranteed rent as a landlord",
    role: "landlord",
    headline: "Guaranteed, on-time rent for landlords",
    explanation:
      "Landlords list their houses and receive guaranteed, on-time rent in UGX instead of chasing tenants each month. Welile handles collection through its agent network.",
    next_step:
      "Create a free landlord account to list a house and receive guaranteed rent.",
  },
  {
    intent: "trust_score",
    prompt: "Check my Welile Trust Score",
    headline: "Build a Welile Trust Score",
    explanation:
      "Every user builds a Welile Trust Score — a reliability identity based on real behaviour like on-time payments and verification. A higher score unlocks better access over time. Your personal score appears once you sign in.",
    next_step:
      "Create a free account to start building your Welile Trust Score.",
  },
];

function matchFeature(intent?: string): Feature | null {
  const term = (intent ?? "").trim().toLowerCase();
  if (!term) return null;
  return (
    FEATURES.find((f) => f.intent === term) ??
    FEATURES.find(
      (f) =>
        f.prompt.toLowerCase().includes(term) ||
        f.headline.toLowerCase().includes(term) ||
        term.includes(f.intent.split("_")[0]),
    ) ??
    null
  );
}

export default defineTool({
  name: "explore_welile",
  title: "Explore Welile (guided prompts)",
  description:
    "Answer a prospective user's read-only question about what Welile can do for them (e.g. 'check my rent access', 'see agent commissions', 'supporter Returns', 'landlord payouts', 'Trust Score') and return a role-targeted free signup link so they can act. No sign-in required. Amounts in UGX. If no intent is given, returns the full list of guided prompts to suggest.",
  inputSchema: {
    intent: z
      .string()
      .describe(
        "The user's goal. One of: rent_access, agent_commissions, supporter_returns, landlord_payouts, trust_score — or free text like 'check my rent access'. Omit to list all guided prompts.",
      )
      .optional(),
    referral_code: z
      .string()
      .describe("Optional referral code (the referrer's Welile user id) to build a referral signup link.")
      .optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ intent, referral_code }) => {
    const limited = await enforceRateLimit("explore_welile");
    if (limited) return limited;

    const feature = matchFeature(intent);

    if (feature) {
      const { signupUrl, referralUrl, landingUrl } = buildSignupLinks({
        referralCode: referral_code,
        role: feature.role,
      });
      return publicToolResult({
        tool: "explore_welile",
        kind: "info",
        summary: feature.headline,
        body: [feature.explanation],
        assumptions: [
          "General explanation of the feature — not a figure calculated for your account.",
          "All amounts on Welile are in Ugandan Shillings (UGX).",
        ],
        data: {
          matched_intent: feature.intent,
          headline: feature.headline,
          explanation: feature.explanation,
          guided_prompts: null,
        },
        disclaimers: [
          "Your personal figures appear only after you create a free account and sign in.",
        ],
        next_steps: [feature.next_step],
        links: {
          landing_url: landingUrl,
          signup_url: signupUrl,
          referral_url: referralUrl,
          role: feature.role ?? null,
        },
      });
    }

    // No/unknown intent → return the menu of guided prompts, each with its own
    // role-targeted signup link so the assistant can offer them as next steps.
    const prompts = FEATURES.map((f) => {
      const { signupUrl, landingUrl } = buildSignupLinks({ referralCode: referral_code, role: f.role });
      return {
        prompt: f.prompt,
        intent: f.intent,
        headline: f.headline,
        role: f.role ?? null,
        landing_url: landingUrl,
        signup_url: signupUrl,
      };
    });
    const menuText = [
      "Ask about any of these to get started with Welile (UGX):",
      ...prompts.map((p) => `• ${p.prompt}`),
    ].join("\n");
    const { signupUrl, landingUrl } = buildSignupLinks({ referralCode: referral_code });
    return publicToolResult({
      tool: "explore_welile",
      kind: "info",
      summary: `Welile can help you in ${prompts.length} ways — ask about any of these to get a real ballpark in UGX.`,
      body: [menuText],
      assumptions: [
        "No specific goal was given, so this is the full menu of guided prompts.",
        "All amounts on Welile are in Ugandan Shillings (UGX).",
      ],
      data: {
        matched_intent: null,
        headline: null,
        explanation: null,
        guided_prompts: prompts,
      },
      next_steps: prompts.map((p) => `Ask: "${p.prompt}"`),
      links: { landing_url: landingUrl, signup_url: signupUrl },
    });
  },
});
