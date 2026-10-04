import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { buildSignupLinks } from "../links";
import { enforceRateLimit } from "../rateLimit";
import { publicToolResult } from "../response";

// Guided prompts an assistant can suggest to move a prospective user from a
// read-only question toward creating an account. Kept in sync with the
// `explore_welile` tool intents.
const GUIDED_PROMPTS = [
  "Check my rent access",
  "See agent commissions",
  "See supporter Returns",
  "Get guaranteed rent as a landlord",
  "Check my Welile Trust Score",
];

const FAQS: { q: string; a: string; tags: string[] }[] = [
  {
    q: "What is Welile?",
    a: "Welile is a Ugandan platform that helps tenants access rent through a flexible Rent Plan, backed by community Supporters and served on the ground by field agents. All amounts are in Ugandan Shillings (UGX).",
    tags: ["about", "what", "welile", "overview"],
  },
  {
    q: "How do I get rent help as a tenant?",
    a: "Create a free account, complete verification (your national ID and residence), and an agent or landlord connects you to a Rent Plan. You then repay in small, regular amounts that fit your income.",
    tags: ["tenant", "rent", "help", "how", "repay"],
  },
  {
    q: "How do agents earn on Welile?",
    a: "Agents register tenants, list houses, and collect rent in the field. They earn commission on the collections and placements they make, tracked in a wallet they can withdraw from.",
    tags: ["agent", "earn", "commission", "work", "job"],
  },
  {
    q: "How can I support tenants and earn Returns?",
    a: "Become a Supporter: your funds help tenants access rent, and you earn periodic Returns. Rates and terms are shown in the app when you sign up. (Terminology: Supporter, not lender; Returns, not interest.)",
    tags: ["supporter", "invest", "fund", "returns", "earn"],
  },
  {
    q: "How does a landlord benefit?",
    a: "Landlords list their houses and receive guaranteed, on-time rent instead of chasing tenants each month. Welile handles collection through its agent network.",
    tags: ["landlord", "house", "rent", "guarantee"],
  },
  {
    q: "What is the Welile Trust Score / AI ID?",
    a: "Every user builds a Welile Trust Score — a reliability identity based on real behaviour like on-time payments and verification. A higher score unlocks better access over time.",
    tags: ["trust", "score", "ai id", "identity", "reliability"],
  },
  {
    q: "Is Welile free to join?",
    a: "Yes, creating an account is free. You only ever deal in UGX, and you can start as a tenant, agent, landlord, or Supporter.",
    tags: ["free", "cost", "join", "signup", "price"],
  },
  {
    q: "How do I check what I personally qualify for?",
    a: "Personal figures — your rent access, wallet balance, commissions, or Returns — are shown once you create a free account and sign in. Ask 'check my rent access' or 'see agent commissions' to get started, and I'll share the right signup link.",
    tags: ["check", "qualify", "balance", "personal", "account", "my"],
  },
  {
    q: "Is my money safe and what currency is used?",
    a: "Welile operates strictly in Ugandan Shillings (UGX). Every balance, Rent Plan, commission, and Return is recorded in UGX, and your account activity is tied to your verified identity.",
    tags: ["safe", "security", "currency", "ugx", "money"],
  },
];

export default defineTool({
  name: "how_welile_works",
  title: "How Welile works",
  description:
    "Explain how Welile Receipts works for new users (tenants, agents, landlords, and Supporters) and return the signup link. Optionally personalise with a referral code to return a referral signup link. No sign-in required — safe for prospective users.",
  inputSchema: {
    topic: z
      .string()
      .describe(
        "Optional keyword to focus the answer (e.g. 'tenant', 'agent', 'supporter', 'landlord', 'trust score'). Omit to get all FAQs.",
      )
      .optional(),
    referral_code: z
      .string()
      .describe("Optional referral code (the referrer's Welile user id) to build a referral signup link.")
      .optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ topic, referral_code }) => {
    const limited = await enforceRateLimit("how_welile_works");
    if (limited) return limited;

    const term = (topic ?? "").trim().toLowerCase();
    const matched = term
      ? FAQS.filter(
          (f) =>
            f.q.toLowerCase().includes(term) ||
            f.tags.some((t) => t.includes(term) || term.includes(t)),
        )
      : FAQS;
    const faqs = matched.length > 0 ? matched : FAQS;

    const { signupUrl, referralUrl, landingUrl } = buildSignupLinks({ referralCode: referral_code });

    const faqText = faqs.map((f) => `Q: ${f.q}\nA: ${f.a}`).join("\n\n");

    return publicToolResult({
      tool: "how_welile_works",
      kind: "info",
      summary: term
        ? `How Welile works — ${faqs.length} answer${faqs.length === 1 ? "" : "s"} about "${term}". All amounts are in UGX.`
        : "How Welile works: tenants access rent through a flexible Rent Plan, agents serve them in the field, landlords get guaranteed rent, and Supporters earn Returns. All amounts are in UGX.",
      body: [faqText, "", `Try asking:\n${GUIDED_PROMPTS.map((p) => `• ${p}`).join("\n")}`],
      assumptions: [
        "General product information only — nothing here is specific to one person's account.",
        "Every amount on Welile is in Ugandan Shillings (UGX).",
      ],
      data: {
        matched_topic: term || null,
        faqs: faqs.map(({ q, a }) => ({ question: q, answer: a })),
        guided_prompts: GUIDED_PROMPTS,
      },
      disclaimers: [
        "Personal figures (your rent access, wallet, commissions, or Returns) are only visible after you create a free account and sign in.",
      ],
      next_steps: [
        "Create a free account to see what you personally qualify for.",
        "Ask one of the guided prompts above for a specific ballpark.",
      ],
      links: { landing_url: landingUrl, signup_url: signupUrl, referral_url: referralUrl },
    });
  },
});