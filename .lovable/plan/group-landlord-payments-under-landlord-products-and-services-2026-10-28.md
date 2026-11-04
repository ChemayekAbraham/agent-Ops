# Group landlord payments under Landlord Products and Services

## Requested result
Move the payments currently shown in the separate **Landlord Float** category into **Landlord Products and Services** in Money Out. Do not merely rename a second tile.

## Confirmed amounts
Read-only reconciliation for all time through 28 October 2026 matches the selected tile:
- Landlord Float: **3,242 transactions / UGX 1,377,194,147**.
- Existing Landlord Products and Services: **108 transactions / UGX 74,226,000**.
- Combined category: **3,350 transactions / UGX 1,451,420,147**.

The grand total and total transaction count must remain unchanged.

## Changes
- Update the single reporting classification so those existing landlord float payment types resolve to the existing landlord products category.
- Remove the separate Landlord Float tile from the server's breakdown. Keep Landlord Products and Services as the sole combined category in tiles, transaction rows and category filtering.
- Preserve all other categories, payment inclusion rules, dates, permissions, lunch allowance safeguards and pagination.
- Add regression coverage for all four moved payment types and unchanged total/count; run the existing Money Out tests and project guards.
- After applying the reporting-only migration, run read-only reconciliation and verify the combined category and filtering on the signed-in Money Out page if an authorized session is available.

## Safety
No ledger entries, accounting accounts, wallets, balances, payment records or HR data will be changed. No accounting correction will be posted. No app or edge function will be published or deployed.

## Technical details
Use a migration based on the inspected live definitions of `_cfo_paid_category_for`, `get_cfo_paid_by_category_totals` and `get_cfo_paid_by_category_page`. Map `rent_disbursement`, `landlord_pool_deploy_company_managed`, `landlord_pool_release_company_managed` and `landlord_pool_release_self_support` to `landlord`. Keep the browser displaying server-owned categories; do not introduce a client-side mapping. Preserve current function grants and role checks.