# 254 — Clear Nakitende Jumeirah's 336,000 plan balance (Gven advance)

**Date:** 2026-11-02 · **Approved by:** CFO Sarah Angwen (`29a0cfa8-1eaf-453c-874c-0fc72fa4f74b`) · **Status:** migration written, NOT yet run

## What happened
Agent GVEN AKANDWANAHO collected Nakitende Jumeirah's rent and did not remit it. The shortfall was moved onto Gven as a 300,000 advance top-up (advance `d0c44c3c-05b6-4994-acde-ade82e467c6c`, 2026-10-28 08:17 UTC, by Bayo Mercy). The company recovers it from Gven's wallet (16,417/day), so the tenant must not owe it too.

## Plan cleared
`rent_requests` `406ed7bc-e837-4617-9110-cabb4b84313b` (tenant `51d99b2c-…`): total 552,000, repaid 216,000, **336,000 waived**.
The top-up (300,000) is 36,000 less than the waived balance; that 36,000 is absorbed by the company on the CFO's instruction.

## Migration
`supabase/migrations/20261102120000_clear_nakitende_jumeirah_plan_406ed7bc_against_gven_advance.sql` (rollback alongside).
- Sets `status='completed'`; `amount_repaid` stays 216,000 (no fake receipt, commission or streak credit).
- Not `cancelled`: that unwinds landlord float and fee recognition.
- No ledger legs; audit_logs row `rent_plan_balance_waived_agent_advance` under Sarah's id.
- Checks Sarah holds `cfo`; aborts if the plan is not exactly repaying / 552,000 / 216,000; idempotent.

## Verify after running
`select status, amount_repaid from rent_requests where id='406ed7bc-…'` → completed, 216000; `v_rent_plan_arrears` owed_ugx = 0; one audit_logs row.
