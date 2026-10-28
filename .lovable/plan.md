# Bike-first daily recovery waterfall

## Requested outcome
When an agent has both an active electric bike lease and a running Agent Advance, collect the bike’s required daily payment first. Only earnings left after that daily quota is fully paid may go to the advance. Keep both contracts, fee schedules and accounts separate.

## Recovery changes
- Use the existing recorded bike schedule and Kampala calendar day to determine today’s quota, subtracting payments already recorded today. Do not use the example UGX 3,917 as a fixed rate.
- Enforce bike-first collection across scheduled advance deductions, the advance recovery sweep and immediate recovery from new earnings—not just by changing job times.
- If earnings cannot cover the full bike quota, collect the available amount for the bike and leave advance recovery at zero. Later earnings may finish the same quota without collecting it twice.
- Once the bike quota is satisfied, apply only surplus to the advance under its existing repayment schedule and outstanding-balance limit. Stop advance deductions when it is cleared.
- Preserve existing bike arrears/catch-up rules separately from the daily priority; ensure catch-up cannot consume the surplus promised to advance recovery when both products are active.
- Preserve repayment pauses, release/eligibility checks, strict available-balance checks, prepaid installments and separate Returns-based advance recovery.
- Do not merge balances, rewrite historical payments, amend contracts or add fees.

## Operations display
- Replace the collision warning with “Waterfall Recovery Protected” only after server-side enforcement is active and confirmed.
- Explain the order: Priority 1 — bike daily payment; Priority 2 — running advance from surplus.
- Show actual recorded amounts and outstanding balances in the relevant approval/detail and agent repayment views; show unavailable if the authoritative read fails.
- Keep other approval actions and screens unchanged.

## Safety and verification
- Add focused tests for insufficient earnings, exact bike quota, surplus, repeat runs, concurrent earning/scheduled recovery, quota already paid, cleared advances, multiple leases and paused/ineligible leases.
- Example assertions: with a UGX 3,917 quota, UGX 2,000 pays only the bike; UGX 3,917 leaves zero for the advance; UGX 5,000 leaves at most UGX 1,083 for the advance.
- Verify both products retain their existing ledger categories and principal/fee allocation, with balanced entries and no float deductions.
- Run relevant tests and project safety guards. Verify on isolated test records, not real agents’ balances.
- Apply the database migration through the approval workflow and deploy only affected recovery functions as needed; do not publish the frontend automatically.
- Report any live verification blockers rather than claiming guaranteed protection.

## Technical approach
- Base function changes on inspected live definitions, not unapplied repository migrations.
- Introduce one server-owned per-agent daily-priority coordinator shared by all automatic commission-recovery paths, using consistent per-agent locking, fresh row reads and durable idempotency.
- Keep money movement inside existing authorized ledger-posting functions; no browser balance calculations or wallet writes.
- Provide a caller-checked read for the protection state and recovery breakdown, with explicit function grants.
- Reuse existing treasury kill switches and maintain authorization/MFA restrictions. No new recurring polling jobs are required.
- The preview currently has an unrelated CFO error involving an undefined `setSpecialAdvanceOpen` callback; resolve only the minimal wiring needed to restore compilation, without changing payment behavior.