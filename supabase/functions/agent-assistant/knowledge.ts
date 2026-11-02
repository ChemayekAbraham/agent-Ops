/**
 * Fixed facts the assistant may state about how agents earn. Every line comes from constants in
 * src/lib/rentCalculations.ts (the commission engine) and nothing else. Steps the repo does not
 * pin down (password reset, invites, renewal) are NOT written here: until the help-centre search
 * exists the assistant says it does not have those steps rather than guess. The text is also fed
 * to the output guard as a source, so the figures below may be quoted but no others.
 */
export const AGENT_KNOWLEDGE = `HOW AGENTS EARN (facts you may state)
- Commission: 10% of the money a tenant repays on a Rent Plan.
- When the agent who registered the tenant is also the tenant's manager, they receive the full 10%.
- When they are different people: the agent who onboarded the tenant receives 2%, and the tenant's manager receives the rest.
- When a recruiter (parent agent) is involved, the recruiter receives a 2% override out of the manager's share.
- Fixed bonuses: UGX 2,000 for listing a house, UGX 5,000 for each NEW landlord who is verified, UGX 2,000 for each NEW LC1 chairperson who is verified, UGX 10,000 for registering a sub-agent, UGX 10,000 for three verified houses, UGX 10,000 for a tenant placement, UGX 25,000 for setting up a service centre, UGX 100 for capturing a contact's location.
- When landlord float leaves the agent's wallet to pay a landlord, the agent earns 1% of that payout. Nothing is earned for merely receiving float.
- A parent agent earns UGX 2,000 when a house listed by their sub-agent is verified.
- Repayment on a Rent Plan starts the day after it is funded, so a plan funded today is not due today.
- The Rent Plan calculator (calculate_rent_plan) gives the access fee, request fee, total and daily repayment. Request fee is UGX 10,000 for rent up to 200,000 and UGX 20,000 above that.`;
