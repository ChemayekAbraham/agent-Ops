/**
 * Fixed facts the assistant may state about how agents earn. The commission lines come from
 * constants in src/lib/rentCalculations.ts (the commission engine). The landlord-float spend line
 * is the approved reply for that question, not a commission figure. Steps the repo does not pin
 * down (password reset, invites, renewal) are NOT written here: until the help-centre search
 * exists the assistant says it does not have those steps rather than guess. The text is also fed
 * to the output guard as a source, so the figures below may be quoted but no others.
 */
export const AGENT_KNOWLEDGE = `HOW AGENTS EARN (facts you may state)
- Commission: 8% of each collection a tenant repays on a Rent Plan. The tenant's price does not change.
- An agent with no parent agent keeps the full 8%.
- A sub-agent with a verified parent agent keeps 6%, and the parent agent receives a 2% override.
- Whitelisted or elite-ranked sub-agents keep the full 8%, and their parent agent receives nothing from it.
- When the agent who onboarded the tenant is not the tenant's manager, the onboarding agent receives 2% out of the 8%, and the tenant's manager receives the rest.
- Fixed bonuses: UGX 2,000 for listing a house, UGX 5,000 for each NEW landlord who is verified, UGX 2,000 for each NEW LC1 chairperson who is verified, UGX 10,000 for registering a sub-agent, UGX 10,000 for three verified houses, UGX 10,000 for a tenant placement, UGX 25,000 for setting up a service centre, UGX 100 for capturing a contact's location.
- When landlord float leaves the agent's wallet to pay a landlord, the agent earns 1% of that payout. Nothing is earned for merely receiving float.
- How much landlord float an agent can spend always depends on the number of rent requests they have posted. When asked, say so and ask: "How many rent requests did you post?"
- A parent agent earns UGX 2,000 when a house listed by their sub-agent is verified.
- Repayment on a Rent Plan starts the day after it is funded, so a plan funded today is not due today.
- The Rent Plan calculator (calculate_rent_plan) gives the access fee, request fee, total and daily repayment. Request fee is UGX 10,000 for rent up to 200,000 and UGX 20,000 above that.

360-DAY RENT PLANS (only a plan stamped pricing_version v360, and only while new 360-day pricing is enabled for plans created after that. Current Rent Plans stay on the 8% rules above. These figures do not turn that pricing on.)
- Tenant agent commission is 8% of Gross: 6% sub-agent and 2% general agent. Worked example, rent UGX 100,000: Gross UGX 142,772, Daily UGX 4,760, sub-agent UGX 8,566, general agent UGX 2,855.
- A Proxy Agent (Platform Sales Officer) who onboarded the partner is paid once, 2% of the rent amount, from the Cover Pool's first cycle, not from Welile's 7%. At UGX 100,000 that fee is UGX 2,000 and the Cover Pool keeps UGX 885 of its UGX 2,885 cycle contribution.
- Welile's share stays 7% of Gross. Tithe is 10% of that 7%. At UGX 100,000 Welile's 7% is UGX 9,994, tithe UGX 999, Welile keeps UGX 8,995.
- A 360-day plan sets aside 15% for Partner Returns; each partner earns their own Returns rate (new partners: the current new-partner rate), not guaranteed.`;
