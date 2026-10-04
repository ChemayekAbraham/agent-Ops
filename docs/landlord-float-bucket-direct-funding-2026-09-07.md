# Landlord Float Bucket / Direct Funding — what shipped

Status: IMPLEMENTED 2026-09-07 (6 migrations + 1 lib module, dry-run verified against production; **not yet applied to the live database** — see §6)
Scope: PSM (partner-funded) and cfo_disbursement (company-funded) landlord float, plus empty-house support
Source: partner call transcript + Josh's recap ("Landlord Float Flows" reference doc, 2026-09-07)

## 0. Why this exists

The reference doc describes a "Landlord Float Bucket": a partner ties capital to one
house, the tenant repays it in cycles, and the same principal recycles back to the
landlord every cycle — for up to 12 cycles — before it ever reaches the partner. None of
that existed. What did exist was a large, mature PSM (Self Portfolio Management) system
that disburses a partner's capital to a landlord **exactly once, ever**, with no
concept of a cycle, a recycle, or a return of principal.

Everything below is additive to that existing system, not a replacement of it — nothing
about how PSM commitments get created, approved, or reviewed by Partner Ops was touched.

## 1. Payment-linked accrual — `20260907140000_psm_payment_linked_accrual.sql`

`accrue_partner_self_returns` accrued Partner Returns purely time-based, deliberately
decoupled from whether the tenant actually paid (its own migration comment: "the company
absorbs tenant default, never the partner"). New opt-in `accrual_mode` column on
`partner_self_funding_lines` (default `'time_based'`, existing behavior untouched) lets a
line instead scale Returns by **collection ratio** — how much of this cycle's expected
repayment the tenant actually paid. Registration Fee and Platform Margin, which didn't
exist in PSM at all, are recognized the same way and posted immediately to the ledger
(`registration_fee_collected` / `access_fee_collected` — both already in the ledger's
locked category allowlist, so no new categories were needed).

A companion ops-only RPC, `psm_set_line_accrual_mode(line_id, mode)`, flips an
already-created line into payment-linked mode.

## 2. Direct (PSM) bucket recycle — `20260907150000_psm_landlord_float_bucket_recycle.sql`

Once a `partner_self_funding`-sourced landlord float allocation is fully paid out and the
tenant has no arrears, it now automatically redisburses for another cycle — capped by
the line's own `term_months` (a new `cycles_disbursed` counter) — by reusing
`psm_disburse_landlord_float` unchanged rather than duplicating its allocation/ledger
logic. The trigger point is `apply_landlord_payout_to_allocation`
(`AFTER UPDATE OF status ON landlord_payouts`), extended with one new block gated
strictly on `source = 'partner_self_funding'`.

`enforce_single_live_landlord_payout` (a pre-existing guard assuming one rent_request
gets exactly one landlord payout, ever) was relaxed to stop treating an earlier payout
as "live" once its allocation has itself reached `fully_paid` — every other blocking
condition is unchanged.

## 3. Principal release — `20260907160000_psm_principal_release.sql`

Closes the gap the recycle above left open: once `cycles_disbursed` reaches
`term_months`, `psm_release_line_principal(line_id, reason)` pays the partner's
principal back automatically (no approval needed — it's just paying out what the term
always implied). The same function serves an **ops-approved early withdrawal** before
the cap, gated behind the same role check `psm_set_line_accrual_mode` uses
(`is_ops_role` / cfo / ceo / partner_ops / financial_ops / super_admin).

Confirmed live before writing this that no such mechanism existed anywhere:
`psm_complete_line_on_plan_close` only flips a line's status, and
`psm_release_self_funding_line` is a pre-payout cancellation path that explicitly
refuses to run once anything has been paid out.

## 4. Indirect (company-funded) bucket recycle — `20260907180000_cfo_disbursement_float_bucket_recycle.sql`

Company float (`cfo_disbursement`) had no upfront term commitment to read from — a
CFO/manager clicks "fund" once, manually, per rent_request today
(`fund-agent-landlord-float` explicitly refuses to re-fund once `status='funded'`).
Product decision: treat it like PSM's cap anyway, **fully automatically**, at a fixed
12-cycle default (tracked on `rent_requests.cfo_float_cycles_disbursed`, since there's no
commitment row to hang a counter off). No principal-release step applies here — it's the
company's own money, not owed back to an external partner, so recycling just stops at
the cap.

A second latent guard, `enforce_single_rent_disbursement` (blocks any second
`category='rent_disbursement'` ledger row keyed on `source_table='rent_requests'` for a
given rent_request, permanently, no exception), was sidestepped rather than relaxed —
the recycle's ledger entries point at the newly-created allocation row instead
(`source_table='agent_landlord_float_allocations'`), which the guard's own early-exit
condition never matches.

## 5. Empty-house support activation — `20260907190000_empty_house_support_activation.sql`

`partner_supported_houses` (a partner pre-committing capital to a verified, empty house
via its listing, before any tenant exists) had **no landlord float mechanism at all**.
`approve_pending_portfolio`'s `self_managed_house` branch parks the capital in the
partner's own operational float wallet and explicitly never disburses it — its own
comment: "House support has no tenant, so it never reaches this branch."

The real activation signal turned out to be `landlord_ops_bind_tenant_to_house` — a
deliberate, role-gated (`landlord_ops`/`manager`) ops action that sets
`house_listings.tenant_id`, not an automatic side effect of normal rent approval. A new
trigger on that `NULL → not-NULL` transition resolves the real `rent_request_id` (house
match, falling back to landlord+tenant match), hands the pre-committed capital straight
into a real `agent_landlord_float_allocations` row plus a new `partner_self_funding_lines`
row carrying the house's own `principal`/`monthly_rate`/`term_months` — so **the
already-built recycle and principal-release triggers from §2–§3 pick it up automatically,
with zero new recycle logic.**

## 6. Daily rounding schedule — `20260907200000_direct_funding_daily_charge_schedule.sql` + `src/lib/directFundingDailyChargeSchedule.ts`

The reference doc's exact rule — `charge(day) = round(day×total÷term) −
round((day−1)×total÷term)`, producing an alternating whole-shilling cash amount with zero
drift — was added as a **standalone, additive, read-only** SQL function plus a TS mirror
(with passing tests against the doc's own worked examples: 10 low-days of 4,766 / 20
high-days of 4,767 on a 143,000/30 schedule, exact reconciliation on a 352,500/30
schedule). Deliberately does **not** touch `rent_requests.daily_repayment` or its
trigger-enforced `compute_rent_repayment` formula — that's used everywhere real money is
collected, system-wide, not just for Direct Funding; the blast radius of changing it
globally was judged far too high for what is, so far, a reporting/preview capability.

## 7. Deliberately not built

- **Agent commission** stays on the existing `credit_agent_rent_commission` 2%/8%/6%
  split — the reference doc's own balancing-line formula was explicitly rejected per
  product decision. Its numbers will never literally match the doc's worked examples.
- **UI** — nothing here has a front end. Which cycle a line is on, `accrual_mode`, term
  progress: all invisible without querying the database directly. This is Gemini's lane
  per the Claude/Gemini split, not mine.

## 8. Verification method (why this should be trusted)

Every migration above was dry-run against the **live production database** inside an
uncommitted transaction (via the Lovable MCP `query_database` tool) before being written
to a file — schema changes, function bodies, and realistic multi-cycle scenarios built
from real rent_requests/landlords/agents, then left to auto-rollback on connection close.
Confirmed after each run that nothing persisted. This caught real bugs no amount of
reading code would have: a `general_ledger` reference-uniqueness collision on the second
recycle cycle, and — see below — three separate guard triggers whose existence was
invisible from a `pg_constraint`/`information_schema` scan.

### Guards discovered only by dry-running (not visible from the repo)

| Guard | What it assumes | How it was handled |
|---|---|---|
| `enforce_single_live_landlord_payout` | One rent_request gets one landlord payout, ever | Relaxed: ignores an earlier payout once its allocation is `fully_paid` |
| `enforce_single_rent_disbursement` | One `rent_disbursement` ledger row per rent_request, ever, no exception | Sidestepped: recycle ledger entries key off the new allocation row instead |
| `general_ledger` category allowlist (`validate_ledger_category`, gated by `treasury_controls.strict_mode`) | Only a fixed, curated category vocabulary is allowed | Reused existing categories (`registration_fee_collected`, `access_fee_collected`) instead of inventing new ones |

Two more functions turned out to be substantially different live than in any migration
file — `partner_self_confirm_commitment` now delegates to `psm_confirm_commitment_for`
(promissory notes, `investor_portfolios`, ops-approval gating, none of it in
`supabase/migrations/`), and `partner_self_top_up` is now a "pending review" flow, not
immediate. Neither was touched, once discovered — the plan to modify commitment/line
creation was abandoned in favor of the narrower, safer changes described above.

## 9. Before this goes live

- These are migration **files only** — none of the six have been applied to the live
  Supabase database yet.
- `npm run schema:accept-types` is still outstanding (advisory guard warning only; blocked
  until the migrations are actually applied, since the new columns don't exist live yet).
- No UI exists for any of this.
