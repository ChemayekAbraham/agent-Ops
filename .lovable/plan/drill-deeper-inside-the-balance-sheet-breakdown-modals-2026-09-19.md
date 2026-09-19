# Drill deeper inside the Balance Sheet breakdown modals

Today the modal shows the balance, its components and which ledger accounts feed it. This adds a second level: tap a ledger account inside the modal and see the activity behind it.

## What changes on screen

Inside any breakdown modal, each ledger account line becomes tappable and expands to show:

- **By category** — every movement category feeding that account, with the number of entries and its net contribution (so the account balance is visibly made up of named categories).
- **Recent entries** — the latest individual records behind the account as at the selected date: date, category, where it came from, and amount.
- A short note when the account has activity older than the shown window, so nothing looks missing.

Loading and empty states are handled in place. Amounts stay in UGX with the existing formatting, and every figure continues to reconcile to the balance shown at the top of the modal.

## Why a backend addition is needed

The balance sheet is built from roughly 575,000 ledger entries. Sending them to the browser is not viable, so the grouping and the "latest entries" list must be computed on the server for the one account tapped.

## Technical detail

- New read-only, additive database function `public.get_sofp_account_detail(p_as_at timestamptz, p_account_code text, p_limit int default 50)` returning JSON: `{ account_code, net, categories[], transactions[], truncated }`.
  - Built on the existing `sofp_ledger_legs(p_as_at)` so it uses exactly the same account resolution, classification filter and sign convention as the balance sheet — no new accounting logic.
  - `SECURITY DEFINER`, `STABLE`, `SET search_path = public`, gated to finance/leadership roles (`cfo`, `ceo`, `coo`, `cto`, `manager`, `super_admin`) via `has_role`; `GRANT EXECUTE` to `authenticated` only.
  - No table, policy, trigger, wallet or ledger write of any kind.
- `src/components/cfo/BalanceSheetPanel.tsx`: each ledger-account row in `DrilldownDialog` becomes an expander that lazily calls the new function for the current as-at date and renders the category and entry lists. No change to the statement RPC, the classification helpers, the exports, or any figure already displayed.
