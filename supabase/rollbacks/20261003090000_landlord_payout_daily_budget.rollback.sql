-- Rollback for 20261003090000_landlord_payout_daily_budget.sql
-- Restores set_landlord_payout_block_exemption() to its definition before the daily budget check, and removes the
-- budget functions. The treasury_controls row is left in place (disabled), so no limit applies.

CREATE OR REPLACE FUNCTION public.set_landlord_payout_block_exemption(p_withdrawal_ids uuid[], p_allow boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[];
BEGIN
  IF NOT (public.has_role(v_uid, 'cto'::app_role)
       OR public.has_role(v_uid, 'cfo'::app_role)
       OR public.has_role(v_uid, 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_withdrawal_ids IS NULL OR cardinality(p_withdrawal_ids) = 0 THEN
    RETURN 0;
  END IF;

  WITH upd AS (
    UPDATE public.withdrawal_requests w
       SET landlord_block_exempt_at = CASE WHEN p_allow THEN now() ELSE NULL END,
           landlord_block_exempt_by = CASE WHEN p_allow THEN v_uid ELSE NULL END
     WHERE w.id = ANY (p_withdrawal_ids)
       AND w.landlord_payout_id IS NOT NULL
       AND w.assigned_cashout_agent_id IS NULL
       AND w.processed_at IS NULL
       AND w.fin_ops_reference IS NULL
       AND (w.landlord_block_exempt_at IS NULL) = p_allow
    RETURNING w.id
  )
  SELECT array_agg(id) INTO v_ids FROM upd;

  IF v_ids IS NOT NULL THEN
    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
    SELECT v_uid,
           CASE WHEN p_allow THEN 'landlord_payout_block_exempt' ELSE 'landlord_payout_block_unexempt' END,
           CASE WHEN p_allow THEN 'Allowed landlord payout through queue block' ELSE 'Re-blocked landlord payout' END,
           'withdrawal_requests', id::text,
           jsonb_build_object('landlord_payouts_blocked', public.landlord_payouts_blocked_from_queue())
      FROM unnest(v_ids) AS id;
  END IF;

  RETURN COALESCE(cardinality(v_ids), 0);
END;
$function$;

UPDATE public.treasury_controls SET enabled = false, value = NULL WHERE control_key = 'landlord_payout_daily_budget';
DROP FUNCTION IF EXISTS public.set_landlord_payout_budget(numeric);
DROP FUNCTION IF EXISTS public.get_landlord_payout_budget();
DROP FUNCTION IF EXISTS public.landlord_payout_allowed_today();
