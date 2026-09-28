-- BACK-PAY THE REGISTRATION BONUSES THAT 20260928190000 EXPLAINS.
--
-- ============================================================================
-- THIS MIGRATION DOES NOTHING UNLESS SOMEONE DELIBERATELY ARMS IT.
--
--   SELECT set_config('welile.backpay_approved', 'true', false);
--   -- then run this file
--
-- Without that GUC it reports and exits. It is committed in this state on
-- purpose: applying the repo's migrations must never move UGX 3,625,000 of
-- agent money as a side effect.
-- ============================================================================
--
-- WHAT IS OWED, AND TO WHOM (measured 2026-09-28)
--
--   707 landlord registration bonuses @ 5,000 = UGX 3,535,000
--    45 LC1      registration bonuses @ 2,000 = UGX    90,000
--   -----------------------------------------------------------
--   752 bonuses across 112 agents             = UGX 3,625,000
--
--   No recipient is a deleted account.
--
-- THE LARGEST SINGLE CLAIMANT IS THE PRODUCT OWNER.
-- PIUSLUBEGA SSENKALI is owed 1,035,000 of the 3,625,000 — 207 landlords, 29%
-- of the whole amount. That is stated here rather than buried because the
-- person approving this payment is its biggest beneficiary, and whoever signs
-- it off should know that without having to run the query. The next largest is
-- Akampurira Onesmus at 215,000.
--
-- WHY THIS IS SAFE TO RUN TWICE
--
-- Every payment goes through `create_ledger_transaction` with the SAME
-- idempotency keys the live triggers use — `landlord_reg_verify_v2:<id>` and
-- `lc1_reg_verify_v1:<id>`. A bonus that was already paid cannot be paid again,
-- whether it was paid by the trigger before this ran or by a previous run of
-- this file. The `registration_verification_bonus_paid` flag is set in the same
-- transaction.
--
-- WHY IT PAYS 5,000 AND 2,000 AND NOT A RECALCULATED FIGURE
--
-- These are the rates the triggers have always used and the rates agents were
-- told. This corrects a delivery failure; it is not a renegotiation.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--
--   * It does not pay for unverified landlords or LC1s. Nothing is owed until
--     verification, and the fix in 20260928190000 means those now pay on time.
--   * It does not touch `verified`, so it cannot re-trigger anything.
--   * It does not pay a bonus where `registered_by` is null. Nobody is on
--     record as having registered those, so nobody is owed.

DO $backpay$
DECLARE
  r record;
  v_armed     boolean := COALESCE(current_setting('welile.backpay_approved', true), '') = 'true';
  v_landlords int := 0; v_lc1 int := 0; v_ugx numeric := 0;
  v_due_ll    int; v_due_lc int;
BEGIN
  SELECT count(*) INTO v_due_ll FROM public.landlords
   WHERE verified = true AND registered_by IS NOT NULL
     AND NOT COALESCE(registration_verification_bonus_paid, false);
  SELECT count(*) INTO v_due_lc FROM public.lc1_chairpersons
   WHERE verified = true AND registered_by IS NOT NULL
     AND NOT COALESCE(registration_verification_bonus_paid, false);

  IF NOT v_armed THEN
    RAISE NOTICE 'BACK-PAY NOT ARMED. Would pay % landlord bonuses (UGX %) and % LC1 bonuses (UGX %), total UGX %. '
                 'Set welile.backpay_approved = true to arm.',
                 v_due_ll, v_due_ll * 5000, v_due_lc, v_due_lc * 2000,
                 v_due_ll * 5000 + v_due_lc * 2000;
    RETURN;
  END IF;

  FOR r IN
    SELECT id, name, registered_by FROM public.landlords
     WHERE verified = true AND registered_by IS NOT NULL
       AND NOT COALESCE(registration_verification_bonus_paid, false)
     ORDER BY created_at
  LOOP
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object('user_id', r.registered_by,'amount',5000,'direction','cash_in','category','agent_commission','ledger_scope','wallet','recipient_type','user','source_table','landlords','source_id',r.id::text,'description','UGX 5,000 landlord registration bonus — landlord verified: ' || COALESCE(r.name,'landlord') || ' (back-paid)','currency','UGX'),
        jsonb_build_object('user_id', r.registered_by,'amount',5000,'direction','cash_out','category','marketing_expense','ledger_scope','platform','source_table','landlords','source_id',r.id::text,'description','Platform expense: landlord registration bonus (verified, back-paid) — ' || COALESCE(r.name,'landlord'),'currency','UGX')
      ),
      'landlord_reg_verify_v2:' || r.id::text
    );
    UPDATE public.landlords
       SET registration_verification_bonus_paid = true,
           registration_verification_bonus_paid_at = now()
     WHERE id = r.id;
    v_landlords := v_landlords + 1; v_ugx := v_ugx + 5000;
  END LOOP;

  FOR r IN
    SELECT id, name, registered_by FROM public.lc1_chairpersons
     WHERE verified = true AND registered_by IS NOT NULL
       AND NOT COALESCE(registration_verification_bonus_paid, false)
  LOOP
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object('user_id', r.registered_by,'amount',2000,'direction','cash_in','category','agent_commission','ledger_scope','wallet','recipient_type','user','source_table','lc1_chairpersons','source_id',r.id::text,'description','UGX 2,000 LC1 chairperson registration bonus — verified: ' || COALESCE(r.name,'LC1 chairperson') || ' (back-paid)','currency','UGX'),
        jsonb_build_object('user_id', r.registered_by,'amount',2000,'direction','cash_out','category','marketing_expense','ledger_scope','platform','source_table','lc1_chairpersons','source_id',r.id::text,'description','Platform expense: LC1 chairperson registration bonus (verified, back-paid) — ' || COALESCE(r.name,'LC1 chairperson'),'currency','UGX')
      ),
      'lc1_reg_verify_v1:' || r.id::text
    );
    UPDATE public.lc1_chairpersons
       SET registration_verification_bonus_paid = true,
           registration_verification_bonus_paid_at = now()
     WHERE id = r.id;
    v_lc1 := v_lc1 + 1; v_ugx := v_ugx + 2000;
  END LOOP;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, action, reason, new_values)
  VALUES ('registration_bonus_backpay', 'landlords', 'bulk', 'backpay',
    'Back-paid registration bonuses missed because trg_pay_landlord_registration_verified_bonus was '
      || 'declared AFTER UPDATE OF verified, which does not fire when the pipeline verifies a landlord '
      || 'without naming that column. See 20260928190000.',
    jsonb_build_object('landlord_bonuses', v_landlords, 'lc1_bonuses', v_lc1, 'total_ugx', v_ugx));

  RAISE NOTICE 'Back-paid % landlord and % LC1 bonuses, UGX % total.', v_landlords, v_lc1, v_ugx;
END
$backpay$;
