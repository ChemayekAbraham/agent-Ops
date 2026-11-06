-- Financial Ops access restrictions: the CTO can switch off parts of Financial Ops for a named person while leaving the rest on.
-- First case: the CFO asked that Natasha Arotin (0777404157) keeps the wallet tools but does not see the float held or Email Transactions.
--
-- AREAS (a person can have any of them switched off):
--   float               the merchant float we hold: positions, ledger variance, float movements, deliveries, reconciliations, requisitions
--   email_transactions  Email Transactions and the Gmail intake behind it: transactions, routing history, match audit, manual marks
-- Everything else, including the wallet tools, stays as it is for that person.
--
-- ENFORCED IN THE DATABASE, not only hidden on screen:
--   * a RESTRICTIVE policy on the tables behind each area: a restricted person reads and writes zero rows there, whatever role they hold;
--   * the staff-wide float / Gmail functions refuse them with a plain message ("Your access to ... has been turned off by management").
--   Merchant agents reading their OWN float (get_merchant_float_position, get_merchant_float_network_status) are not touched.
-- The screens can also ask get_my_financial_ops_restrictions() and hide the cards.
--
-- THE PANEL (CTO dashboard > Platform Controls) uses:
--   list_financial_ops_restrictions()                       who is restricted, what, why, by whom, when
--   set_financial_ops_restriction(user, areas[], reason)    sets the full list of switched-off areas for that person; {} lifts all
--   search_people_for_dashboard_access(term)                (already exists) to find the person by name or phone
-- Only the CTO and super admins can change it; every change is written to the audit log.
-- Roll back with 20261023170000_financial_ops_access_restrictions.rollback.sql.

CREATE TABLE IF NOT EXISTS public.financial_ops_restrictions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  area       text NOT NULL CHECK (area IN ('float', 'email_transactions')),
  reason     text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at  timestamptz,
  lifted_by  uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS financial_ops_restrictions_active_uq ON public.financial_ops_restrictions (user_id, area) WHERE lifted_at IS NULL;
ALTER TABLE public.financial_ops_restrictions ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.financial_ops_restrictions TO service_role;
-- No policies: it is read and written only through the functions below.

-- Is the signed-in person switched off from this area? (Asks only about the caller, so it reveals nothing about anyone else.)
CREATE OR REPLACE FUNCTION public.is_financial_ops_area_blocked(p_area text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.financial_ops_restrictions r WHERE r.user_id = auth.uid() AND r.area = p_area AND r.lifted_at IS NULL);
$function$;

CREATE OR REPLACE FUNCTION public.assert_financial_ops_area(p_area text)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF public.is_financial_ops_area_blocked(p_area) THEN
    RAISE EXCEPTION 'Your access to % has been turned off by management.',
      CASE p_area WHEN 'float' THEN 'the float figures' WHEN 'email_transactions' THEN 'Email Transactions' ELSE p_area END
      USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_financial_ops_restrictions()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(array_agg(r.area ORDER BY r.area), ARRAY[]::text[]) FROM public.financial_ops_restrictions r WHERE r.user_id = auth.uid() AND r.lifted_at IS NULL;
$function$;

REVOKE ALL ON FUNCTION public.is_financial_ops_area_blocked(text), public.assert_financial_ops_area(text), public.get_my_financial_ops_restrictions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_financial_ops_area_blocked(text), public.assert_financial_ops_area(text), public.get_my_financial_ops_restrictions() TO authenticated;

