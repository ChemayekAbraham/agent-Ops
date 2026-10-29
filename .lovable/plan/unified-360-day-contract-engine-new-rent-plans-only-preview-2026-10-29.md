# Unified 360-Day Contract Engine (new Rent Plans only, preview only)

## Blocking questions (please answer before build)

1. **Formula vs example disagree.** As written, `max(3500*m, 0.025*m*P)` gives P=100000, m=1: (115000 + 3500) / 0.83 = **142,771**, daily **4,760**. The acceptance figure 141,567 / 4,719 only works with the Rail bucket `max(2500*m, 0.025*m*P)`: (115000 + 2500) / 0.83 = 141,567. Which floor is correct, 2500 or 3500?
2. **Bucket split does not add up for m=1.** At P=100000, G=141,567: Landlord 100,000 + Partner 15,000 + Agent 14,157 + Rail 2,500 + Welile 7% 9,910 = 141,567 only with the 2500 floor. Confirm Welile is the residual, not a fixed 7%.
3. **"Guaranteed" Partner returns.** A promise of 15% every month regardless of collections is a guaranteed return. CFO/compliance sign-off needed on the wording; copy will say "Returns" and "Rent Plan", never "interest" or "loan".
4. **Buffer funding source.** Which account funds A_buffer on a short Day 30 (new ledger account, Welile 7% retained, or Partner pool)? Without a named source, the Day-30 job cannot post a balanced entry.
5. **Migrations.** You asked for reviewable files, not applied. They will go in `docs/pending-migrations/` (the project's rule for unapplied proposals), not run against the database. That means no preview screen can show real engine numbers until you approve applying them. OK?

## What gets built once answered

- **Pricing (A, G):** one pure engine `src/lib/contractEngine360.ts` (G_m, DailyRate, 5 buckets, R_360, T_end) with unit tests for every acceptance case. New quotes use it when `pricing_version = 'v360'`; existing plans keep their current pricing. Nexa/sales examples updated for new quotes only.
- **SQL proposal (B, C, D):** `pricing_version`, `vacant_days`, `missed_days`, `maturity_on` on rent requests; `compute_rent_repayment_v360`; one atomic daily waterfall `post_v360_daily_waterfall` (Partner escrow, Landlord principal, Rail, Agent 10% on cash, Welile residual) with no blanket exception swallowing; activation creating the 12-month Partner and Landlord schedules and the 360-day receivable; buffer accounts and a Day-30 job. Old waterfalls untouched for old plans.
- **Agent actions (E):** Mark Vacant / missed roll-forward / Guest Tenant wired to existing buttons through new RPCs, no layout change.
- **Dashboards (F):** data bindings and captions only (15%/mo x 12, DailyRate, remaining receivable, V/M roll-forward, buffer status), plus Operating Unit tags. Financial statement RPC changes stay in the proposal file.
- **Deliverable:** CHANGELOG of files and the pending SQL. Nothing published.
