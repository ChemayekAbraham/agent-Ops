---
name: House verification bonus = UGX 2,000 (no instant bonus)
description: Agent earns exactly UGX 2,000 when their house listing is verified; no instant listed-reward, no 5,000 variant. Landlord verification is a separate 2,000, recruiter override 2,000.
type: feature
---
**Locked amount (2026-07-31): a verified house listing pays the listing agent UGX 2,000. Nothing else.**

- Paid by DB trigger `trg_pay_agent_house_verified_bonus` → `pay_agent_house_verified_bonus`, idempotency key `house_verified_bonus:<listing_id>` (wallet `agent_commission` cash_in / platform `marketing_expense` cash_out).
- `supabase/functions/credit-listing-bonus` must keep `LISTING_BONUS = 2000`. It was silently raised to **5,000** on 2026-07-23 (commit `3547f41d`, comment "full UGX 5,000 listing bonus") — corrected back to 2,000 on 2026-07-31. Never raise it again without an explicit instruction.
- **No instant bonus.** The UGX 1,000 instant house-listed reward was retired 2026-07-23 and is hard-blocked by trigger `block_retired_instant_house_reward`. Do not reintroduce any pay-on-creation reward.
- **No backfills.** Historic rows at 1,000 / 4,000 / 5,000 stay as-is; never retro-adjust past bonuses.

Separate, unchanged events (do not fold into the house bonus):
- Landlord on the listing verified → UGX 2,000 to the same agent (`pay_agent_listing_bonus`, key `listing_bonus:<listing_id>`).
- Recruiter override on `house_listed_verified` → UGX 2,000 to the parent agent (`credit_recruiter_override`).
- Weekly Listing Mission completion → UGX 40,000 (`award_agent_listing_campaign_bonus`).
