# Smartphone repayment: reducing-balance, 28% monthly

Replace the current fixed markup grid (+33% / +36% / +39% / +42% for 3 / 6 / 9 / 12 months) with a reducing-balance schedule.

## The new rule

- Monthly principal = device amount ÷ number of months (equal each month)
- Monthly charge = 28% of the **opening outstanding principal** for that month
- Monthly amount due = monthly principal + monthly charge
- Daily wallet deduction = that month's amount due ÷ number of days in that repayment month

Because the charge follows the shrinking principal, the monthly amount and the daily deduction both fall over the life of the plan.

Example — UGX 100,000 over 3 months:

```text
Month  Opening    Principal   Charge 28%   Month due   Daily (30 days)
1      100,000     33,333       28,000       61,333        2,045
2       66,667     33,333       18,667       52,000        1,734
3       33,333     33,334        9,333       42,667        1,423
Total              100,000       56,000      156,000
```

## What the agent sees

- The application screen shows, per period, the first month's daily amount, that it reduces each month, and the total repayable.
- A small schedule table on the application and on the order status screen: month, amount due, daily amount — so nobody is surprised when the figure changes.
- The 28% rate stays internal, shown to Agent Ops only, as today.

## What changes for Agent Ops and COO

- The approval screen currently reprices every application at a flat 33% regardless of the chosen period. It will use the same reducing-balance schedule instead, so an approval never silently changes the price.
- If Agent Ops edits the device amount or the period on approval, the whole schedule is rebuilt from the new figures.

## Scope decisions

- Applies to **new applications only**. Phones already released keep the terms their agent agreed to; nothing already in repayment is repriced.
- Grace period (7 days after release), the UGX 50,000 monthly late charge, and the wallet deduction mechanism are unchanged.
- The iPhone / Mo Banja arrangement is unchanged: the amount Welile finances is still the down payment, and the agent still pays Mo Banja weekly outside the app.

## Technical outline

1. **Shared schedule maths** in `src/lib/smartphoneAdvance.ts`: keep `SMARTPHONE_PERIODS`, replace `SMARTPHONE_INTERNAL_MARKUP` with a single `SMARTPHONE_MONTHLY_CHARGE_PCT = 28`, and add `smartphoneReducingSchedule(amount, months, startDate)` returning per-month rows (opening principal, principal, charge, due, period start/end, days in that month, daily) plus a total. Keep `smartphoneSchedule()` as a thin wrapper returning first-month daily + total so existing call sites keep compiling.

2. **Database mirror** (one migration):
   - `smartphone_monthly_charge_pct()` returning 28; `smartphone_reducing_schedule(p_amount numeric, p_months int, p_start date)` returning the same rows as a table function.
   - New table `smartphone_repayment_schedules` (sale_id, month_index, period_start, period_end, days_in_period, opening_principal, principal_due, charge_due, total_due, daily_deduction) with grants + RLS: owner reads own rows, agent-ops/COO/CFO/finance read all, writes only via the definer functions.
   - `agent_order_smartphone` and `smartphone_apply_review_terms`: drop `smartphone_period_markup`, compute `total_repayable` from the reducing schedule, store the first month's daily in `access_daily_amount`, and rebuild the schedule rows for the sale. `smartphone_period_markup` stays in place unused (nothing is dropped).
   - `cfo_disburse_smartphone_order`: anchor the schedule dates to the release date + 7-day grace when it disburses.
   - `recover_merchandise_from_wallets`: for smartphone plans, take the daily amount from the schedule row covering today instead of the fixed `daily_deduction_amount`; every other merchandise type keeps its current behaviour.

3. **UI**: `SmartphoneOrderDialog` shows first-month daily + total + the reducing schedule; `SmartphoneOrderStatus` shows the current month's daily and remaining months; `SmartphoneCatalogDialog` ops grid and `SmartphoneOrderApprovalQueue` show the reducing figures instead of `+markupPct`.

4. Also fix, while in the same flow: the **Full payment** option currently submits with no repayment period and fails — it will submit as a full-payment order with no schedule.

Guards, typecheck and build run before finishing. No `hr_pay_*`, wallet-bucket or ledger-writer changes; all money movement stays inside the existing definer functions.
