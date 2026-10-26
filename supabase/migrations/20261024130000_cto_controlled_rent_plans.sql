-- CTO-controlled Rent Plans: a marker for the plans the CTO controls, and a collections tracker over them.
--
-- WHAT THIS ADDS
--   1. cto_controlled_rent_plans   which Rent Plans are CTO-controlled. Backfilled with the 54 plans funded 19-24 Oct 2026.
--   2. cto_add_controlled_plans(uuid[]) / cto_remove_controlled_plans(uuid[])   the only way to change the list (CTO or super admin, audit-logged).
--   3. get_cto_controlled_plan_collections()   one row per controlled plan plus a summary row: what each plan was given, what is due by the
--      Rent Plan formula, what has come back, and the split of what came back from the ledger (principal back, partner, agent, platform).
--
-- WHO CAN SEE IT: CTO, CEO and CFO (table select and the read function). Only the CTO or a super admin can change the list.
-- The frontend never writes ledger or wallet state; this file changes no money data, it only reads the ledger.
--
-- THE SPLIT (from general_ledger rows with source_table = 'agent_collections' and source_id = the collection id, collections not reversed):
--   partner          partner_returns_allocated
--   platform         platform_fee_collected
--   agent_commission agent_commission_payable + agent_commission_earned, direction cash_in
--   fees_drawn       treasury_fee_drawdown
--   principal_back   collections - fees_drawn
-- expected_partner = 0.15 x given x days / 30      expected_agent = 0.10 x formula_due
-- days_overdue = days past (funded date + duration) while recovered is still below formula_due, else 0.
-- counter_mismatch = the sum of the plan's collections is not equal to rent_requests.amount_repaid.
-- Roll back with 20261024130000_cto_controlled_rent_plans.rollback.sql.

CREATE TABLE IF NOT EXISTS public.cto_controlled_rent_plans (
  rent_request_id uuid PRIMARY KEY REFERENCES public.rent_requests(id) ON DELETE CASCADE,
  added_by        uuid,
  added_at        timestamptz NOT NULL DEFAULT now(),
  note            text
);
ALTER TABLE public.cto_controlled_rent_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cto_controlled_plans_read ON public.cto_controlled_rent_plans;
CREATE POLICY cto_controlled_plans_read ON public.cto_controlled_rent_plans FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'cto'::app_role) OR public.has_role(auth.uid(), 'ceo'::app_role) OR public.has_role(auth.uid(), 'cfo'::app_role));
DROP POLICY IF EXISTS mfa_required_for_staff ON public.cto_controlled_rent_plans;
CREATE POLICY mfa_required_for_staff ON public.cto_controlled_rent_plans AS RESTRICTIVE FOR ALL USING ((SELECT public.staff_mfa_ok()));

-- No insert/update/delete policy: writes go only through the two functions below.
REVOKE ALL ON public.cto_controlled_rent_plans FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cto_controlled_rent_plans TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cto_controlled_rent_plans TO service_role;

-- Backfill: the 54 plans funded 19-24 Oct 2026.
INSERT INTO public.cto_controlled_rent_plans (rent_request_id, note)
SELECT r.id, 'Backfill: funded 19-24 Oct 2026'
  FROM public.rent_requests r
 WHERE COALESCE(r.funded_at, r.disbursed_at) >= '2026-10-19'
   AND COALESCE(r.funded_at, r.disbursed_at) <  '2026-10-25'
   AND r.status IN ('funded', 'repaying', 'completed')
ON CONFLICT (rent_request_id) DO NOTHING;