-- The panel: who is restricted.
CREATE OR REPLACE FUNCTION public.list_financial_ops_restrictions()
RETURNS TABLE(user_id uuid, full_name text, phone text, areas text[], reason text, set_by_name text, set_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'cto'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.user_id, p.full_name, p.phone, array_agg(r.area ORDER BY r.area),
         (array_agg(r.reason ORDER BY r.created_at DESC))[1], (array_agg(b.full_name ORDER BY r.created_at DESC))[1], max(r.created_at)
    FROM public.financial_ops_restrictions r
    LEFT JOIN public.profiles p ON p.id = r.user_id
    LEFT JOIN public.profiles b ON b.id = r.created_by
   WHERE r.lifted_at IS NULL
   GROUP BY r.user_id, p.full_name, p.phone
   ORDER BY max(r.created_at) DESC;
END;
$function$;

-- The panel: set the full list of switched-off areas for one person ({} lifts everything).
CREATE OR REPLACE FUNCTION public.set_financial_ops_restriction(p_user_id uuid, p_areas text[], p_reason text)
RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_areas text[];
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_before text[];
BEGIN
  IF NOT (public.has_role(auth.uid(), 'cto'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN RAISE EXCEPTION 'Choose the person first.'; END IF;
  IF public.has_role(p_user_id, 'super_admin'::app_role) THEN RAISE EXCEPTION 'A super admin cannot be restricted.'; END IF;
  SELECT COALESCE(array_agg(DISTINCT a ORDER BY a), ARRAY[]::text[]) INTO v_areas FROM unnest(COALESCE(p_areas, ARRAY[]::text[])) a;
  IF EXISTS (SELECT 1 FROM unnest(v_areas) a WHERE a NOT IN ('float', 'email_transactions')) THEN RAISE EXCEPTION 'Unknown area.'; END IF;
  IF cardinality(v_areas) > 0 AND (v_reason IS NULL OR char_length(v_reason) < 5) THEN RAISE EXCEPTION 'Give the reason (who asked and why).'; END IF;

  SELECT COALESCE(array_agg(area ORDER BY area), ARRAY[]::text[]) INTO v_before
    FROM public.financial_ops_restrictions WHERE user_id = p_user_id AND lifted_at IS NULL;

  UPDATE public.financial_ops_restrictions SET lifted_at = now(), lifted_by = auth.uid()
   WHERE user_id = p_user_id AND lifted_at IS NULL AND NOT (area = ANY (v_areas));
  INSERT INTO public.financial_ops_restrictions (user_id, area, reason, created_by)
  SELECT p_user_id, a, v_reason, auth.uid() FROM unnest(v_areas) a
   WHERE NOT EXISTS (SELECT 1 FROM public.financial_ops_restrictions x WHERE x.user_id = p_user_id AND x.area = a AND x.lifted_at IS NULL);

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, old_values, new_values, reason)
  VALUES (auth.uid(), 'financial_ops_restriction_changed', 'Changed which Financial Ops areas are switched off for a person', 'financial_ops_restrictions',
          p_user_id::text, jsonb_build_object('areas', v_before), jsonb_build_object('areas', v_areas), v_reason);
  RETURN v_areas;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_financial_ops_restrictions(), public.set_financial_ops_restriction(uuid, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_financial_ops_restrictions(), public.set_financial_ops_restriction(uuid, text[], text) TO authenticated;

-- Tables: a restrictive policy so a switched-off person sees and changes nothing here, whatever other policy lets them in.
DO $pol$
DECLARE t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
      ('gmail_transactions', 'email_transactions'), ('gmail_poll_state', 'email_transactions'), ('email_routing_history', 'email_transactions'),
      ('email_match_audit_log', 'email_transactions'), ('email_credit_manual_marks', 'email_transactions'),
      ('merchant_float_deliveries', 'float'), ('merchant_float_reconciliations', 'float'), ('merchant_float_requisitions', 'float'),
      ('merchant_float_variance_alerts', 'float'), ('operational_float_audit_log', 'float')
    ) v(tbl, area)
  LOOP
    IF to_regclass('public.' || t.tbl) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS financial_ops_area_blocked ON public.%I', t.tbl);
      EXECUTE format('CREATE POLICY financial_ops_area_blocked ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (NOT (SELECT public.is_financial_ops_area_blocked(%L)))', t.tbl, t.area);
    END IF;
  END LOOP;
END
$pol$;

-- Functions that hand staff the float figures or the Gmail intake: add the check as their first statement (these bypass row policies).
DO $guard$
DECLARE f record; v_def text; v_new text;
BEGIN
  FOR f IN SELECT * FROM (VALUES
      ('get_all_merchant_float_positions', 'float'), ('get_merchant_float_positions', 'float'), ('get_merchant_float_positions_signed', 'float'),
      ('get_merchant_float_ledger_variance', 'float'), ('get_merchant_float_email_movements', 'float'), ('get_gmail_intake_health', 'email_transactions')
    ) v(fn, area)
  LOOP
    FOR v_def IN SELECT pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f.fn AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
    LOOP
      IF v_def NOT LIKE '%assert_financial_ops_area%' THEN
        v_new := regexp_replace(v_def, E'\\mBEGIN\\M', format('BEGIN PERFORM public.assert_financial_ops_area(%L);', f.area), 'i');
        IF v_new = v_def THEN RAISE EXCEPTION 'Could not add the check to %', f.fn; END IF;
        EXECUTE v_new;
      END IF;
    END LOOP;
  END LOOP;
END
$guard$;
