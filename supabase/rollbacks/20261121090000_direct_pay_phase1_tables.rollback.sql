-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Rollback of 20261121090000_direct_pay_phase1_tables.sql.
-- Refuses while any direct-pay row, proof or float Cover-fee ledger leg exists: those would lose their meaning.
-- Re-runnable (IF EXISTS everywhere).

SET lock_timeout = '5s';

DO $guard$
DECLARE v_any boolean;
BEGIN
  -- Dynamic SQL: on a second run the table / column is already gone and a static reference would not even plan.
  IF to_regclass('public.funder_offplatform_rent_proofs') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.funder_offplatform_rent_proofs)' INTO v_any;
    IF v_any THEN RAISE EXCEPTION 'rollback refused: funder_offplatform_rent_proofs has rows'; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'funder_offplatform_rent_payments' AND column_name = 'flow') THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.funder_offplatform_rent_payments WHERE flow = ''direct_pay'')' INTO v_any;
    IF v_any THEN RAISE EXCEPTION 'rollback refused: direct-pay payments exist'; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.general_ledger
              WHERE category = 'welile_cover_fee' AND ledger_scope = 'wallet' AND wallet_bucket = 'float') THEN
    RAISE EXCEPTION 'rollback refused: float Cover-fee ledger legs exist and resolve through the mapping row';
  END IF;
  IF EXISTS (SELECT 1 FROM public.general_ledger WHERE category = 'partner_direct_rent_capital') THEN
    RAISE EXCEPTION 'rollback refused: partner_direct_rent_capital ledger legs exist';
  END IF;
END
$guard$;

DELETE FROM public.ledger_account_map
 WHERE ledger_scope = 'wallet' AND category = 'welile_cover_fee' AND wallet_bucket = 'float';
DELETE FROM public.ledger_account_map
 WHERE ledger_scope = 'platform' AND category = 'partner_direct_rent_capital';

-- Take the category back off the allowlist (exactly the text the migration appended).
DO $allow$
DECLARE
  v_src text;
  v_new text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure;
  IF v_src NOT ILIKE '%partner_direct_rent_capital%' THEN
    RETURN;
  END IF;
  v_new := replace(v_src, ' || ARRAY[''partner_direct_rent_capital'']::text[]', '');
  IF v_new ILIKE '%partner_direct_rent_capital%' THEN
    RAISE EXCEPTION 'rollback: could not remove partner_direct_rent_capital from ledger_category_allowlist cleanly';
  END IF;
  v_new := regexp_replace(regexp_replace(v_new, '^\s*select\s+', '', 'i'), ';\s*$', '');
  -- The migration wrapped the old expression as "(old) || ARRAY[...]"; after the replace it is "(old)".
  EXECUTE format($f$CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
    RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'extensions', 'pg_temp' AS $body$
  SELECT %s;
$body$ $f$, v_new);
  IF 'partner_direct_rent_capital' = ANY (public.ledger_category_allowlist()) THEN
    RAISE EXCEPTION 'rollback: partner_direct_rent_capital is still allowlisted';
  END IF;
END
$allow$;

DROP INDEX IF EXISTS public.ix_deposit_requests_tid_norm;
DROP INDEX IF EXISTS public.ix_withdrawal_requests_tid_norm;
DROP INDEX IF EXISTS public.ix_withdrawal_requests_fin_ops_ref_norm;
DROP INDEX IF EXISTS public.ix_landlord_payouts_momo_ref_norm;
DROP INDEX IF EXISTS public.ix_landlord_payouts_external_ref_norm;

DROP TABLE IF EXISTS public.funder_offplatform_rent_proofs;

DROP TRIGGER IF EXISTS trg_fopr_touch_updated_at ON public.funder_offplatform_rent_payments;
DROP INDEX IF EXISTS public.ux_fopr_direct_pay_live_plan;
DROP INDEX IF EXISTS public.ix_fopr_direct_pay_hold_expiry;
DROP INDEX IF EXISTS public.ix_fopr_direct_pay_queue;

ALTER TABLE public.funder_offplatform_rent_payments
  DROP CONSTRAINT IF EXISTS fopr_flow_check,
  DROP CONSTRAINT IF EXISTS fopr_amount_received_check,
  DROP CONSTRAINT IF EXISTS fopr_reminders_check,
  DROP CONSTRAINT IF EXISTS fopr_direct_pay_shape,
  DROP CONSTRAINT IF EXISTS fopr_direct_pay_approval_proof,
  DROP CONSTRAINT IF EXISTS fopr_direct_pay_flag_reason,
  DROP CONSTRAINT IF EXISTS funder_offplatform_rent_payments_status_check;
ALTER TABLE public.funder_offplatform_rent_payments
  ADD CONSTRAINT funder_offplatform_rent_payments_status_check CHECK (status IN ('pending', 'confirmed', 'rejected'));

ALTER TABLE public.funder_offplatform_rent_payments
  DROP COLUMN IF EXISTS flow,
  DROP COLUMN IF EXISTS hold_started_at,
  DROP COLUMN IF EXISTS hold_expires_at,
  DROP COLUMN IF EXISTS expired_at,
  DROP COLUMN IF EXISTS landlord_id,
  DROP COLUMN IF EXISTS landlord_phone,
  DROP COLUMN IF EXISTS agent_id,
  DROP COLUMN IF EXISTS amount_received,
  DROP COLUMN IF EXISTS flags,
  DROP COLUMN IF EXISTS flag_reason,
  DROP COLUMN IF EXISTS call_note,
  DROP COLUMN IF EXISTS landlord_otp_challenge_id,
  DROP COLUMN IF EXISTS landlord_otp_verified_at,
  DROP COLUMN IF EXISTS portfolio_id,
  DROP COLUMN IF EXISTS ledger_group_id,
  DROP COLUMN IF EXISTS agent_pay_ledger_group_id,
  DROP COLUMN IF EXISTS receipt_id,
  DROP COLUMN IF EXISTS reminders_sent,
  DROP COLUMN IF EXISTS last_reminder_at,
  DROP COLUMN IF EXISTS coo_marked_at,
  DROP COLUMN IF EXISTS updated_at;

DELETE FROM public.pipeline_switches WHERE key = 'self_support_direct_pay' AND is_on = false;
