# Phone repayers in Agents' Space: repayment journey, deposit and Returns pledge

## What users will get

1. **Automatic access.** Anyone with a released phone that still has money owing can open Agents' Space from the profile menu. They don't need to be whitelisted. Access ends when the phone is fully paid. Their view only shows the phone section. They don't see the requisition or whitelist tools that executives and Special Agents see.

2. **"My phone repayment" section** at the top of Agents' Space, with large, plain figures:
   - Total to repay, already paid, and still owed
   - This month's amount and today's daily amount, plus a note that both go down each month
   - A progress bar and a pie chart (paid vs still owed), each showing the percentage
   - A month-by-month list with amount due, daily amount and status (paid / this month / coming)
   - Next deduction date, and the end of the 7-day grace period if they are still in it

3. **Deposit button.** It opens the app's usual deposit screen. The money lands in the wallet, and the normal daily phone deduction takes it from there. A short line explains: "Money you deposit is used for your daily phone payment."

4. **Returns pledge** (only shown if the user has an active supporter portfolio):
   - Choose a fixed amount or a percentage of each monthly Returns payment to put toward the phone
   - The screen shows the current pledge, its effect on the next Returns payment, and lets them change or turn it off
   - When monthly Returns reach the wallet, the pledged part goes to the phone straight away. It never takes more than the phone still owes, and the rest stays in the wallet.
   - Each pledge payment appears in their phone repayment history as "From monthly Returns"

## Rules kept
- No money moves from the screen itself. The deposit uses the existing deposit flow, and pledge payments run through the backend at the moment Returns are credited.
- Pledge payments only come from the Returns just credited, out of the withdrawable balance. They never touch operational float.
- If a Returns payment is reinvested instead of paid to the wallet, or the phone is fully paid, nothing is taken.

## Technical details
- Access: a `has_active_smartphone_plan(uid)` backend check on `merchandise_sales` (`customer_id`, smartphone item, `cfo_disbursed_at` set, `amount_outstanding > 0`, not settled). `AgentsSpace.tsx` and the `DashboardHeader` `canAccessAgentsSpace` flag accept it. A phone-only user gets the new `SmartphoneJourneyCard`, and `AgentsSpacePanel` stays limited to executives and Special Agents.
- Journey data: a read RPC `get_my_smartphone_journey()` that returns the sale, totals and the rows from `smartphone_repayment_schedules`, with a fallback to `smartphoneReducingSchedule()` for older plans. The charts use recharts (bar and pie).
- Pledge: a new `smartphone_roi_pledges` table (user_id, sale_id, mode amount|percent, value, active, timestamps) with RLS so owners read their own rows. Writes go only through `set_smartphone_roi_pledge` (SECURITY DEFINER, validated: percent 1–100, amount > 0). An append-only `smartphone_roi_pledge_applications` log is idempotent per ROI payment.
- Apply: `apply_smartphone_roi_pledge(user, roi_amount, reference)` (SECURITY DEFINER) takes `LEAST(pledge, roi_amount, outstanding, available withdrawable)` and posts it through the same balanced wallet-to-merchandise repayment legs that `recover_merchandise_from_wallets` uses. It updates `amount_paid`/`amount_outstanding`, logs the application and emits a `system_events` row. `process-supporter-roi` calls it right after the `roi_wallet_credit` succeeds, never on the auto-reinvest path. A failure there is logged and doesn't block the Returns credit.
- Before writing, I'll check the live schema (the smartphone schedule table, the repayment ledger categories in `recover_merchandise_from_wallets`), then run `npm run guard:all`, the typecheck and tests, and a preview check signed in as a phone repayer.
