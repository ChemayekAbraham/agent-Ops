-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Self-support option 2. Phase 7: the targets as numbers, and an alert when one is missed.
-- Needs 20261121090000 .. 20261121130000.
--
--   direct_pay_health()  for Landlord Ops, the COO, the CTO and super admin. One query per figure, all bounded by
--                        partial indexes or a 7-day window. Targets (build plan, "Targets and alerts"):
--     * every approval has the landlord OTP and a call note      (a CHECK makes this structural; counted anyway)
--     * 95% of complete proofs decided within 24 hours           (last 7 days)
--     * 99% of approval messages sent within 5 minutes           (alert: more than 10 SMS waiting over 15 minutes)
--     * amount read on at least 95% of SMS screenshots           (alert: under 90% in the last 24 hours, 20+ proofs)
--     * no unbalanced direct-pay ledger group                    (alert: any)
--     * Cover fees waiting for a top-up                          (shown; retried by direct_pay_tick)
--   direct_pay_health_alert()  daily at 07:00 Kampala: writes one audit row per missed target (nothing when healthy).
-- REQUIRES THE OWNER'S YES before it is applied to production.

SET lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regprocedure('public.direct_pay_tick()') IS NULL THEN
    RAISE EXCEPTION 'direct pay phase 7: phase 4 (20261121120000) is not applied';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public._direct_pay_health_core() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH decided AS (
    SELECT p.status, p.created_at, COALESCE(p.confirmed_at, p.rejected_at) AS decided_at
      FROM public.funder_offplatform_rent_payments p
     WHERE p.flow = 'direct_pay' AND p.status IN ('confirmed', 'rejected')
       AND COALESCE(p.confirmed_at, p.rejected_at) > now() - interval '7 days'
  ), proofs AS (
    SELECT f.amount_read FROM public.funder_offplatform_rent_proofs f WHERE f.created_at > now() - interval '24 hours'
  ), m AS (
    SELECT
      (SELECT count(*) FROM public.funder_offplatform_rent_payments
        WHERE flow = 'direct_pay' AND status = 'confirmed'
          AND (landlord_otp_verified_at IS NULL OR NULLIF(btrim(call_note), '') IS NULL))          AS approvals_missing_otp_or_note,
      (SELECT count(*) FROM decided)                                                               AS decided_7d,
      (SELECT count(*) FROM decided WHERE decided_at - created_at <= interval '24 hours')          AS decided_within_24h_7d,
      (SELECT count(*) FROM public.funder_offplatform_rent_payments
        WHERE flow = 'direct_pay' AND status = 'pending' AND created_at < now() - interval '24 hours') AS pending_over_24h,
      (SELECT count(*) FROM public.self_support_notices
        WHERE ref_type = 'direct_payment' AND channel = 'sms' AND status = 'pending'
          AND created_at < now() - interval '15 minutes')                                          AS sms_waiting_over_15m,
      (SELECT count(*) FROM proofs)                                                                AS proofs_24h,
      (SELECT count(*) FROM proofs WHERE amount_read IS NOT NULL)                                  AS proofs_amount_read_24h,
      (SELECT count(DISTINCT v.transaction_group_id) FROM public.ledger_mapped_balance_violations v
        WHERE v.transaction_group_id IN (SELECT g.transaction_group_id FROM public.general_ledger g
                                          WHERE g.source_table = 'funder_offplatform_rent_payments'))  AS unbalanced_groups,
      (SELECT count(*) FROM public.funder_offplatform_rent_payments
        WHERE flow = 'direct_pay' AND status = 'confirmed' AND cover_fee_status = 'awaiting_topup')  AS cover_fees_awaiting_topup
  )
  SELECT jsonb_build_object(
    'at', now(),
    'metrics', to_jsonb(m),
    'decided_within_24h_pct', CASE WHEN m.decided_7d = 0 THEN NULL ELSE round(100.0 * m.decided_within_24h_7d / m.decided_7d, 1) END,
    'amount_read_pct', CASE WHEN m.proofs_24h = 0 THEN NULL ELSE round(100.0 * m.proofs_amount_read_24h / m.proofs_24h, 1) END,
    'breaches', to_jsonb(array_remove(ARRAY[
      CASE WHEN m.approvals_missing_otp_or_note > 0 THEN 'approval_without_otp_or_call_note' END,
      CASE WHEN m.decided_7d >= 10 AND m.decided_within_24h_7d < 0.95 * m.decided_7d THEN 'decisions_slower_than_24h' END,
      CASE WHEN m.pending_over_24h > 0 THEN 'payments_waiting_over_24h' END,
      CASE WHEN m.sms_waiting_over_15m > 10 THEN 'messages_stuck' END,
      CASE WHEN m.proofs_24h >= 20 AND m.proofs_amount_read_24h < 0.90 * m.proofs_24h THEN 'sms_reader_failing' END,
      CASE WHEN m.unbalanced_groups > 0 THEN 'unbalanced_ledger_group' END
    ], NULL)))
  FROM m;
$$;
REVOKE ALL ON FUNCTION public._direct_pay_health_core() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.direct_pay_health() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.staff_mfa_ok() OR NOT (
       public.has_role(v_uid, 'landlord_ops'::public.app_role) OR public.has_role(v_uid, 'coo'::public.app_role)
    OR public.has_role(v_uid, 'cto'::public.app_role) OR public.has_role(v_uid, 'super_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN public._direct_pay_health_core();
END $$;
REVOKE ALL ON FUNCTION public.direct_pay_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.direct_pay_health() TO authenticated;

CREATE OR REPLACE FUNCTION public.direct_pay_health_alert() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v jsonb := public._direct_pay_health_core(); b text;
BEGIN
  FOR b IN SELECT jsonb_array_elements_text(v->'breaches') LOOP
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
    VALUES (NULL, 'direct_pay_health_breach', 'funder_offplatform_rent_payments', b, 'direct_pay_health_breach',
            'Pay-the-landlord-directly target missed: ' || b, v);
  END LOOP;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.direct_pay_health_alert() FROM PUBLIC, anon, authenticated;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    -- 04:00 UTC = 07:00 Kampala.
    PERFORM cron.schedule('direct-pay-health', '0 4 * * *', 'SELECT public.direct_pay_health_alert();');
  END IF;
END
$cron$;
