# Assign self-onboarded tenants to their referring agent

## Goal
When a signed-in tenant submits a Rent Request from `/tenants-onboarding`, attach the request to the agent already recorded as that tenant's referrer.

## Implementation
- Keep referral-link capture and account attribution unchanged.
- In the server-side onboarding function, read `profiles.referrer_id` for the authenticated tenant instead of trusting an agent ID sent by the browser.
- Reject self-referral and confirm the referenced profile is a valid enabled agent before using it.
- Write that verified ID to `rent_requests.agent_id`; otherwise preserve the current unassigned behavior.
- Include the assigned agent ID in the existing request-created event metadata for traceability.
- Do not create `agent_subagents` links, alter referral bonuses, backfill old requests, or change wallet/ledger behavior.

## Verification
- Add focused coverage for valid referrer, absent/invalid referrer, and self-referral cases.
- Run the project guards and relevant checks, deploy the updated onboarding function, and verify the live function.
