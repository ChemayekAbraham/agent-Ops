# Partner Return cycle guard — runbook

Migration `supabase/migrations/20261024140000_return_cycle_guard.sql` (rollback in `supabase/rollbacks/`).
Rule: **one Partner Return per portfolio per cycle**, where a cycle is the calendar month of the scheduled Return
date, and **never more than one cycle's Return in total for that cycle** (cash + retained + reinvested) without a
bounded CFO override. Every query in this runbook is **read-only**. Nothing here moves money; any correction is a
separate, CFO-approved action.

## 1. How each route is protected

| Route | Protection |
|---|---|
| Payout request (any insert into `pending_wallet_operations` with `roi_payout` or `supporter_platform_rewards`) | Must name its portfolio. The request trigger reserves (portfolio, month) under a per-portfolio lock and a unique index, with a cap of one cycle's Return; one open request per portfolio |
| Approval (`approve-wallet-operation`) | The early check uses the reservation; posting is ONE database call, `post_return_payout`, which locks the request row, refuses it unless it is still awaiting approval, checks the cap, posts under `return-cycle:<claim>:cash`, marks it approved and moves `next_roi_date` in one transaction. The function continues to advance recovery or rent deduction **only if that call reports it posted**. Two approvals of the same request: one posts, the other gets `inserted=false` and stops. The Return's wallet leg must name the Withdrawable bucket, so the ledger decides where it lands and the approval never runs its balance-snapshot "recovery" for a Return (an unrelated withdrawal between two balance reads could otherwise make a credit look short) |
| Compound / split (`post_portfolio_roi_ledger`, 8-argument) | Reserves the month, checks the cap, posts, and changes principal / next date / total Returns in **one transaction**. Retry with the same reference: no change |
| Split cash portion | Joins the split's reservation; refused if retained/reinvested + cash would exceed the cap |
| Screens open from before this change | Their compound / split write to principal or total Returns is refused by `trg_guard_portfolio_return_fields` (no edit token) **before** they post, so nothing changes. Explicit admin edits (portfolio edit, account edit, renewal) send a new `return_fields_edit_token` and are accepted. Date-only edits are unaffected |
| Ledger (`trg_enforce_return_cycle_ledger_key`) | A Return wallet credit must come from a verified source: a portfolio reservation key within its cap; a paid rent-reward payment row (and not more credits than paid rows); or a self-managed partner cycle row with its own key. Anything else is refused. Portfolio reinvestments need a reservation key; rent-reward auto-reinvestments need a reinvested payment row |
| CFO direct credit / scheduled payouts | A credit coded as a Return is refused (`RETURN_CREDIT_NOT_ALLOWED_HERE`) before anything is written |
| History before the migration | Old `roi-cycle-<portfolio>-<date>` credits block their month; Returns with **no** cycle key (compounds, split parts, null-key credits) block the month they were posted in **and the month before** (late payments); months before 2026-08 need an override |

**Lock order.** Every reservation takes the portfolio row lock first and then the reservation lock, in the same order
as a compound, so a payout request or an approval running at the same moment as a compound on the same portfolio
waits instead of deadlocking.

## 2. Compound / split that posts but whose portfolio change fails

Cannot happen on the updated screens: posting and portfolio change are one database transaction. A screen still
open from before this change cannot get as far as posting: its own write to principal or total Returns is refused
first, so the portfolio is unchanged; the person reloads and repeats the action. No recovery procedure is needed for
either case. If a principal ever looks wrong, compare it with the portfolio change log and the reinvestment postings
under `return-cycle:<claim>:reinvest`; correct only with CFO approval.

## 3. Historical compounds and splits without cycle keys

Not changed, not back-filled. The reservation check reads them (section 1, last row). This can refuse a legitimate
payment (for example a compound for October posted on 2 November blocks both October and November); that is resolved
with an override (section 4). It never lets a same-month duplicate through for the patterns in the 24 October audit.

## 4. CFO override — the approved workflow

For an exceptional extra Return in a month that already has one, a month blocked for another reason, or an amount
above one cycle's Return.

