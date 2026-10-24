# Partner Return cycle guard — runbook

Migration `supabase/migrations/20261024140000_return_cycle_guard.sql` (rollback in `supabase/rollbacks/`).
Rule: **one Partner Return per portfolio per cycle**, where a cycle is the calendar month of the scheduled Return
date. Every query in this runbook is **read-only**. Nothing here moves money; any correction is a separate,
CFO-approved action.

## 1. How a Return is protected

| Path | Protection |
|---|---|
| Payout request (COO Partners page, any insert into `pending_wallet_operations` with `roi_payout`) | Request trigger reserves (portfolio, month) under a per-portfolio lock and a unique index; one open request per portfolio; must name its portfolio |
| Approval (`approve-wallet-operation`) | Posts only under the reservation's key `return-cycle:<claim>:cash`; fails closed; a retry posts nothing |
| Compound / split (`post_portfolio_roi_ledger`, 8-argument) | Reserves the month, posts, and changes the portfolio **in one transaction**; a retry with the same reference changes nothing |
| Ledger | Any portfolio Return credit or reinvestment without a valid reservation key is refused |
| CFO direct credit / scheduled payouts | A credit coded as a Return is refused (`RETURN_CREDIT_NOT_ALLOWED_HERE`) before anything is written |
| History before the migration | Old `roi-cycle-<portfolio>-<date>` credits count as paid for their month; Returns with **no** cycle key (compounds, split parts, null-key credits) block the month they were posted in; months before 2026-08 need an override |

## 2. Compound / split that posted but whose portfolio change failed

**Screens from this change:** cannot happen. The posting and the portfolio change (principal, next Return date, or
total Returns earned) are made by `post_portfolio_roi_ledger` in one database transaction: either both happen or
neither does. A retry with the same reference returns the existing posting and changes nothing; a retry with a new
reference is refused for that month (`23505`).

**Screens published before this change** (until every open browser tab is reloaded): they change the portfolio
themselves, before calling the old six-argument function. If the posting is then refused (for example a duplicate),
the portfolio may already show the higher principal with no posting behind it. Detect, then correct only with CFO
approval:

```sql
-- READ ONLY, HEURISTIC (a starting list to review by hand, not proof): portfolios whose next Return date moved on
-- more than a cycle with no Return reservation behind it. Confirm each against the portfolio change log.
begin transaction read only;
select ip.id, ip.portfolio_code, ip.investment_amount, ip.next_roi_date
  from public.investor_portfolios ip
 where ip.next_roi_date > (now() at time zone 'Africa/Kampala')::date + 40   -- moved on more than one cycle
   and not exists (select 1 from public.portfolio_return_cycle_claims c
                    where c.portfolio_id = ip.id and c.status = 'active'
                      and c.cycle_month >= date_trunc('month', ip.next_roi_date - interval '2 months'));
rollback;
```

Recovery (not automated, needs CFO approval): put the principal and next Return date back to their values before the
failed attempt (from the portfolio change log), then compound again from the updated screen. The guard guarantees the
second attempt either posts once or is refused; it can never post twice for the month.

## 3. Historical compounds and splits without cycle keys

Not changed, not back-filled. The reservation check reads them:
* a Return posted in month M without a cycle key blocks a new Return for month M (reason `unkeyed_return_this_month`);
* `roi-cycle-<portfolio>-<date>` credits block their month (`already_paid`) and months within 20 days (`too_close_to_another_cycle`);
* months before 2026-08 always need an override (`before_reliable_history`).

This can refuse a legitimate payment (for example a compound for an October cycle posted late on 2 November blocks
November). That case is resolved with an override (section 4). It never lets a duplicate through for the patterns
seen in the 24 October audit.

## 4. CFO override — the approved workflow

Use only for an exceptional extra Return in a month that already has one (or is blocked for another reason).

1. **Decide.** The CFO approver confirms, outside the system, why the extra Return is owed (for example a missed May
   cycle evidenced by Proxy Agent statements).
2. **Authorise (pays nothing).** The CFO approver calls `authorise_return_cycle_override(portfolio, any date in the
   month, requester, reason)` (hook `useAuthoriseReturnCycleOverride`). Server checks: caller is the CFO approver
   (`is_cfo_approver`: the pinned CFO position or a pinned super admin); reason at least 20 characters; the named
   requester is Returns staff and is not the authoriser. Recorded in `portfolio_return_cycle_overrides` and
   `audit_logs` (`return_cycle_override_authorised`). Valid 24 hours.
3. **Request.** The named requester, and only them, requests the Return with `metadata.override_id` (payout) or
   `p_override_id` (compound/split). Server checks: override matches the portfolio and month, is not used, revoked or
   expired, the authoriser is still the CFO approver, the caller is the named requester, and the month really is
   blocked (otherwise "No override is needed" and the override is not used). The override is consumed (single use)
   and `return_cycle_override_used` is written to `audit_logs`.
4. **Approve.** The payout goes through the normal COO → CFO approval. An override can never be used at approval.
5. **Revoke** an unused override with `revoke_return_cycle_override` (CFO approver only; audited).

Review: `select * from portfolio_return_cycle_overrides order by authorised_at desc;` and
`select * from audit_logs where action_type like 'return_cycle_override_%' order by created_at desc;`

## 5. Direct-credit "ROI payout" option

`cfo-direct-credit` refuses a Return-coded credit with HTTP 422 `RETURN_CREDIT_NOT_ALLOWED_HERE` before writing
anything (no ledger row, SMS, idempotency row or schedule). The CFO screen shows the error; with several recipients
every one fails and the first error is shown; no standing order is created because that step runs only after a
successful payout. The ROI payout **queue** on the same screen is unaffected (it approves through
`approve-wallet-operation`). UI follow-up for Gemini: hide the direct "ROI payout" form and point to the Partners page.

## 6. Monitoring

```sql
begin transaction read only;
-- Reservations and what was posted under them, last 30 days
select c.cycle_month, c.kind, c.claim_seq, c.status, count(*) from portfolio_return_cycle_claims c
 where c.created_at > now() - interval '30 days' group by 1,2,3,4 order by 1 desc;
-- Two Return reservations for one portfolio and month (only possible with an override)
select portfolio_id, cycle_month, count(*) from portfolio_return_cycle_claims
 where status = 'active' group by 1,2 having count(*) > 1;
rollback;
```
Plus the existing duplicate monitor `get_duplicate_roi_credits__impl`.
