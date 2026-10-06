-- Landlord payout budget becomes a GOAL that stays until it is reached, not a figure that resets every day.
--
-- 20261003090000_landlord_payout_daily_budget.sql counted what had been allowed through the queue block since midnight
-- (Kampala), so the budget applied to one day and started again at zero the next. The CTO's budget is a target to reach:
-- it must stay in force across days until the amount allowed through reaches it, and it can be changed at any time.
--
-- How it works now:
--   * The goal has a start time (treasury_controls 'landlord_payout_budget_started_at'). "Allowed so far" is every landlord
--     payout whose landlord_block_exempt_at is at or after that start, whether or not it has been paid yet. Re-blocking a
--     payout clears its timestamp and frees its amount, as before.
--   * Once allowed-so-far reaches the goal, nothing more can be allowed until the goal is raised, removed, or a new goal is
--     started.
--   * Changing the amount NEVER loses progress: raising, lowering or re-setting it keeps the same start. Only a first goal
--     (none was set), or an explicit restart (p_restart => true), starts counting again from zero.
--   * Removing the goal (NULL or 0) clears it; setting one later starts a new count.
--   * Enforcement is still inside set_landlord_payout_block_exemption(), so the web and the mobile app are held to the same
--     limit, and the 'landlord_payout_daily_budget' control row keeps holding the amount.
--
-- The goal that is in force when this runs keeps counting from the start of today (Kampala), which is exactly what the
-- daily budget had counted, so nothing jumps. Roll back with 20261005170000_landlord_payout_goal_budget.rollback.sql.

-- 1. When the current goal started.
INSERT INTO public.treasury_controls (control_key, enabled, value)
VALUES ('landlord_payout_budget_started_at', false, NULL)
ON CONFLICT (control_key) DO NOTHING;