1. **Decide.** The CFO approver confirms, outside the system, why the extra amount is owed (for example a missed May
   cycle evidenced by Proxy Agent statements).
2. **Authorise (pays nothing).** The CFO approver calls `authorise_return_cycle_override(portfolio, any date in the
   month, requester, max_amount, reason)` (hook `useAuthoriseReturnCycleOverride`). Server checks: caller is the CFO
   approver (`is_cfo_approver`: the pinned CFO position or a pinned super admin); reason at least 20 characters; the
   named requester is Returns staff and is not the authoriser; `max_amount` is a whole number, above 0 and at most
   twice one cycle's Return. Recorded in `portfolio_return_cycle_overrides` and `audit_logs`
   (`return_cycle_override_authorised`). Valid 24 hours.
3. **Request.** The named requester, from **their own signed-in session**, requests the Return with
   `metadata.override_id` (payout) or `p_override_id` (compound/split). Server checks: override matches the portfolio
   and month; not used, revoked or expired; the authoriser is still the CFO approver; the session user is the named
   requester (service-role calls and `metadata.initiated_by` are never accepted for an override); the amount is
   within `max_amount`; and the month really is blocked (otherwise "No override is needed" and it is not used).
   It is consumed (single use), the reservation's cap becomes `max_amount`, and `return_cycle_override_used` is
   written to `audit_logs`.
4. **Approve.** Normal COO → CFO approval. An override can never be used at approval, and the approval cannot post
   more than the reservation's cap.
5. **Revoke** an unused override with `revoke_return_cycle_override` (CFO approver only; audited).

Review: `select * from portfolio_return_cycle_overrides order by authorised_at desc;` and
`select * from audit_logs where action_type like 'return_cycle_override_%' order by created_at desc;`

## 5. Direct-credit "ROI payout" option

`cfo-direct-credit` refuses a Return-coded credit with HTTP 422 `RETURN_CREDIT_NOT_ALLOWED_HERE` before writing
anything (no ledger row, SMS, idempotency row or standing order). The CFO screen shows the error; with several
recipients every one fails and the first error is shown; no standing order is created because that step runs only
after a successful payout. The ROI payout **queue** on the same screen is unaffected (it approves through
`approve-wallet-operation`). UI follow-up for Gemini: hide the direct "ROI payout" form and point to the Partners page.

## 6. Deploy order and transition

1. Apply the migration (one transaction; its precondition aborts if production changed).
2. Immediately deploy `approve-wallet-operation` and `cfo-direct-credit`.
3. Publish the frontend.

Between steps everything fails closed: the old approval's Return postings are refused by the ledger (approvals wait);
open screens' compound / split / admin principal edits are refused before they change anything (reload after step 3);
payout requests are reserved normally. Nothing is paid twice in any window.

## 7. Rollback

`supabase/rollbacks/20261024140000_return_cycle_guard.rollback.sql` restores the two production functions exactly,
removes the guard's triggers and functions, keeps the reservation tables and the edit-token column, and adds one
read-only check (`trg_return_cycle_rollback_compat`) so a month paid while the guard was live cannot be requested
again. Then redeploy the previous edge functions and revert the frontend.

## 8. Monitoring

```sql
begin transaction read only;
-- Reservations and what was posted under them, last 30 days
select c.cycle_month, c.kind, c.claim_seq, c.status, count(*) from portfolio_return_cycle_claims c
 where c.created_at > now() - interval '30 days' group by 1,2,3,4 order by 1 desc;
-- Two Return reservations for one portfolio and month (only possible with an override)
select portfolio_id, cycle_month, count(*) from portfolio_return_cycle_claims
 where status = 'active' group by 1,2 having count(*) > 1;
-- Any reservation whose postings exceed its cap (must be empty)
select c.id, c.cycle_return_cap, sum(g.amount) posted from portfolio_return_cycle_claims c
  join general_ledger g on g.idempotency_key like 'return-cycle:' || c.id || ':%' and g.direction = 'cash_in'
 group by 1,2 having sum(g.amount) > c.cycle_return_cap;
rollback;
```
Plus the existing duplicate monitor `get_duplicate_roi_credits__impl`.
