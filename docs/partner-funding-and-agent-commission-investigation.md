# Investigation — Automatic agent commissions & Partner Funding ledger legs

Date: 2026-08-04 · Read-only investigation. No code or data was changed.
Data source: `general_ledger` (all classifications), plus `pg_proc` / `pg_trigger` and `supabase/functions/`.

---

## 1. Executive answer

**Nothing rogue is running.** Both flows are driven by known, named writers.

- **Partner Funding** (`category = 'partner_funding'`) is a *wallet → company* movement, so the
  **wallet leg is a debit by design**. 362 users have been debited. The 31 users who show a
  **credit** on the same category are not an extra payment: every credit is a **refund, cancellation,
  reversal, or a legacy April leg** — i.e. money going *back* to the wallet.
- **Automatic agent commissions** are written by **DB triggers + RPCs on real business events**
  (verified listing, verified landlord, verified LC1, rent collection, withdrawal, listing bonus).
  There is no unattributed "mystery" crediting process.
- Two genuine issues worth attention are listed in §5: **legacy April `partner_funding` credits with
  the wrong sign semantics**, and **UGX 876.5M of manual CFO credits filed under
  `agent_commission_earned`**, which inflates every "commission earned" figure.

---

## 2. Partner Funding — who triggers it

| Writer | Type | Notes |
| --- | --- | --- |
| `enforce_portfolio_funding_at_creation` | **DB trigger** on `investor_portfolios` | Posts the funding legs automatically when a portfolio is created/funded. Hardened 2026-08-04 with a ±30-minute duplicate guard. |
| `partner_self_confirm_commitment` | RPC | Self-managed partner funding commitments. |
| `agent_deposit_to_partner` | RPC | Agent deposits on a partner's behalf. |
| Edge functions | server | `coo-invest-for-partner`, `coo-create-portfolio`, `coo-wallet-to-portfolio`, `agent-invest-for-partner`, `create-investor-portfolio`, `approve-portfolio-topup`, `manager-portfolio-topup`, `approve-pending-portfolio`, `merge-pending-topups`, `cancel-pending-topups`, `portfolio-topup-row-action`, `approve-wallet-operation`, `fund-rent-pool`, `process-supporter-roi`, `process-promissory-deductions`. |
| `auto_assign_ledger_scope` | DB trigger on `general_ledger` | Does not create legs — only stamps `ledger_scope`. |

### Volume by leg (all time, 2026-04-10 → 2026-08-04)

| scope | direction | rows | distinct users | total UGX |
| --- | --- | --- | --- | --- |
| platform | cash_in | 1,168 | 306 | 5,694,963,507 |
| wallet | cash_out | 936 | 319 | 2,421,739,062 |
| wallet (withdrawable) | cash_out | 150 | 99 | 422,939,537 |
| platform | cash_out | 80 | 26 | 246,341,959 |
| wallet | cash_in | 71 | 21 | 146,917,000 |
| wallet (withdrawable) | cash_in | 21 | 12 | 52,769,356 |
| bridge | cash_in | 9 | 8 | 53,461,603 |

### How many users, debited vs credited (wallet scope only)

| | users |
| --- | --- |
| Debited (`cash_out`) | **362** |
| Credited (`cash_in`) | **31** |
| Both debited and credited | **28** |

The 28 overlap is the expected pattern: the wallet was debited when capital was committed, then
credited again when that same commitment was cancelled, refunded, or corrected.

### Why some users are credited — full breakdown of all 92 credit legs

| Reason | rows | users | UGX | Verdict |
| --- | --- | --- | --- | --- |
| `Refund of cancelled top-up …` (`cancel-pending-topups`) | 47 | 11 | 34,447,000 | Correct — parked capital released back to the wallet. |
| `Refund portfolio … reverted to awaiting payment` | 1 | 1 | 50,000,000 | Correct — PAMELA SSAKA, portfolio reverted. |
| `Reverse admin_correction annotation for portfolio …` (2026-07-27) | 20 | 10 | 102,619,356 | Correct — `admin_correction` classification, CFO clean-up, not real money. |
| `Reversal of duplicate portfolio funding deduction` (2026-08-04) | 2 | 2 | 150,000 | Correct — the WPF-2116 / WPF-4866 double-debit fix. |
| `N pending top-up(s) applied to …` | **25** | **9** | **10,470,000** | **Legacy defect — see §5.1.** All 25 rows are April 2026 only. |

Largest credited accounts: PAMELA SSAKA (144,800,000 over 7 legs), Violet Namata (17,000,000),
NASSAKA BIBIAN (5,200,000), ANGEL NAKAYIZA KIRUNDA (5,000,000), Atoo Joyce (5,000,000).
High-frequency but small: Magosha Allan (32 legs / 640,000 — repeated ACC1 top-up cancellations),
NAMAYANJA IMMECULATE (13 legs / 2,680,000 — the April top-up-applied defect).

### Debit legs by source

| source_table | rows | users | UGX |
| --- | --- | --- | --- |
| `investor_portfolios` | 746 | 272 | 1,656,129,866 |
| `wallets` | 303 | 138 | 1,180,489,375 |
| `opportunity_summaries` | 37 | 22 | 8,059,358 |

---

## 3. Automatic agent commissions — who triggers them

All automatic commission credits come from these writers. Every one is event-driven; none is a
blind scheduled sweep over all users.

