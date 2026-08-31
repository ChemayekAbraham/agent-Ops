CREATE TABLE public.smartphone_test_allowlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  max_amount numeric NOT NULL DEFAULT 1000000 CHECK (max_amount > 0),
  reason text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  added_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.smartphone_test_allowlist TO authenticated;
GRANT ALL ON public.smartphone_test_allowlist TO service_role;

ALTER TABLE public.smartphone_test_allowlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Reviewers manage smartphone test allowlist"
ON public.smartphone_test_allowlist
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'super_admin') OR public.can_review_smartphone_orders(auth.uid()))
WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.can_review_smartphone_orders(auth.uid()));

CREATE TRIGGER trg_smartphone_test_allowlist_updated_at
BEFORE UPDATE ON public.smartphone_test_allowlist
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.get_agent_smartphone_eligibility(p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := COALESCE(p_user_id, auth.uid());
  v_rank integer;
  v_collected numeric;
  v_cap numeric;
  v_has_id boolean;
  v_has_workplace boolean;
  v_open integer;
  v_test_cap numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_uid <> auth.uid()
     AND NOT public.can_review_smartphone_orders(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT l.rank, l.collected INTO v_rank, v_collected
  FROM public.smartphone_leaderboard_ranks() l
  WHERE l.agent_id = v_uid;

  v_cap := public.smartphone_rank_cap(v_rank);

  -- Testing allowlist: raises the cap only, never lowers an earned one.
  SELECT max_amount INTO v_test_cap
  FROM public.smartphone_test_allowlist
  WHERE user_id = v_uid AND active;

  IF v_test_cap IS NOT NULL THEN
    v_cap := GREATEST(COALESCE(v_cap, 0), v_test_cap);
  END IF;

  SELECT COALESCE(NULLIF(btrim(COALESCE(national_id, '')), ''), '') <> ''
  INTO v_has_id FROM public.profiles WHERE id = v_uid;

  SELECT EXISTS (
    SELECT 1 FROM public.venue_visits
    WHERE user_id = v_uid AND category = 'workplace'
  ) INTO v_has_workplace;

  SELECT count(*) INTO v_open
  FROM public.merchandise_sales
  WHERE customer_id = v_uid
    AND lower(COALESCE(item_name, '')) LIKE '%phone%'
    AND COALESCE(order_status, 'submitted') IN ('pending_approval','submitted','ops_approved','coo_approved')
  ;

  RETURN jsonb_build_object(
    'user_id', v_uid,
    'rank', v_rank,
    'collected_30d', COALESCE(v_collected, 0),
    'max_amount', COALESCE(v_cap, 0),
    'test_access', v_test_cap IS NOT NULL,
    'has_national_id', COALESCE(v_has_id, false),
    'has_workplace_verification', COALESCE(v_has_workplace, false),
    'has_open_application', v_open > 0,
    -- Pickup-day checklist: verified only when the phone is released.
    'pickup_verification_complete', COALESCE(v_has_id, false) AND COALESCE(v_has_workplace, false),
    'eligible', COALESCE(v_cap, 0) > 0
                AND v_open = 0
  );
END;
$function$;

INSERT INTO public.smartphone_test_allowlist (user_id, max_amount, reason)
VALUES ('fa74e773-643b-4b42-bf18-bfa2d338614a', 1000000, 'Testing access granted for Abraham Chemayek (WEL-FA74E7)')
ON CONFLICT (user_id) DO UPDATE SET active = true, max_amount = EXCLUDED.max_amount, updated_at = now();