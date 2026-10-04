// Role-scoped landing config for the public /ai deep links
// (e.g. /ai?role=agent). MCP tool responses hand back these links so a
// prospective user lands in the Welile AI onboarding chat already scoped to the
// right role, with tailored suggestions and the correct signup CTA.

export const AI_ROLES = ["tenant", "agent", "landlord", "supporter"] as const;
export type AiRole = (typeof AI_ROLES)[number];

export function isAiRole(v: string | null | undefined): v is AiRole {
  return !!v && (AI_ROLES as readonly string[]).includes(v);
}

export interface RoleLanding {
  role: AiRole;
  emoji: string;
  /** Short label shown on the signup CTA. */
  cta: string;
  /** Headline in the empty state. */
  headline: string;
  /** One-line supporting copy. */
  subtitle: string;
  /** Role-specific starter questions. */
  suggestions: { icon: string; text: string }[];
}

export const ROLE_LANDINGS: Record<AiRole, RoleLanding> = {
  tenant: {
    role: "tenant",
    emoji: "🏠",
    cta: "Get rent help — free account",
    headline: "Need help with rent? 🏠",
    subtitle: "Ask about your Rent Plan, then create a free account to get funded.",
    suggestions: [
      { icon: "💸", text: "How does a Rent Plan work?" },
      { icon: "🧮", text: "Estimate my rent access" },
      { icon: "✅", text: "What do I need to get started?" },
      { icon: "🔎", text: "Find available houses near me" },
    ],
  },
  agent: {
    role: "agent",
    emoji: "⚡",
    cta: "Become an agent — free account",
    headline: "Earn as a Welile agent ⚡",
    subtitle: "Register tenants, list houses, collect rent — earn commission in UGX.",
    suggestions: [
      { icon: "💰", text: "How much can agents make?" },
      { icon: "📋", text: "What does an agent do daily?" },
      { icon: "🏦", text: "How do agent commissions work?" },
      { icon: "🚀", text: "How do I start earning?" },
    ],
  },
  landlord: {
    role: "landlord",
    emoji: "🏢",
    cta: "List your house — free account",
    headline: "Guaranteed rent for landlords 🏢",
    subtitle: "List your houses and receive on-time rent instead of chasing tenants.",
    suggestions: [
      { icon: "✅", text: "How do I get guaranteed rent?" },
      { icon: "🏠", text: "How do I list my house?" },
      { icon: "📆", text: "When do I get paid?" },
      { icon: "🤝", text: "How does Welile collect rent?" },
    ],
  },
  supporter: {
    role: "supporter",
    emoji: "💰",
    cta: "Become a Supporter — free account",
    headline: "Support tenants, earn Returns 💰",
    subtitle: "Your funds help tenants access rent and earn periodic Returns in UGX.",
    suggestions: [
      { icon: "📈", text: "Estimate my Supporter Returns" },
      { icon: "❓", text: "What is the Supporter programme?" },
      { icon: "🔐", text: "Is my money safe?" },
      { icon: "🪙", text: "What is the minimum to start?" },
    ],
  },
};

/** Builds the role-scoped signup CTA link, preserving attribution params. */
export function buildRoleSignupHref(
  role: AiRole,
  opts?: { source?: string | null; ref?: string | null },
): string {
  const params = new URLSearchParams({ signup: "1", role });
  const source = (opts?.source ?? "chatgpt").trim();
  if (source) params.set("signup_source", source);
  const ref = (opts?.ref ?? "").trim();
  if (ref) params.set("ref", ref);
  return `/auth?${params.toString()}`;
}
