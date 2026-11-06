-- Quiet Postgres 42501 "permission denied for function" on two RPCs.
--
-- Root cause: the native Android staff app (x-client-info supabase-kt/3.0.3,
-- user agent ktor-client) does not refresh its session. It polls about every
-- 10 seconds, and once the JWT is expired or missing it keeps calling with
-- only the anon key. PostgREST then runs the request as anon. Both functions
-- below are SECURITY DEFINER STABLE and had EXECUTE for postgres,
-- service_role and authenticated only, so Postgres logged
-- "permission denied for function" (sqlstate 42501) before the body ran.
-- The web client is not involved.
--
-- The real fix is in that Android app: refresh the session and stop polling
-- once the session is gone. This migration only stops the database log noise.
--
-- get_my_usage_report_notices() already returns no rows unless
-- auth.uid() IS NOT NULL AND the requisition belongs to that user. With no
-- JWT subject the predicate is false, so anon gets an empty result and the
-- function does not raise. GRANT EXECUTE to anon is safe for that body.
-- The preflight refuses the grant if the function is no longer one zero-arg
-- stable security-definer function, or if that auth.uid() IS NOT NULL filter
-- is gone.
--
-- get_cto_controlled_plan_collections() used to raise 42501 when auth.uid()
-- was null, so a bare anon grant would only change the error. The body below
-- is the reviewed definition (live pg_get_functiondef on byrzshwlentqvktcksem,
-- same SQL as 20261024130000) with one added line: if v_uid is null, return
-- an empty set before the role check. Signed-in callers who are not cto, ceo
-- or cfo still hit
-- RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'.
-- The return type, SECURITY DEFINER, STABLE and search_path=public are
-- unchanged. CREATE OR REPLACE keeps the existing EXECUTE grants. anon is
-- granted after the replace. The preflight refuses the replace when the live
-- definition, ignoring that one early return, is no longer the one reviewed.
--
-- Checked on byrzshwlentqvktcksem inside a transaction that was rolled back
-- (this file is not applied). With auth.uid() null and the session role
-- anon, both functions returned 0 rows and did not raise. An authenticated
-- caller whose uid is not cto, ceo or cfo still got
-- RAISE EXCEPTION 'Not authorized' (42501) from the collections function.
-- After the grants, both ACLs still included postgres, service_role and
-- authenticated, plus anon.

do $preflight$
declare
  def text;
  norm text;
  nfuncs integer;
begin
  select count(*)
    into nfuncs
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'get_my_usage_report_notices';

  if nfuncs <> 1 then
    raise exception 'get_my_usage_report_notices has % overloads in public; expected one zero-arg function — refusing anon grant', nfuncs;
  end if;

  select pg_get_functiondef(p.oid)
    into def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'get_my_usage_report_notices'
    and pg_get_function_identity_arguments(p.oid) = ''
    and p.prosecdef
    and p.provolatile = 's';

  if def is null then
    raise exception 'get_my_usage_report_notices() is missing, is not zero-arg, or is not stable security definer — refusing anon grant';
  end if;

  norm := lower(regexp_replace(def, '\s+', ' ', 'g'));
  if position('auth.uid() is not null' in norm) = 0 then
    raise exception 'get_my_usage_report_notices() no longer contains auth.uid() IS NOT NULL — refusing anon grant';
  end if;

  select count(*)
    into nfuncs
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'get_cto_controlled_plan_collections';

  if nfuncs <> 1 then
    raise exception 'get_cto_controlled_plan_collections has % overloads in public; expected one zero-arg function — refusing replace and anon grant', nfuncs;
  end if;

  select pg_get_functiondef(p.oid)
    into def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'get_cto_controlled_plan_collections'
    and pg_get_function_identity_arguments(p.oid) = ''
    and p.prosecdef
    and p.provolatile = 's'
    and exists (
      select 1
      from unnest(coalesce(p.proconfig, array[]::text[])) as cfg
      where cfg = 'search_path=public'
    );

  if def is null then
    raise exception 'get_cto_controlled_plan_collections() is missing, is not zero-arg, or is not stable security definer with search_path=public — refusing replace and anon grant';
  end if;

  -- Drop the early return so a re-run still matches the reviewed body.
  norm := lower(regexp_replace(def, '\s+', ' ', 'g'));
  norm := replace(norm, 'if v_uid is null then return; end if;', '');
  norm := regexp_replace(norm, '\s+', ' ', 'g');
  if md5(norm) <> '48fd9819cf6763f0e96dd6b1fa793020' then
    raise exception 'get_cto_controlled_plan_collections() no longer matches the reviewed definition — refusing replace and anon grant';
  end if;
end
$preflight$;

-- The tracker: one row per controlled plan, then a summary row (row_kind = 'summary').
-- Empty for a missing session. Signed-in callers who are not cto, ceo or cfo still raise 42501.
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
  IF v_uid IS NULL THEN RETURN; END IF;
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

grant execute on function public.get_my_usage_report_notices() to anon;
grant execute on function public.get_cto_controlled_plan_collections() to anon;
