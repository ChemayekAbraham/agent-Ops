-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Rollback of 20261121100000_direct_pay_phase2_claim_submit.sql.
-- Restores the pool view, psm_plan_partner_reserved_stage, psm_reserved_plan_ids and funder_pending_hold from the
-- copies the migration saved (byte for byte), then drops what the migration added.
-- Refuses while any direct-pay payment is held or pending: those partners may already have paid a landlord.
-- Re-runnable.

SET lock_timeout = '5s';

DO $guard$
DECLARE v_live boolean;
BEGIN
  IF to_regprocedure('public.direct_pay_approve(uuid, text, text, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback refused: phase 3 (20261121110000) is still applied; roll it back first';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
               AND table_name = 'funder_offplatform_rent_payments' AND column_name = 'flow') THEN
    EXECUTE $q$SELECT EXISTS (SELECT 1 FROM public.funder_offplatform_rent_payments
                               WHERE flow = 'direct_pay' AND status IN ('held', 'pending'))$q$ INTO v_live;
    IF v_live THEN
      RAISE EXCEPTION 'rollback refused: direct payments are held or pending; settle or expire them first';
    END IF;
  END IF;
END
$guard$;

DROP TRIGGER IF EXISTS aa_direct_pay_plan_guard ON public.partner_self_plan_claims;
DROP TRIGGER IF EXISTS aa_direct_pay_plan_guard ON public.partner_self_funding_lines;
DROP TRIGGER IF EXISTS aa_direct_pay_plan_guard ON public.co_support_invites;
DROP TRIGGER IF EXISTS aa_direct_pay_plan_guard ON public.promissory_note_plan_intents;

DO $restore$
DECLARE r record;
BEGIN
  IF to_regclass('public.direct_pay_saved_definitions') IS NULL THEN
    RETURN;   -- already rolled back
  END IF;
  FOR r IN EXECUTE $q$SELECT object_name, definition FROM public.direct_pay_saved_definitions
                       WHERE object_name IN ('view:v_partner_self_fundable_plans', 'function:psm_plan_partner_reserved_stage',
                                             'function:psm_reserved_plan_ids', 'function:funder_pending_hold')
                       ORDER BY object_name$q$ LOOP
    IF r.object_name = 'view:v_partner_self_fundable_plans' THEN
      EXECUTE 'CREATE OR REPLACE VIEW public.v_partner_self_fundable_plans AS ' || regexp_replace(r.definition, ';\s*$', '');
    ELSE
      EXECUTE r.definition;   -- pg_get_functiondef output: a complete CREATE OR REPLACE FUNCTION
    END IF;
  END LOOP;
END
$restore$;

DROP FUNCTION IF EXISTS public.direct_pay_my_payments();
DROP FUNCTION IF EXISTS public.direct_pay_refresh(uuid);
DROP FUNCTION IF EXISTS public.direct_pay_record_proof(uuid, uuid, text, text, text, text, numeric, jsonb);
DROP FUNCTION IF EXISTS public.direct_pay_release(uuid);
DROP FUNCTION IF EXISTS public.direct_pay_claim(uuid);
DROP FUNCTION IF EXISTS public._direct_pay_evaluate(uuid);
DROP FUNCTION IF EXISTS public._direct_pay_partner_view(uuid, text);
DROP FUNCTION IF EXISTS public._direct_pay_flags(uuid);
DROP FUNCTION IF EXISTS public.trg_direct_pay_plan_guard();
DROP FUNCTION IF EXISTS public._direct_pay_plan_lock(uuid);
DROP FUNCTION IF EXISTS public._direct_pay_tenant_owes(uuid);
DROP FUNCTION IF EXISTS public._direct_pay_on();

ALTER TABLE public.funder_offplatform_rent_proofs DROP CONSTRAINT IF EXISTS fop_proofs_amount_typed;
ALTER TABLE public.funder_offplatform_rent_proofs DROP COLUMN IF EXISTS amount_typed;

DROP TABLE IF EXISTS public.direct_pay_saved_definitions;
