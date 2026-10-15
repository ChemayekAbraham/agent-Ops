# 229 — Financial Ops owed figure counts zero-float payout claims (2026-10-14)

**Status: APPLIED BY HAND 2026-10-14 (Josh); migration file written to match.**
Migration: `supabase/migrations/20261014200000_owed_figure_counts_zero_float_claims.sql`

## Problem
Doc 228 made zero-float payout claims "evidenced" in `v_merchant_oop_evidence`, but
`get_merchant_float_positions` (the Financial Ops overview card's `owed_to_agent`)
carries its own copy of the test in its `unbacked` CTE: float position at payout
`< 0`. A desk that paid out at exactly zero float showed nothing owed.
Immaculate Namulindwa on 14 Oct: 15 bank payouts, UGX 12,727,500, card showed 0.

## Change
`< 0` → `<= 0` in that one expression (marker replace on the live definition,
aborts unless found exactly once). Positive positions are untouched.

## Effect (measured before applying; pending, unreimbursed claims at position 0)
| Desk | Owed on card before → after |
|---|---|
| Immaculate Namulindwa | 0 → 12,939,400 (payouts 12,841,500 + estimated fees 97,900) |
| Nabbaale Claire | 89,200 → 8,545,450 |
| Emma Maiso | 0 → 2,751,681 |

Verified live: function contains the doc 229 marker once, old marker gone.
The RPC rejects the MCP login, so the card total was recomputed with the same
expression, not read from the RPC.

## Known differences / not changed
- The card's owed figure includes telecom-fee claims that are still estimates;
  the settlement view (`v_merchant_oop_evidence` payable rule) excludes them
  until attested or given a provider reference.
- Mercy Bayo 7,214,190 (float covered part) and Prossy 5,259,963 (87M float at
  payout, likely wrongly filed) stay excluded.
- 12,939,400 includes two 12 Oct claims (114,000); today's payouts alone are
  12,727,500.
- Not in `critical_function_baselines`.
