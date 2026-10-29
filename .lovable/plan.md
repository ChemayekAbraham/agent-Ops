[FRAUD-SWEEP-2026-10-29]

# Read-only fraud sweep: 28 Oct 08:00 to 29 Oct 08:00 EAT

Strictly read-only. Only SELECT queries. No file edits, no migrations, no write functions, no row changes. No keys, tokens or passwords in the output. Every time shown in EAT (UTC+3). Every row includes the exact UGX amount, the transaction ID or reference, phone numbers, tenant, agent and approver.

Query window (UTC): `>= '2026-10-28 05:00+00' AND < '2026-10-29 05:00+00'`

## 1. Landlord payouts
- Every payout in the window from `agent_landlord_payouts` and the landlord float allocations: landlord name, payout phone, landlord verified (yes/no), tenant flags (unverified, @noapp, no phone), agent, transaction ID, and whether a CFO approval or withdrawal-history row exists. Payouts with no CFO approval are flagged.
- Targeted checks: agent Ian Muhwezi (+256787725122), and recipients weyikilize Evalyn (0766305139), Namere Babra (0752559839), Mafabi Nasser (0750622590) and musawo (0705075331). Phone numbers are matched in all formats (07…, 2567…, +2567…).
- Payout phones shared by more than one landlord.
- Location clustering: tenants or landlords created in the window by the same agent at nearly the same spot (coordinates rounded to about 4 decimals, 3 or more records).

## 2. Money moved without proof
- Wallet transfers, withdrawals, deposits, float top-ups and requisitions in the window where the transaction ID is missing, appears more than once, or matches no MTN/Airtel/ledger record.
- Deposits and intakes approved by hand.
- Self-approvals, where the approver is also the requester or owns the cash.
- Receipts credited to deleted or inactive accounts.
- Operational Float credits that came from email receipts.
- Every action in the window by Nankambo sharimah (+256708269084), KATUSHABE GLORIOUS (+256705799857), Rachel Blessing Nabutiti and Joshua Wanda (+256704825473), taken from `audit_logs`, approval columns and the ledger's created-by field.

## 3. Held agents
- Ian Muhwezi (+256787725122, and alias Muhwezi Ian Martine +256742000365), Watsala Enock (+256750223152), and every other agent currently marked held or frozen.
- For each one: collections logged in the window (tenant, amount, transaction ID or "missing", time), any transfers, credits or float they received, and their current frozen or hold status.

## 4. Silent agents
- Agents whose last remittance was 3 or more days ago but who still hold cash or float: agent, phone, days silent and balance (read from the wallet balance summary).
- Named checks: Akampurira Onesmus, Nyanzi Lydia Eseri, Sharifu Kalule, James Katongole and Waswa.

## 5. Reassignments and new database objects
- Tenant-to-agent reassignments in the window (from the ops transfer function, the tenant-agent linker, or direct agent changes in audit and history tables): who did it, and whether a matching audit-log row exists.
- Public tables and functions created in the window, taken from the migration history (`supabase_migrations.schema_migrations`) and the database catalogue (`pg_catalog`), with their names.

## Output
A short list of facts for each section, or "none" where nothing happened in the window. No fixes are proposed or made.

## Technical notes
- Before querying, check the real column names on the live database (`information_schema.columns`), because the migration files don't always match production.
- Use parallel read-only queries, each with a time limit and a LIMIT.