| Writer | Type | Fires on |
| --- | --- | --- |
| `pay_agent_house_verified_bonus` | trigger `trg_pay_agent_house_verified_bonus` on `house_listings` | House listing verified |
| `pay_landlord_registration_verified_bonus` | trigger on `landlords` | Landlord verified |
| `pay_agent_listing_bonus` | trigger `trg_pay_listing_bonus` on `landlords` | Listing bonus |
| `pay_lc1_registration_verified_bonus` | trigger on `lc1_chairpersons` | LC1 chairperson verified |
| `credit_agent_rent_commission` | RPC | Rent collection / allocation (10%) |
| `agent_allocate_tenant_payment_internal` | RPC | Per-tenant float allocation commission |
| `credit_agent_event_bonus`, `credit_recruiter_override` | RPC | Placement bonus, recruiter override |
| `log_agent_earning_to_ledger` + `sync_agent_wallet_on_earning` | triggers on `agent_earnings` | Mirror earnings into the ledger/wallet |
| `log_agent_payout_to_ledger` | trigger on `agent_commission_payouts` | Commission payout |
| `post_landlord_payout_finops_commission` | trigger on `landlord_payouts` | FinOps commission on payout |
| `notify_agent_commission_paid` | trigger on `general_ledger` | SMS/notification only — writes no money |
| `tg_recover_advance_arrears_on_earning` | trigger on `general_ledger` | Clawback of advance arrears from new earnings |
| `enforce_no_fraud_wallet_earnings` | trigger on `general_ledger` | Blocks earnings on flagged accounts |

CTO switch `auto_commissions` ("Automatically credit agent commissions as transactions settle")
in `PlatformControlsPanel` is the master toggle over this behaviour.

### Commission volume by category

| category | direction | scope | rows | users | UGX |
| --- | --- | --- | --- | --- | --- |
| `agent_commission` | cash_in | wallet | 57,646 | 672 | 115,951,608 |
| `agent_commission_earned` | cash_in | wallet | 39,151 | 487 | 1,133,248,158 |
| `agent_commission_earned` | cash_out | platform | 30,592 | 54 | 1,027,470,026 |
| `agent_commission_payable` | cash_out | platform | 7,305 | 42 | 19,859,799 |
| `agent_commission` | bridge (both) | bridge | 2,363 | — | pre-April legacy |
| others (`proxy_investment_commission`, `agent_commission_withdrawal`, …) | — | — | <70 | — | small |

### Commission credits by originating source

| source_table | rows | users | UGX |
| --- | --- | --- | --- |
| `house_listings` | 40,548 | 602 | 61,244,000 |
| `agent_earnings` | 20,409 | 104 | 21,689,000 |
| `lc1_chairpersons` | 8,923 | 266 | 8,947,000 |
| `agent_collections` | 8,345 | 44 | 19,936,345 |
| `listing_bonus_approvals` | 4,236 | 189 | 16,156,000 |
| `landlords` | 4,186 | 218 | 17,026,000 |
| `withdrawal_requests` | 3,821 | 13 | 3,903,689 |
| `commission_engine` | 3,386 | 114 | 25,912,000 |
| `rent_requests` | 1,401 | 50 | 6,794,003 |
| **`cfo_direct_credit`** | **648** | **223** | **876,542,965** |
| `commission_accrual_ledger` | 468 | 71 | 1,152,000 |
| `landlord_payouts` | 300 | 30 | 1,379,150 |
| `phantom_wallet_backfill_v3` | 18 | 18 | 101,837,913 |
| `ledger_transaction`, `angel_pool_investments`, others | <80 | — | — |

---

## 4. Direct answer to the question asked

- **What/who triggers it:** named DB triggers and RPCs listed above, plus COO/CFO/Manager-invoked
  edge functions. No cron job blind-credits or blind-debits either category.
- **How many users got Partner Funding:** 362 debited, 31 credited, 28 both.
- **Why most are debited and some credited:** `partner_funding` moves money *out of* the wallet
  *into* company capital, so debit is the normal leg. Credits are the reverse direction — refunds,
  cancellations, and corrections — plus 25 legacy April rows with the wrong sign.

---

## 5. Issues found (not fixed — awaiting your decision)

### 5.1 Legacy `partner_funding` credits from "pending top-up applied" — 25 rows, 9 users, UGX 10,470,000
"Applying" a parked top-up activates capital *inside* the portfolio. It should not put money back
into the wallet, yet these legs are wallet `cash_in`. All 25 rows are dated **April 2026 only**, and
no current code path produces this description, so the defect is already gone — but the rows are
still inflating those 9 partners' wallet ledger. The strict withdrawable rule caps what they can
actually withdraw, so exposure is limited to display, not cash.
Suggested action: reclassify the 25 rows to `admin_correction`, or post balanced reversing legs.

### 5.2 `cfo_direct_credit` filed as `agent_commission_earned` — 648 rows, 223 users, UGX 876,542,965
This is **75% of the entire `agent_commission_earned` wallet total** and is not commission at all —
it is manual CFO Direct Credit. Any "commission earned" report, agent leaderboard, or limit-engine
input that sums this category is overstated by that amount.
Suggested action: give CFO Direct Credit its own category (or set `sub_category='cfo_direct_credit'`
and exclude it from commission aggregates).

### 5.3 `phantom_wallet_backfill_v3` under commission — 18 rows, 18 users, UGX 101,837,913
Same class of problem: a backfill filed as commission.

### 5.4 Duplicate-posting pattern is now guarded, but only for portfolios
The WPF-2116 double debit was caused by the DB trigger and the app path posting the same funding
98ms apart. The ±30-minute guard added to `enforce_portfolio_funding_at_creation` closes that gap.
The same "trigger + app both post" shape exists in the commission writers
(`agent_earnings` triggers plus RPCs that also post legs) and has not been audited for duplicates.
