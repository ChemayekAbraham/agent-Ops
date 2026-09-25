# 135: Merchant desk funding tracker (what the company gives vs. what the desk uses)

**Built and applied live 2026-09-25.** Migration `20260925160000_merchant_desk_funding_tracker.sql`
was applied via query_database, and cron `suggest-merchant-desk-external-funding-15m` (job 41661) is
scheduled. This follows up doc 134. Read it before answering "how much has the company given
Immaculate / any desk" or "how much is she out of pocket".

## What it answers

For each merchant desk and each day, plus an "ALL DESKS" combined row:

| Column | Meaning | Source |
|---|---|---|
| `given_ledger` | float the company credited in the system | `agent_float_deposit` / `agent_float_assignment` cash_in, float bucket |
| `given_external_confirmed` | treasury money sent to the desk's payout bank account **outside the ledger**, confirmed by Finance | `merchant_desk_external_funding` status `confirmed` |
| `given_external_suggested` | the same, auto-matched from provider emails but not yet confirmed | status `suggested` |
| `taken_back` | float removed: corrections down, moved to other desks, moved to her wallet | float-bucket cash_out legs except `agent_float_settlement` |
| `used` | every completed payout the desk made (principal + telecom), MoMo and bank | `merchant_payout_funding` joined to `withdrawal_requests` |
| `running_*` | cumulative given − taken back − used, anchored at 0 on 2026-09-01 (the 08-31 fresh start) | |
| `oop_outstanding_*` | `max(0, −running)`: her own money currently fronted | |

Both `running` columns are returned: one counting only confirmed external funding, and one also
counting the suggested rows. The truth lies between them until Finance works through the
suggestions. When funding arrives while `running` is negative, it covers her out-of-pocket first.

Nothing here posts to the ledger or moves a wallet balance.

## Objects

- `merchant_desk_external_funding`: the register of off-ledger funding. `gmail_transaction_id` is
  unique, so a provider email is never counted twice.
- `merchant_desk_funding_rules`: per-desk matching rules (`equity_outgoing_to_account` with a body
  regex, or `mtn_to_equity`).
- `suggest_merchant_desk_external_funding()`: applies the rules and runs every 15 minutes
  (service_role only).
- `record_merchant_desk_external_funding(agent, amount, funded_at, channel, reference, note)`: Finance
  adds a confirmed row by hand, for example cash or an account that has no rule.
- `decide_merchant_desk_external_funding(id, 'confirmed'|'rejected'|'suggested', note)`.
- `get_merchant_desk_funding_tracker(agent_ids uuid[], from date = 2026-09-01, to date = today)`.
- Access: cfo, financial_ops, super_admin, ceo, coo, manager (`is_merchant_funding_reviewer`).

## Seeded for Immaculate Namulindwa

- Desk A `27d5a08b…` (Airtel, "Merchant Agent") has no rules; it is ledger-only.
- Desk B `1a88b1b8…` (BAITA, bank payouts) has two rules:
  1. Bayo Mercy Equity …7542 → **NABAGGALA CATHERINE …9292**.
  2. Company MTN line → **EQUITY BANK LIMITED**.

  These produced 54 suggested rows (UGX 573.3M from 1–24 Sep, plus 8M on 25 Sep).

## 1–24 Sep result

| | Desk A | Desk B (BAITA) | Both |
|---|---|---|---|
| Given in system | 26,000,000 | 248,204,619 | 274,204,619 |
| Given outside system (suggested) | 0 | 573,263,706 | 573,263,706 |
| Taken back | 26,008,973 | 116,964,897 | 142,973,870 |
| Used (347 payouts, 607.0M of them bank) | 0 | 614,014,720 | 614,014,720 |
| **End position, confirmed only** | −8,973 | **−482,774,998** | −482,783,971 |
| **End position, incl. suggested** | −8,973 | **+90,488,708** | +90,479,735 |

Reading it: if every suggested transfer really funded BAITA, the desk still holds about UGX 90.5M of
company money. It was only out of pocket from 8 to 12 Sep, peaking at 82.4M. If none of them did,
she has fronted 482.8M, which contradicts the CFO's position. Finance must go through the 54
suggestions.

## Known traps for whoever confirms suggestions

- **Double counting.** Some treasury bank funding was *also* recorded as a ledger float
  reconciliation. For example, 11 Sep 20,189,508 was "90M sent to Mercy's personal Equity account
  was never system-recorded". Reject the external row whenever the same money is already in
  `given_ledger`.
- The MTN→Equity SMS never names the destination account. Some of those transfers may have funded
  something other than BAITA.
- The link between account …9292 and BAITA is inferred from same-day timing, not proven.
- `taken_back` on 8 Sep (80,181,124) is an operator "set float to 10M" correction. Absolute
  "set to" corrections can hide spent float ([[project_float_set_to_vs_add_overcredit]]).

## Not done

- **No UI.** This is Gemini's lane. A FinOps panel should call the tracker for a chosen desk (or
  both of Immaculate's), show the daily table with both running columns, and list `suggested` rows
  with Confirm / Reject buttons calling `decide_merchant_desk_external_funding`.
- `types.ts` is not regenerated for the new tables. Lovable regenerates it on its next sync.
