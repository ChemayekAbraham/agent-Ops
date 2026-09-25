# Company → Wallets card: are the figures real?

## Finding (checked against the ledger, last 30 days)

The card is **not showing the real amounts**. It under-reports almost every line.

| Line | Card shows | Ledger (30 days) |
|---|---|---|
| 1. Returns paid to Supporters | UGX 60,796,116 (24 txns) | UGX 933,611,946 (774 txns) |
| 2. Rent to landlords via landlord float | UGX 0 | UGX 408,480,114 landlord float credited (10,977 legs) |
| 3. Advances to wallets | UGX 72,459 (88) | UGX 24,567,607 (4,866) |
| 4. Agent commissions & earnings | UGX 294,103 (162) | ~UGX 103.5M (commission + partner commission + referral bonus) |
| 7. Payroll | UGX 370,000 (1) | UGX 21,103,333 salary payouts (29) — not counted at all |
| 11. Agent float allocations | UGX 20,115,400 (18) | far larger (float deposits alone run to hundreds of millions per week) |

Only the percentages are internally consistent (60.8M / 82.6M = 74%); the totals themselves are wrong.

## Causes identified so far
- **Landlord float is missed**: it is booked as `rent_receivable_created` in the bridge section, which line 2's category list does not include — so it always shows UGX 0.
- **Payroll is missed**: payouts use `salary_payout`, not in line 7's list.
- **Merchant reimbursements, partner funding, wallet deposits** have no line, so they're dropped or pushed into "Other".
- **Large shortfall on lines 1, 3, 4, 11**: the card only counts a transaction when its legs pair a specific way; most real payments fail that test. Exact rule to be confirmed in step 1.

## Plan
1. Replicate the card's matching logic in SQL for the exact period on screen and list which real transactions it drops and why.
2. Add a read-only backend function that totals Company → Wallets per line straight from the ledger (same population as the rest of the CFO page: production + legacy_real, Kampala days), including landlord float, `salary_payout`, merchant reimbursements.
3. Point the card at that function; keep the drill-down lists.
4. Verify each line against the ledger totals above, live in the preview, and run the safety checks.

No money moves and no records change — this is display only.