-- Add plans to the list.
CREATE OR REPLACE FUNCTION public.cto_add_controlled_plans(p_rent_request_ids uuid[], p_note text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_added uuid[];
BEGIN
  IF v_uid IS NULL OR NOT (public.has_role(v_uid, 'cto'::app_role) OR public.has_role(v_uid, 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_rent_request_ids IS NULL OR cardinality(p_rent_request_ids) = 0 THEN RETURN 0; END IF;
  WITH ins AS (
    INSERT INTO public.cto_controlled_rent_plans (rent_request_id, added_by, note)
    SELECT r.id, v_uid, NULLIF(btrim(COALESCE(p_note, '')), '') FROM public.rent_requests r WHERE r.id = ANY (p_rent_request_ids)
    ON CONFLICT (rent_request_id) DO NOTHING
    RETURNING rent_request_id)
  SELECT array_agg(rent_request_id) INTO v_added FROM ins;
  IF v_added IS NOT NULL THEN
    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
    VALUES (v_uid, 'cto_controlled_plans_added', 'Added Rent Plans to the CTO-controlled list', 'cto_controlled_rent_plans', NULL,
            jsonb_build_object('rent_request_ids', v_added, 'count', cardinality(v_added), 'note', p_note));
  END IF;
  RETURN COALESCE(cardinality(v_added), 0);
END;
$function$;

-- Remove plans from the list.
CREATE OR REPLACE FUNCTION public.cto_remove_controlled_plans(p_rent_request_ids uuid[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_removed uuid[];
BEGIN
  IF v_uid IS NULL OR NOT (public.has_role(v_uid, 'cto'::app_role) OR public.has_role(v_uid, 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_rent_request_ids IS NULL OR cardinality(p_rent_request_ids) = 0 THEN RETURN 0; END IF;
  WITH del AS (DELETE FROM public.cto_controlled_rent_plans WHERE rent_request_id = ANY (p_rent_request_ids) RETURNING rent_request_id)
  SELECT array_agg(rent_request_id) INTO v_removed FROM del;
  IF v_removed IS NOT NULL THEN
    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
    VALUES (v_uid, 'cto_controlled_plans_removed', 'Removed Rent Plans from the CTO-controlled list', 'cto_controlled_rent_plans', NULL,
            jsonb_build_object('rent_request_ids', v_removed, 'count', cardinality(v_removed)));
  END IF;
  RETURN COALESCE(cardinality(v_removed), 0);
END;
$function$;

-- The tracker: one row per controlled plan, then a summary row (row_kind = 'summary').
CREATE OR REPLACE FUNCTION public.get_cto_controlled_plan_collections()
RETURNS TABLE(
  row_kind text, rent_request_id uuid, tenant_name text, agent_id uuid, agent_name text, funded_on date, duration_days integer, status text,
  given numeric, formula_due numeric, recovered numeric, collection_count integer, last_collection_on date,
  partner_earned numeric, platform_earned numeric, agent_commission numeric, fees_drawn numeric, principal_back numeric,
  expected_partner numeric, expected_agent numeric, days_overdue integer, counter_mismatch boolean, collections_sum numeric, plans_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
  IF v_uid IS NULL OR NOT (public.has_role(v_uid, 'cto'::app_role) OR public.has_role(v_uid, 'ceo'::app_role) OR public.has_role(v_uid, 'cfo'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH plans AS (
    SELECT r.id, r.tenant_id, COALESCE(r.assigned_agent_id, r.agent_id) AS agent_id, r.status, r.rent_amount, r.duration_days, r.amount_repaid,
           (COALESCE(r.funded_at, r.disbursed_at) AT TIME ZONE 'Africa/Kampala')::date AS funded_on
      FROM public.cto_controlled_rent_plans c JOIN public.rent_requests r ON r.id = c.rent_request_id
  ), col AS (
    SELECT ac.rent_request_id, count(*)::int AS n, COALESCE(sum(ac.amount), 0) AS amt, max((ac.created_at AT TIME ZONE 'Africa/Kampala')::date) AS last_on
      FROM public.agent_collections ac
     WHERE ac.reversed_at IS NULL AND ac.rent_request_id IN (SELECT id FROM plans)
     GROUP BY ac.rent_request_id
  ), led AS (
    SELECT ac.rent_request_id,
      COALESCE(sum(CASE WHEN g.category = 'partner_returns_allocated' THEN CASE g.direction WHEN 'cash_in' THEN g.amount ELSE -g.amount END END), 0) AS partner,
      COALESCE(sum(CASE WHEN g.category = 'platform_fee_collected' THEN CASE g.direction WHEN 'cash_in' THEN g.amount ELSE -g.amount END END), 0) AS platform,
      COALESCE(sum(CASE WHEN g.category IN ('agent_commission_payable', 'agent_commission_earned') AND g.direction = 'cash_in' THEN g.amount END), 0) AS agent,
      COALESCE(sum(CASE WHEN g.category = 'treasury_fee_drawdown' THEN CASE g.direction WHEN 'cash_out' THEN g.amount ELSE -g.amount END END), 0) AS fees
      FROM public.agent_collections ac
      JOIN public.general_ledger g ON g.source_table = 'agent_collections' AND g.source_id = ac.id
     WHERE ac.reversed_at IS NULL AND ac.rent_request_id IN (SELECT id FROM plans)
     GROUP BY ac.rent_request_id
  ), rows AS (
    SELECT p.id AS rrid, p.tenant_id, p.agent_id AS agid, p.status AS st, p.funded_on AS fd, p.duration_days AS dd,
           p.rent_amount AS g_given, f.total_repayment AS due, COALESCE(p.amount_repaid, 0) AS rec,
           COALESCE(c.n, 0) AS cn, c.last_on AS lastd, COALESCE(c.amt, 0) AS csum,
           COALESCE(l.partner, 0) AS lp, COALESCE(l.platform, 0) AS lpl, COALESCE(l.agent, 0) AS la, COALESCE(l.fees, 0) AS lf
      FROM plans p
      LEFT JOIN col c ON c.rent_request_id = p.id
      LEFT JOIN led l ON l.rent_request_id = p.id
      CROSS JOIN LATERAL public.compute_rent_repayment(p.rent_amount, COALESCE(p.duration_days, 30)) f
  ), shaped AS (
    SELECT 'plan'::text AS rk, x.rrid, t.full_name AS tn, x.agid, a.full_name AS an, x.fd, COALESCE(x.dd, 0) AS dd, x.st,
           x.g_given, x.due, x.rec, x.cn, x.lastd, x.lp, x.lpl, x.la, x.lf, (x.csum - x.lf) AS pb,
           round(0.15 * x.g_given * COALESCE(x.dd, 0) / 30.0) AS ep, round(0.10 * x.due) AS ea,
           CASE WHEN x.rec < x.due AND x.fd IS NOT NULL THEN GREATEST(0, v_today - (x.fd + COALESCE(x.dd, 0))) ELSE 0 END AS od,
           (x.csum <> x.rec) AS mm, x.csum
      FROM rows x LEFT JOIN public.profiles t ON t.id = x.tenant_id LEFT JOIN public.profiles a ON a.id = x.agid
  )
  SELECT s.rk, s.rrid, s.tn, s.agid, s.an, s.fd, s.dd, s.st, s.g_given, s.due, s.rec, s.cn, s.lastd, s.lp, s.lpl, s.la, s.lf, s.pb, s.ep, s.ea, s.od, s.mm, s.csum, 1
    FROM shaped s
  UNION ALL
  SELECT 'summary', NULL::uuid, NULL, NULL::uuid, NULL, NULL::date, NULL::int, NULL, sum(s.g_given), sum(s.due), sum(s.rec), COALESCE(sum(s.cn), 0)::int, max(s.lastd),
         sum(s.lp), sum(s.lpl), sum(s.la), sum(s.lf), sum(s.pb), sum(s.ep), sum(s.ea), COALESCE(max(s.od), 0)::int, COALESCE(bool_or(s.mm), false), sum(s.csum), count(*)::int
    FROM shaped s
  ORDER BY 1 DESC, 21 DESC NULLS LAST, 11 ASC;
END;
$function$;

-- Plan search for the "Manage CTO plans" dialog: funded, repaying and completed Rent Plans by tenant name, phone or agent name, with a flag for
-- the ones already on the list. Read-only; the same roles as the tracker.
CREATE OR REPLACE FUNCTION public.cto_search_rent_plans(p_term text, p_limit integer DEFAULT 25)
RETURNS TABLE(rent_request_id uuid, tenant_name text, tenant_phone text, agent_name text, status text, rent_amount numeric, funded_on date, controlled boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_term text := btrim(COALESCE(p_term, ''));
BEGIN
  IF v_uid IS NULL OR NOT (public.has_role(v_uid, 'cto'::app_role) OR public.has_role(v_uid, 'ceo'::app_role) OR public.has_role(v_uid, 'cfo'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_term) < 2 THEN RETURN; END IF;
  RETURN QUERY
  SELECT r.id, t.full_name, t.phone, a.full_name, r.status, r.rent_amount,
         (COALESCE(r.funded_at, r.disbursed_at) AT TIME ZONE 'Africa/Kampala')::date,
         EXISTS (SELECT 1 FROM public.cto_controlled_rent_plans c WHERE c.rent_request_id = r.id)
    FROM public.rent_requests r
    LEFT JOIN public.profiles t ON t.id = r.tenant_id
    LEFT JOIN public.profiles a ON a.id = COALESCE(r.assigned_agent_id, r.agent_id)
   WHERE r.status IN ('funded', 'repaying', 'completed')
     AND (t.full_name ILIKE '%' || v_term || '%' OR t.phone ILIKE '%' || v_term || '%' OR a.full_name ILIKE '%' || v_term || '%')
   ORDER BY COALESCE(r.funded_at, r.disbursed_at) DESC NULLS LAST
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 100));
END;
$function$;

REVOKE ALL ON FUNCTION public.cto_add_controlled_plans(uuid[], text), public.cto_remove_controlled_plans(uuid[]), public.get_cto_controlled_plan_collections(), public.cto_search_rent_plans(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cto_add_controlled_plans(uuid[], text), public.cto_remove_controlled_plans(uuid[]), public.get_cto_controlled_plan_collections(), public.cto_search_rent_plans(text, integer) TO authenticated;
