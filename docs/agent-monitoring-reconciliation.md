# Agent Monitoring: reconciliation of the payout-clock change

Date of figures: Monday 12 October 2026 (Kampala), live data, same signed-in session, old and new
captured minutes apart. "Old" is the page as it was before the payout-clock work
(`4c53a26da9`); "new" is the page after this change.

> This file is in `docs/` rather than `/mnt/documents/`: that folder does not exist on this Mac.

## 1. What every tab now does

| Tab | Counted from | Plans included |
|---|---|---|
| All agents | `clock_start` (day after the LAST landlord payout) | buckets `counting` and `outstanding_balance` only |
| After 1 Sep 2026 / Before 1 Sep 2026 | the Rent Plan's `clock_start` against 1 Sep 2026 | same two buckets |
| Expected vs paid | `clock_start` (new `am_plan_positions`) | same two buckets |
| Rent Analysis | `clock_start` | same two buckets |
| Tenant paying, landlord not paid | no clock yet | bucket `tenant_paying_no_landlord` |
| Awaiting landlord payment | no clock yet | bucket `awaiting_landlord` |

`outstanding_balance` plans keep their existing start and are now marked "Outstanding balance".

## 2. KPI, old vs new (today)

### All agents tab

| KPI | Old | New |
|---|---|---|
| Agents monitored | 105 | 98 |
| Due this day | 859 of 857 tenants | 797 of 803 tenants |
| Collected today | UGX 1,858,172 of UGX 23,434,138 expected | UGX 1,858,172 of UGX 22,275,731 expected |
| Total arrears | UGX 228,762,250 (859 behind) | UGX 212,642,101 (797 behind) |
| Paid ahead | 4 | 7 |
| Daily / weekly | 835 / 30 | 777 / 30 |

Collected today did not change (Collected is computed exactly as before). 58 plans left the page
(865 to 807): the plans in the two uncovered buckets that were on the daily eligibility list.

### After / Before 1 Sep 2026 tabs