UPDATE public.treasury_controls s
   SET enabled = true,
       value = (date_trunc('day', now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala')::text
 WHERE s.control_key = 'landlord_payout_budget_started_at'
   AND COALESCE(btrim(s.value), '') = ''
   AND EXISTS (SELECT 1 FROM public.treasury_controls b
                WHERE b.control_key = 'landlord_payout_daily_budget' AND b.enabled);

-- 2. The start of the goal in force (start of today, Kampala, if none has been recorded).
CREATE OR REPLACE FUNCTION public.landlord_payout_goal_started_at()
 RETURNS timestamptz
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT NULLIF(btrim(c.value), '')::timestamptz
       FROM public.treasury_controls c
      WHERE c.control_key = 'landlord_payout_budget_started_at' AND c.enabled),
    date_trunc('day', now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala');
$function$;

-- 3. How much has been allowed through since the goal started.
CREATE OR REPLACE FUNCTION public.landlord_payout_goal_allowed()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(SUM(w.amount), 0)
    FROM public.withdrawal_requests w
   WHERE w.landlord_payout_id IS NOT NULL
     AND w.landlord_block_exempt_at >= public.landlord_payout_goal_started_at();
$function$;

-- 4. Read the goal and where it stands (CTO / CFO / super admin). The return columns change, so drop the old one first.
DROP FUNCTION IF EXISTS public.get_landlord_payout_budget();

CREATE FUNCTION public.get_landlord_payout_budget()
 RETURNS TABLE(budget numeric, enabled boolean, allowed_so_far numeric, remaining numeric, reached boolean, started_at timestamptz)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_enabled boolean;
  v_value text;
  v_budget numeric;
  v_allowed numeric := public.landlord_payout_goal_allowed();
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

  RETURN QUERY SELECT v_budget,
                      (v_budget IS NOT NULL),
                      v_allowed,
                      CASE WHEN v_budget IS NULL THEN NULL ELSE GREATEST(v_budget - v_allowed, 0) END,
                      (v_budget IS NOT NULL AND v_allowed >= v_budget),
                      CASE WHEN v_budget IS NULL THEN NULL ELSE public.landlord_payout_goal_started_at() END;
END;
$function$;

-- 5. Set the goal (NULL or 0 removes it). A signature with a new argument replaces the old one.
DROP FUNCTION IF EXISTS public.set_landlord_payout_budget(numeric);

CREATE FUNCTION public.set_landlord_payout_budget(p_budget numeric, p_restart boolean DEFAULT false)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_new numeric := CASE WHEN p_budget IS NULL OR p_budget <= 0 THEN NULL ELSE floor(p_budget) END;
  v_was_enabled boolean;
  v_was_value text;
  v_had_goal boolean;
  v_restart boolean;
  v_started timestamptz;
BEGIN
  IF NOT (public.has_role(v_uid, 'cto'::app_role)
       OR public.has_role(v_uid, 'cfo'::app_role)
       OR public.has_role(v_uid, 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT c.enabled, c.value INTO v_was_enabled, v_was_value
    FROM public.treasury_controls c WHERE c.control_key = 'landlord_payout_daily_budget' FOR UPDATE;
  v_had_goal := COALESCE(v_was_enabled, false) AND COALESCE(NULLIF(btrim(COALESCE(v_was_value, '')), '')::numeric, 0) > 0;

  -- Changing the amount keeps the progress. Counting starts again only for a first goal or when asked.
  v_restart := v_new IS NOT NULL AND (COALESCE(p_restart, false) OR NOT v_had_goal);

  IF v_restart THEN
    INSERT INTO public.treasury_controls (control_key, enabled, value, updated_by, updated_at)
    VALUES ('landlord_payout_budget_started_at', true, now()::text, v_uid, now())
    ON CONFLICT (control_key) DO UPDATE
       SET enabled = true, value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();
  ELSIF v_new IS NULL THEN
    UPDATE public.treasury_controls
       SET enabled = false, value = NULL, updated_by = v_uid, updated_at = now()
     WHERE control_key = 'landlord_payout_budget_started_at';
  END IF;

  INSERT INTO public.treasury_controls (control_key, enabled, value, updated_by, updated_at)
  VALUES ('landlord_payout_daily_budget', v_new IS NOT NULL, v_new::text, v_uid, now())
  ON CONFLICT (control_key) DO UPDATE
     SET enabled = EXCLUDED.enabled, value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();

  v_started := public.landlord_payout_goal_started_at();

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (v_uid, 'landlord_payout_budget_set',
          CASE WHEN v_new IS NULL THEN 'Removed the landlord payout goal'
               WHEN v_restart THEN 'Started a new landlord payout goal'
               ELSE 'Changed the landlord payout goal' END,
          'treasury_controls', 'landlord_payout_daily_budget',
          jsonb_build_object('budget', v_new, 'allowed_so_far', public.landlord_payout_goal_allowed(),
                             'started_at', v_started, 'restarted', v_restart));

  RETURN v_new;
END;
$function$;

-- 6. The allow function, now counting against the goal instead of against today.
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
  v_since text;
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
    -- Lock the goal row so two people allowing at once cannot both slip under the limit.
    SELECT c.enabled, c.value INTO v_enabled, v_value
      FROM public.treasury_controls c
     WHERE c.control_key = 'landlord_payout_daily_budget'
       FOR UPDATE;
    v_budget := NULLIF(btrim(COALESCE(v_value, '')), '')::numeric;

    IF COALESCE(v_enabled, false) AND v_budget IS NOT NULL AND v_budget > 0 THEN
      v_allowed := public.landlord_payout_goal_allowed();
      v_since := to_char(public.landlord_payout_goal_started_at() AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY');
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
          RAISE EXCEPTION 'The landlord payout goal of UGX % is reached (UGX % allowed since %). No more payouts can be allowed until you raise the goal, start a new one, or re-block some to free room.',
            to_char(v_budget, 'FM999,999,999,999'), to_char(v_allowed, 'FM999,999,999,999'), v_since;
        END IF;
        RAISE EXCEPTION 'Over the landlord payout goal: UGX % of UGX % is already allowed (since %), so only UGX % is left, and this selection is UGX %. Allow fewer payouts, or raise the goal.',
          to_char(v_allowed, 'FM999,999,999,999'), to_char(v_budget, 'FM999,999,999,999'), v_since,
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

-- Only signed-in users can run the readers and setters; they refuse anyone without the role either way.
REVOKE ALL ON FUNCTION public.get_landlord_payout_budget() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_landlord_payout_budget(numeric, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_landlord_payout_budget() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_landlord_payout_budget(numeric, boolean) TO authenticated;
