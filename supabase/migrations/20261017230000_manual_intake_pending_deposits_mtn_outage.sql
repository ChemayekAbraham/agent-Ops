-- Manual intake of MoMo payments lost to the MTN SMS feed outage of 2026-10-17.
--
-- The MTN IFTTT feed stopped forwarding at ~09:34 EAT on 2026-10-17 (the SIM
-- left the forwarding phone), so none of the payments below reached
-- gmail_transactions. Each TID was supplied by the payer / agent as a payer-side
-- "You have paid WELILE TECHNOLOGIES LIMITED 090777 ..." SMS.
--
-- WHAT THIS DOES: inserts one PENDING deposit_requests row per payment. It moves
-- no money. A manager then approves each row in Financial Ops, which runs the
-- normal approve-deposit path:
--   * agents    -> credit lands in operational float (float-by-default routing)
--   * tenants   -> credit lands in float, then trg_tenant_self_repayment_on_approval
--                  runs settle_tenant_rent_from_deposit and reduces the Rent Plan.
-- Going through a pending row (not a hand-written ledger post) keeps the TID
-- guards (trg_enforce_unique_deposit_tid, trg_guard_deposit_reference_uniqueness),
-- the idempotency check in approve-deposit, receipts/SMS and the audit trail.
--
-- BEFORE APPROVING: confirm each TID and amount on the MTN till (090777)
-- statement. These rows rest on payer-side screenshots only.
--
-- Idempotent: a payment is skipped when its TID already has a non-rejected
-- deposit request or is already in ledger_reconciled_tids, or when the profile
-- phone does not match the expected payer. Re-running inserts nothing new.
--
-- NOT INCLUDED: TID 44313474818 (DERRICK LUTAMAGUZI, 92d867f6-...): the amount
-- on the screenshot was cut off ("...21,000"). Add it in a follow-up once the
-- full amount is confirmed.

DO $$
DECLARE
  r record;
  v_phone text;
  v_inserted int := 0;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- tenants: self-repayment towards their own Rent Plan
      ('7702570a-6705-499c-8b45-a9a79fa43283'::uuid, '765210766', '44295920306', 16500::numeric, 'personal_rent_repayment'::public.deposit_purpose),
      ('7702570a-6705-499c-8b45-a9a79fa43283'::uuid, '765210766', '44311458825',  5000::numeric, 'personal_rent_repayment'::public.deposit_purpose),
      ('15b1e5ee-8768-4cc7-ac64-4331425d3586'::uuid, '791135531', '44301761914',  5000::numeric, 'personal_rent_repayment'::public.deposit_purpose),
      -- agents: operational float top-ups
      ('6aac6c81-b0f8-45eb-a67b-6483e7dcf82f'::uuid, '776368807', '44308696961', 22800::numeric, 'operational_float'::public.deposit_purpose),
      ('34f9591f-47fb-4d51-9104-9d821247ebb6'::uuid, '792790529', '44312707356', 86000::numeric, 'operational_float'::public.deposit_purpose)
    ) AS t(user_id, phone_last9, tid, amount, purpose)
  LOOP
    SELECT right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 9)
      INTO v_phone
      FROM public.profiles p
     WHERE p.id = r.user_id;

    IF v_phone IS DISTINCT FROM r.phone_last9 THEN
      RAISE NOTICE 'skip TID %: profile % missing or phone mismatch', r.tid, r.user_id;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.deposit_requests d
       WHERE lower(btrim(d.transaction_id)) = r.tid
         AND d.status NOT IN ('rejected', 'cancelled', 'failed')
    ) OR EXISTS (
      SELECT 1 FROM public.ledger_reconciled_tids l
       WHERE l.tid_normalized = r.tid
    ) THEN
      RAISE NOTICE 'skip TID %: already recorded', r.tid;
      CONTINUE;
    END IF;

    INSERT INTO public.deposit_requests (
      user_id, amount, status, provider, transaction_id, deposit_purpose, notes
    ) VALUES (
      r.user_id, r.amount, 'pending', 'mtn', r.tid, r.purpose,
      'Manual intake 2026-10-17: MTN SMS feed outage, payer-side SMS. Verify TID on till 090777 statement before approving.'
    );
    v_inserted := v_inserted + 1;
  END LOOP;

  RAISE NOTICE 'manual intake: % pending deposit request(s) inserted', v_inserted;
END $$;