The meaning of these two tabs changed, so the old and new rows are not like-for-like.
**Old** split the AGENTS by the date the agent's profile was created. **New** splits the RENT PLANS
by `clock_start`. (The request asked for the split to move off `request created_at`; the page was in
fact splitting on the agent's profile date, so that is what was replaced.)

| | Old: agents added | New: plans counted from |
|---|---|---|
| After 1 Sep, agents monitored | 19 | 78 |
| After, due this day | 89 of 92 | 392 of 398 |
| After, collected | UGX 382,750 of UGX 1,284,062 | UGX 1,379,170 of UGX 13,877,210 |
| After, arrears | UGX 11,293,603 | UGX 87,160,590 |
| After, paid ahead | 1 | 5 |
| After, daily / weekly | 92 / 0 | 375 / 24 |
| Before 1 Sep, agents monitored | 86 | 56 |
| Before, due this day | 770 of 765 | 405 of 407 |
| Before, collected | UGX 1,475,422 of UGX 22,150,076 | UGX 479,002 of UGX 8,398,521 |
| Before, arrears | UGX 217,468,647 | UGX 125,481,511 |
| Before, paid ahead | 3 | 2 |
| Before, daily / weekly | 743 / 30 | 402 / 6 |

New After + New Before = New All, exactly: due 392 + 405 = 797; collected UGX 1,379,170 + 479,002 =
UGX 1,858,172; arrears UGX 87,160,590 + 125,481,511 = UGX 212,642,101; plans 399 + 408 = 807
(an agent can appear on both tabs, so the agent counts do not add).
A plan with no clock is in neither cohort; it is on the two new tabs.

### Expected vs paid tab (one day: 12 Oct 2026)

| KPI | Old | New |
|---|---|---|
| Expected in period | UGX 6,111,776 (930 tenants scheduled) | UGX 6,213,113 (904 tenants scheduled) |
| Actual paid | UGX 3,145,484 | UGX 3,145,484 |
| Expected vs paid | -UGX 2,966,292 (51.5%) | -UGX 3,067,629 (50.6%) |
| Paid ahead (credit) | UGX 8,422,284 (3 tenants) | UGX 11,346,758 (6 tenants) |
| Arrears at period end | UGX 251,565,867 (876 behind) | UGX 240,113,325 (827 behind) |

This tab reads a new server function, `am_plan_positions`, which has the same columns and the same
instalment shape, payment de-duplication and bands as `get_agent_monitoring_positions`, but starts
every plan on its clock and leaves out the two uncovered buckets. Where a plan's start did not move
(1,384 plans compared) the two functions agree on 1,360; the other 24 differ because the old function
overlays frozen historical day expectations (`agent_expected_day_plans`), keyed to the old dates, which
the new one does not use (for example a weekly plan that the old function expected UGX 89,334 for, the
new one expects its weekly instalment, UGX 625,338).

### Rent Analysis tab

| KPI | Old | New |
|---|---|---|
| Active tenants | 868 (838 daily / 30 weekly) | 809 (779 / 30) |
| Total monthly rent | UGX 381,243,729 | UGX 356,351,001 |
| Collected in period (13 Sep to 12 Oct) | UGX 88,003,976 (3,806 receipts) | UGX 85,787,797 (3,769 receipts) |
| Tenants in arrears | 862 (UGX 230,568,563) | 799 (UGX 213,480,101) |
| Paid in period | 70.4% (611 of 868) | 73.2% (592 of 809) |
| Outstanding balances | UGX 346,180,395 | UGX 323,675,987 |

## 3. Bucket counts (active Rent Plans: funded, disbursed or repaying, 939)

| Bucket | Active plans | All Rent Plans (6,481) |
|---|---|---|
| counting | 746 | 1,219 |
| outstanding_balance | 108 | 314 |
| tenant_paying_no_landlord | 59 | 140 |
| awaiting_landlord | 25 | 4,808 |

Plans whose start moved: 12 later (11 with exact payout dates, plus 1 whose payout date is estimated)
and 4 earlier.

## 4. The shifted plans, old vs new arrears (UGX)

Old = stored start and `amount_repaid`; new = the clock and `paid_to_date`.

### Shifted later: the 11 with exact payout dates

| Plan | Agent | Old start | New start | Shift | Old arrears | New arrears |
|---|---|---|---|---|---|---|
| 7b003929 | Martin Muhwezi | 05 May | 02 Oct | +150 | 880,500 | 67,624 |
| 2e91aed1 | Akandwanaho Wycliffe | 23 Apr | 16 Sep | +146 | 100,000 | 51,468 |
| 7d0273ed | Akandwanaho Wycliffe | 23 Apr | 11 Sep | +141 | 194,000 | 194,000 |
| b87162cf | Akandwanaho Wycliffe | 23 Apr | 11 Sep | +141 | 110,000 | 110,000 |
| 7a3e1af7 | kamulinde cosea Enoch | 02 May | 17 Sep | +138 | 123,000 | 13,942 |
| 94d31512 | kamulinde cosea Enoch | 02 May | 10 Sep | +131 | 22,500 | 22,500 |
| 48b962ec | SHAFEEQ SSENABULYA | 14 Aug | 23 Sep | +40 | 55,000 | 0 |
| 19a88596 | Mugisha Emmanuel | 09 Sep | 09 Oct | +30 | 204,000 | 0 |
| 0835dd49 | ALPHA SSEMA | 04 Sep | 11 Sep | +7 | 50,000 | 50,000 |
| 2a7ea9c7 | Thomas hawahka | 13 Aug | 14 Aug | +1 | 360,500 | 0 |
| f9837b50 | Thomas hawahka | 04 Sep | 05 Sep | +1 | 369,000 | 159,000 |

### Shifted later, payout date estimated (the 12th)

| Plan | Agent | Old start | New start | Shift | Old arrears | New arrears |
|---|---|---|---|---|---|---|
| 9f8f14a9 | IAN MUHWEZI | 22 Jul | 24 Jul | +2 | 2,061,917 | 2,111,917 |

This payout has neither `finops_disbursed_at` nor `disbursed_at` (17 old July payouts are like this), so
`otp_verified_at` is used; without that fallback the count is exactly 11.

### Shifted earlier (4)

| Plan | Agent | Old start | New start | Shift | Old arrears | New arrears |
|---|---|---|---|---|---|---|
| 0e2c6965 | NSUBUGA Lawrence George | 26 Sep | 25 Sep | -1 | 181,439 | 195,406 |
| bb908335 | NSUBUGA Lawrence George | 26 Sep | 25 Sep | -1 | 92,939 | 106,906 |
| 7e6325a5 | EMMANUEL WASWA SSESANGA | 06 Oct | 23 Sep | -13 | 94,319 | 382,957 |
| 6314ae49 | Mwanje Isaac | 07 Oct | 23 Sep | -14 | 63,802 | 259,340 |

## 5. The split-payout plan

Exactly one active Rent Plan has more than one counted landlord payout: **`c62755d0-ed8e-4fbb-a876-185301519d14`**.
It was paid as three payouts of UGX 150,000 (UGX 450,000), all `completed`, all on 13 May 2026. The clock
starts the day after the LAST payout, 14 May 2026, which is also its stored start, so it did not
shift. Its arrears today are UGX 209,500.

## 6. Requests submitted

"Requests submitted" now excludes `rejected`, `cancelled` and `deleted_by_agent` requests; the
all-time number is the secondary line, and **Live plans** (funded, disbursed or repaying) is its own
column. Examples from today: JAMES KATONGOLE was 90, is now 88 (90 all-time, 7 live plans);
SHAFEEQ SSENABULYA 110 to 97 (110 all-time, 23 live); WAMBULA AVIN 42 to 39 (42 all-time, 19 live);
IAN MUHWEZI now 161 (183 all-time, 25 live).

## 7. PDF

The PDF prints the same figures as the screen: the "Counted from the day after the landlord was paid"
note under the title, the new Requests (all-time) and Live plans columns, the cohort wording, and the
two new sections (Tenant paying, landlord not paid / Awaiting landlord payment).

## 8. One access fix that came with this

`am_plan_clock` and `am_plan_arrears` (the previous change) only allowed six roles, while
Agent Monitoring had also been readable by `cto`, `operations`, `agent_ops` and `financial_ops`.
They now share one gate, `_am_staff_ok()`, with the same ten roles `get_agent_monitoring_positions`
already used. Same signatures and bodies otherwise.

## 9. Scope confirmation (`git diff --stat` against `origin/lovable`)

```
 AGENTS.md                                          |   1 +
 docs/TOPS_BUILD_LOG.md                             |  10 +
 scripts/schema-types.fingerprint.json              |   6 +-
 .../executive/tenant-ops/AgentMonitoring.tsx       |  81 ++--
 .../executive/tenant-ops/AgentPaymentPosition.tsx  |   9 +-
 .../executive/tenant-ops/RentAnalysis.tsx          |  23 +-
 src/lib/agentMonitoringClockSchedule.test.ts       |  15 +
 src/lib/agentMonitoringClockSchedule.ts            |  12 +
 src/lib/agentMonitoringReportPdf.test.ts           |  17 +
 src/lib/agentMonitoringReportPdf.ts                |  24 +-
 src/lib/rentAnalysis.test.ts                       |  37 ++
 src/lib/rentAnalysis.ts                            |  16 +-
 ...1012150000_am_plan_positions_and_staff_gate.sql | 440 +++++++++++++++++++++
 ...0_am_plan_positions_and_staff_gate.rollback.sql | 229 +++++++++++
 supabase/tests/am_plan_positions.sql               | 130 ++++++
 15 files changed, 1004 insertions(+), 46 deletions(-)
```

(This file, `docs/agent-monitoring-reconciliation.md`, is the 16th and is left out of its own listing.)

Outside Agent Monitoring and the new `am_` migration / rollback / test: only `scripts/schema-types.fingerprint.json`
(the build guard that fingerprints the generated types; the generated `types.ts` already carried the new
function once it was applied to the database, so it shows no difference), `AGENTS.md`, and the two `docs/` files.
No other page, hook, view or shared file changed. `src/lib/rentAnalysis.ts` is used only by Rent Analysis inside Agent Monitoring and gained an
optional parameter whose default is the old behaviour.

## 10. Verification

- `supabase/tests/am_plan_positions.sql` (rolled back): all ten roles may read, signed-out and role-less
  callers are refused, only `counting` / `outstanding_balance` plans start on their clock, nothing from
  the two uncovered buckets, expected equals an independent daily / weekly calculation (319 plans),
  `paid_to_date` equals `am_plan_arrears` for every plan, unattributed agent cash identical to the old function.
- Unit tests for the cohort rule, the Rent Analysis schedule hook, the PDF columns and sections.
- `npm run guard:all` and `npm run build`.
