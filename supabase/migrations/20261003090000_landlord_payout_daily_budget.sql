-- Daily budget for landlord payouts allowed through the queue block.
--
-- While "Block landlord payouts from queue" is on, the CTO allows chosen payouts through one by one. Yesterday that
-- allowed UGX 38.78M against a budget of 20M, because nothing stopped the total at the budget.
--
-- This adds a daily budget (UGX) the CTO sets. Once the amount allowed through today reaches it, no further
-- landlord payout can be allowed until the CTO raises the budget or re-blocks payouts to free room. It is enforced
-- inside set_landlord_payout_block_exemption(), so the web and the mobile app are held to the same limit.
--
-- "Today" is the Kampala calendar day (UTC+3). "Allowed through" is every landlord payout whose
-- withdrawal_requests.landlord_block_exempt_at falls today, whether or not it has been paid yet; re-blocking one
-- clears its timestamp and frees its amount.

-- 1. The budget lives with the other treasury controls: enabled = a limit is set, value = the UGX amount.
INSERT INTO public.treasury_controls (control_key, enabled, value)
VALUES ('landlord_payout_daily_budget', false, NULL)
ON CONFLICT (control_key) DO NOTHING;

-- 2. How much has been allowed through so far today.
CREATE OR REPLACE FUNCTION public.landlord_payout_allowed_today()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(SUM(w.amount), 0)
    FROM public.withdrawal_requests w
   WHERE w.landlord_payout_id IS NOT NULL
     AND w.landlord_block_exempt_at >= (date_trunc('day', now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala');
$function$;

-- 3. Read the budget and where today stands (CTO / CFO / super admin).
CREATE OR REPLACE FUNCTION public.get_landlord_payout_budget()
 RETURNS TABLE(budget numeric, enabled boolean, allowed_today numeric, remaining numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_enabled boolean;
  v_value text;
  v_budget numeric;
  v_allowed numeric := public.landlord_payout_allowed_today();
BEGIN
  IF NOT (public.has_role(auth.uid(), 'cto'::app_role)
       OR public.has_role(auth.uid(), 'cfo'::app_role)
       OR public.has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT c.enabled, c.value INTO v_enabled, v_value
    FROM public.treasury_controls c WHERE c.control_key = 'landlord_payout_daily_budget';
  v_budget := NULLIF(btrim(COALESCE(v_value, '')), '')::numeric;
  IF NOT COALESCE(v_enabled, false) OR v_budget IS NULL OR v_budget <= 0 THEN
    v_budget := NULL;
  END IF;

  RETURN QUERY SELECT v_budget, (v_budget IS NOT NULL), v_allowed,
                      CASE WHEN v_budget IS NULL THEN NULL ELSE GREATEST(v_budget - v_allowed, 0) END;
END;
$function$;

-- 4. Set the budget (NULL or 0 removes the limit).
CREATE OR REPLACE FUNCTION public.set_landlord_payout_budget(p_budget numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_new numeric := CASE WHEN p_budget IS NULL OR p_budget <= 0 THEN NULL ELSE floor(p_budget) END;
BEGIN
  IF NOT (public.has_role(v_uid, 'cto'::app_role)
       OR public.has_role(v_uid, 'cfo'::app_role)
       OR public.has_role(v_uid, 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.treasury_controls (control_key, enabled, value, updated_by, updated_at)
  VALUES ('landlord_payout_daily_budget', v_new IS NOT NULL, v_new::text, v_uid, now())
  ON CONFLICT (control_key) DO UPDATE
     SET enabled = EXCLUDED.enabled, value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (v_uid, 'landlord_payout_budget_set',
          CASE WHEN v_new IS NULL THEN 'Removed the daily landlord payout budget' ELSE 'Set the daily landlord payout budget' END,
          'treasury_controls', 'landlord_payout_daily_budget',
          jsonb_build_object('budget', v_new, 'allowed_today', public.landlord_payout_allowed_today()));

  RETURN v_new;
END;
$function$;

-- 5. The same allow function as before, plus the budget check. Everything else is unchanged.
CREATE OR REPLACE FUNCTION public.set_landlord_payout_block_exemption(p_withdrawal_ids uuid[], p_allow boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[];
  v_enabled boolean;
  v_value text;
  v_budget numeric;
  v_allowed numeric;
  v_selected numeric;
BEGIN
  IF NOT (public.has_role(v_uid, 'cto'::app_role)
       OR public.has_role(v_uid, 'cfo'::app_role)
       OR public.has_role(v_uid, 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_withdrawal_ids IS NULL OR cardinality(p_withdrawal_ids) = 0 THEN
    RETURN 0;
  END IF;

  IF p_allow THEN
    -- Lock the budget row so two people allowing at once cannot both slip under the limit.
    SELECT c.enabled, c.value INTO v_enabled, v_value
      FROM public.treasury_controls c
     WHERE c.control_key = 'landlord_payout_daily_budget'
       FOR UPDATE;
    v_budget := NULLIF(btrim(COALESCE(v_value, '')), '')::numeric;

    IF COALESCE(v_enabled, false) AND v_budget IS NOT NULL AND v_budget > 0 THEN
      v_allowed := public.landlord_payout_allowed_today();
      SELECT COALESCE(SUM(w.amount), 0) INTO v_selected
        FROM public.withdrawal_requests w
       WHERE w.id = ANY (p_withdrawal_ids)
         AND w.landlord_payout_id IS NOT NULL
         AND w.assigned_cashout_agent_id IS NULL
         AND w.processed_at IS NULL
         AND w.fin_ops_reference IS NULL
         AND w.landlord_block_exempt_at IS NULL;

      IF v_selected > 0 AND v_allowed + v_selected > v_budget THEN
        IF v_allowed >= v_budget THEN
          RAISE EXCEPTION 'The daily landlord payout budget of UGX % is reached (UGX % already allowed today). No more payouts can be allowed until you raise the budget or re-block some to free room.',
            to_char(v_budget, 'FM999,999,999,999'), to_char(v_allowed, 'FM999,999,999,999');
        END IF;
        RAISE EXCEPTION 'Over the daily landlord payout budget: UGX % of UGX % is already allowed today, so only UGX % is left, and this selection is UGX %. Allow fewer payouts, or raise the budget.',
          to_char(v_allowed, 'FM999,999,999,999'), to_char(v_budget, 'FM999,999,999,999'),
          to_char(v_budget - v_allowed, 'FM999,999,999,999'), to_char(v_selected, 'FM999,999,999,999');
      END IF;
    END IF;
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
