-- Agent Ops metrics: the agent network's listings, listing money, advances, locations and teams. NEW read-only functions only; nothing existing is
-- altered or replaced, nothing is written, no index is added (see docs/TOPS_BUILD_LOG.md for slow-query notes).
--
--   agent_ops_metrics_totals(p_start, p_end)                                    one row of totals
--   agent_ops_metrics_agents(p_start, p_end, p_search, p_sort, p_scope, p_limit, p_offset)   one row per agent
--   agent_ops_metrics_locations(p_start, p_end, p_level)                        houses by region / district / sub_county
--   agent_ops_metrics_pins(p_min_lat, p_min_lng, p_max_lat, p_max_lng, p_limit) map pins (at most 2000)
--   agent_ops_metrics_main_agents(p_start, p_end, p_limit, p_offset)            one row per main (parent) agent with their team
--   _aom_allowed / _aom_scope / _aom_rows                                        internal helpers, executable by the owner only
--
-- Access: auth.uid() present and a user_roles row (enabled = true) for agent_ops, coo, ceo, cto, manager or super_admin, else SQLSTATE 42501.
-- SECURITY DEFINER, STABLE, search_path = public. EXECUTE for authenticated only (revoked from PUBLIC, anon, service_role).
--
-- Definitions (the only ones; also in supabase/AGENTS.md):
--   dates       Kampala calendar days: [p_start 00:00, p_end + 1 day 00:00) Africa/Kampala.
--   deleted     profiles.deleted_at IS NOT NULL, or a deleted_accounts row 'soft_deleted' not restored or purged. Left out everywhere.
--   scope       'qualifying' = agent_ops_qualifying_agent_ids(); 'linked' = both ends of a verified agent_subagents link; 'all' = qualifying + linked +
--               everyone with a listing, a listing rejection, an advance, or listing money in the range (not the 59,000 default agent roles).
--   houses      house_listings created in the range by the agent. verified = verified true. pending = not verified and status <> 'rejected'.
--               rejected = agent_listing_rejections in the range (rejected listings are mostly deleted, so this table is the history).
--               GPS = latitude and longitude both present.
--   LISTING MONEY comes ONLY from the ledger, never agent_earnings (which is incomplete): v_general_ledger_operational (isolated entries out),
--               classification <> 'admin_correction', effective scope 'wallet', created in the range.
--               earned   cash_in legs: category agent_commission_earned with source_table listing_bonus_approvals, and category agent_commission with
--                        source_table house_listings (both to the agent's user_id).
--               clawed back  listing_rejection_recovery (platform leg; the agent is the user on the wallet leg of the same transaction group;
--                        a cash_out recovery leg is a reversal and is subtracted) + listing_rejection_offset (wallet cash_in to the agent).
--               Reversed money is exactly what the ledger records as an opposite leg or in voided_ledger_entries (none of those rows is still in
--               general_ledger); there is no reversed flag on general_ledger.
--   advances    agent_advances not cancelled and not reversed. given = principal issued in the range; repaid = principal less outstanding for those;
--               outstanding and overdue are today's balances of active / overdue advances (a snapshot, not range-bound).
--   main agent  the verified parent in agent_subagents (the earliest verified link of a sub-agent); a team is the parent's verified sub-agents.
-- Rollback: supabase/rollbacks/20261016100000_agent_ops_metrics.rollback.sql

-- ---------- helpers (owner only) ----------

CREATE OR REPLACE FUNCTION public._aom_allowed()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = auth.uid() AND ur.enabled = true
       AND ur.role::text IN ('agent_ops', 'coo', 'ceo', 'cto', 'manager', 'super_admin'));
$$;

CREATE OR REPLACE FUNCTION public._aom_scope(p_scope text, p_start timestamptz, p_end timestamptz)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH gone AS MATERIALIZED (
    SELECT p.id FROM public.profiles p WHERE p.deleted_at IS NOT NULL
    UNION
    SELECT d.user_id FROM public.deleted_accounts d
     WHERE d.status = 'soft_deleted' AND d.restored_at IS NULL AND d.purged_at IS NULL AND d.user_id IS NOT NULL
  ), raw AS (
    SELECT q.agent_id AS x FROM public.agent_ops_qualifying_agent_ids() q WHERE p_scope IN ('qualifying', 'all')
    UNION
    SELECT s.parent_agent_id FROM public.agent_subagents s WHERE p_scope IN ('linked', 'all') AND s.status = 'verified'
    UNION
    SELECT s.sub_agent_id FROM public.agent_subagents s WHERE p_scope IN ('linked', 'all') AND s.status = 'verified'
    UNION
    SELECT h.agent_id FROM public.house_listings h WHERE p_scope = 'all'
    UNION
    SELECT r.agent_id FROM public.agent_listing_rejections r WHERE p_scope = 'all'
    UNION
    SELECT a.agent_id FROM public.agent_advances a WHERE p_scope = 'all'
    UNION
    SELECT gl.user_id FROM public.general_ledger gl
     WHERE p_scope = 'all' AND gl.user_id IS NOT NULL AND gl.created_at >= p_start AND gl.created_at < p_end
       AND gl.ledger_scope = 'wallet' AND gl.direction = 'cash_in'
       AND ((gl.category = 'agent_commission_earned' AND gl.source_table = 'listing_bonus_approvals')
         OR (gl.category = 'agent_commission' AND gl.source_table = 'house_listings')
         OR gl.category = 'listing_rejection_offset')
  )
  SELECT DISTINCT raw.x FROM raw
   WHERE raw.x IS NOT NULL AND NOT EXISTS (SELECT 1 FROM gone g WHERE g.id = raw.x);
END;
$$;

CREATE OR REPLACE FUNCTION public._aom_rows(p_start date, p_end date, p_scope text)
RETURNS TABLE (
  agent_id uuid, name text, phone text, main_agent_id uuid, main_agent_name text,
  houses_listed bigint, houses_approved bigint, houses_pending bigint, houses_rejected bigint, houses_gps bigint,
  top_district text, gps_share numeric,
  listing_earned numeric, clawed_back numeric, net numeric,
  advance_principal numeric, advance_outstanding numeric, advance_status text, last_listing date
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_s timestamptz := p_start::timestamp AT TIME ZONE 'Africa/Kampala';
  v_e timestamptz := (p_end + 1)::timestamp AT TIME ZONE 'Africa/Kampala';
BEGIN
  RETURN QUERY
  WITH sc AS MATERIALIZED (SELECT s.id FROM public._aom_scope(p_scope, v_s, v_e) s),
  hl AS (
    SELECT h.agent_id AS aid, count(*) AS listed,
           count(*) FILTER (WHERE h.verified IS TRUE) AS approved,
           count(*) FILTER (WHERE h.verified IS NOT TRUE AND COALESCE(h.status, '') <> 'rejected') AS pending,
           count(*) FILTER (WHERE h.latitude IS NOT NULL AND h.longitude IS NOT NULL) AS gps
      FROM public.house_listings h
     WHERE h.created_at >= v_s AND h.created_at < v_e AND h.agent_id IN (SELECT id FROM sc)
     GROUP BY h.agent_id
  ),
  dist AS (
    SELECT DISTINCT ON (d.aid) d.aid, d.district FROM (
      SELECT h.agent_id AS aid, h.district, count(*) AS n FROM public.house_listings h
       WHERE h.created_at >= v_s AND h.created_at < v_e AND h.agent_id IN (SELECT id FROM sc) AND h.district IS NOT NULL AND h.district <> ''
       GROUP BY h.agent_id, h.district) d
     ORDER BY d.aid, d.n DESC, d.district
  ),
  lastl AS (SELECT h.agent_id AS aid, max(h.created_at) AS at FROM public.house_listings h WHERE h.agent_id IN (SELECT id FROM sc) GROUP BY h.agent_id),
  rej AS (
    SELECT r.agent_id AS aid, count(*) AS n FROM public.agent_listing_rejections r
     WHERE r.rejected_at >= v_s AND r.rejected_at < v_e AND r.agent_id IN (SELECT id FROM sc) GROUP BY r.agent_id
  ),
  led AS MATERIALIZED (
    SELECT gl.id, gl.user_id, gl.category, gl.direction, gl.amount, gl.source_table, gl.transaction_group_id, gl.effective_ledger_scope AS scope
      FROM public.v_general_ledger_operational gl
     WHERE gl.created_at >= v_s AND gl.created_at < v_e AND gl.classification <> 'admin_correction'
       AND ((gl.category IN ('agent_commission_earned', 'agent_commission', 'listing_rejection_offset') AND gl.effective_ledger_scope = 'wallet')
         OR gl.category = 'listing_rejection_recovery')
  ),
  earn AS (
    SELECT l.user_id AS aid, sum(l.amount) AS amt FROM led l
     WHERE l.scope = 'wallet' AND l.direction = 'cash_in' AND l.user_id IN (SELECT id FROM sc)
       AND ((l.category = 'agent_commission_earned' AND l.source_table = 'listing_bonus_approvals') OR (l.category = 'agent_commission' AND l.source_table = 'house_listings'))
     GROUP BY l.user_id
  ),
  claw AS (
    SELECT c.aid, sum(c.amt) AS amt FROM (
      SELECT l.user_id AS aid, l.amount AS amt FROM led l WHERE l.category = 'listing_rejection_offset' AND l.direction = 'cash_in' AND l.user_id IS NOT NULL
      UNION ALL
      SELECT w.user_id, CASE WHEN l.direction = 'cash_in' THEN l.amount ELSE -l.amount END
        FROM led l
        JOIN public.general_ledger w ON w.transaction_group_id = l.transaction_group_id AND w.ledger_scope = 'wallet' AND w.user_id IS NOT NULL
       WHERE l.category = 'listing_rejection_recovery'
    ) c WHERE c.aid IN (SELECT id FROM sc) GROUP BY c.aid
  ),
  adv AS (
    SELECT a.agent_id AS aid,
           COALESCE(sum(a.principal) FILTER (WHERE a.issued_at >= v_s AND a.issued_at < v_e), 0) AS principal,
           COALESCE(sum(a.outstanding_balance) FILTER (WHERE a.status IN ('active', 'overdue')), 0) AS outstanding
      FROM public.agent_advances a
     WHERE a.status <> 'cancelled' AND a.reversed_at IS NULL AND a.agent_id IN (SELECT id FROM sc)
     GROUP BY a.agent_id
  ),
  advst AS (
    SELECT DISTINCT ON (a.agent_id) a.agent_id AS aid, a.status FROM public.agent_advances a
     WHERE a.status <> 'cancelled' AND a.reversed_at IS NULL AND a.agent_id IN (SELECT id FROM sc)
     ORDER BY a.agent_id, a.issued_at DESC NULLS LAST, a.created_at DESC
  ),
  par AS (
    SELECT DISTINCT ON (s.sub_agent_id) s.sub_agent_id AS aid, s.parent_agent_id AS pid FROM public.agent_subagents s
     WHERE s.status = 'verified' AND s.sub_agent_id IN (SELECT id FROM sc)
     ORDER BY s.sub_agent_id, s.verified_at NULLS LAST, s.created_at
  )
  SELECT sc.id, COALESCE(pr.full_name, 'Unnamed agent'), pr.phone, par.pid, pp.full_name,
         COALESCE(hl.listed, 0), COALESCE(hl.approved, 0), COALESCE(hl.pending, 0), COALESCE(rej.n, 0), COALESCE(hl.gps, 0),
         dist.district,
         CASE WHEN COALESCE(hl.listed, 0) > 0 THEN round(100.0 * hl.gps / hl.listed, 1) END,
         COALESCE(earn.amt, 0), COALESCE(claw.amt, 0), COALESCE(earn.amt, 0) - COALESCE(claw.amt, 0),
         COALESCE(adv.principal, 0), COALESCE(adv.outstanding, 0), advst.status,
         (lastl.at AT TIME ZONE 'Africa/Kampala')::date
    FROM sc
    LEFT JOIN public.profiles pr ON pr.id = sc.id
    LEFT JOIN par ON par.aid = sc.id
    LEFT JOIN public.profiles pp ON pp.id = par.pid
    LEFT JOIN hl ON hl.aid = sc.id
    LEFT JOIN dist ON dist.aid = sc.id
    LEFT JOIN lastl ON lastl.aid = sc.id
    LEFT JOIN rej ON rej.aid = sc.id
    LEFT JOIN earn ON earn.aid = sc.id
    LEFT JOIN claw ON claw.aid = sc.id
    LEFT JOIN adv ON adv.aid = sc.id
    LEFT JOIN advst ON advst.aid = sc.id;
END;
$$;

-- ---------- 1. totals ----------

CREATE OR REPLACE FUNCTION public.agent_ops_metrics_totals(p_start date, p_end date)
RETURNS TABLE (
  as_at date, range_start date, range_end date, basis text,
  agents_role bigint, linked_subagents bigint, qualifying_agents bigint,
  listers_ever bigint, listers_in_range bigint,
  houses_listed bigint, houses_verified bigint, houses_pending bigint, houses_rejected bigint, houses_with_gps bigint,
  listing_earned numeric, listing_clawed_back numeric,
  advances_given_count bigint, advances_given_amount numeric, advances_repaid numeric, advances_outstanding numeric,
  advances_overdue_count bigint, advances_overdue_amount numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_s timestamptz; v_e timestamptz;
BEGIN
  IF NOT public._aom_allowed() THEN RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL THEN RAISE EXCEPTION 'RANGE_REQUIRED: p_start and p_end are required' USING ERRCODE = '22023'; END IF;
  IF p_end < p_start THEN RAISE EXCEPTION 'RANGE_INVALID: p_end is before p_start' USING ERRCODE = '22023'; END IF;
  v_s := p_start::timestamp AT TIME ZONE 'Africa/Kampala';
  v_e := (p_end + 1)::timestamp AT TIME ZONE 'Africa/Kampala';

  RETURN QUERY
  WITH gone AS MATERIALIZED (
    SELECT p.id FROM public.profiles p WHERE p.deleted_at IS NOT NULL
    UNION
    SELECT d.user_id FROM public.deleted_accounts d
     WHERE d.status = 'soft_deleted' AND d.restored_at IS NULL AND d.purged_at IS NULL AND d.user_id IS NOT NULL
  ),
  rws AS MATERIALIZED (SELECT * FROM public._aom_rows(p_start, p_end, 'all')),
  adv AS (
    SELECT a.* FROM public.agent_advances a
     WHERE a.status <> 'cancelled' AND a.reversed_at IS NULL AND NOT EXISTS (SELECT 1 FROM gone g WHERE g.id = a.agent_id)
  )
  SELECT v_today, p_start, p_end,
    'Kampala days. Houses are listings created in the range; listing money only from the ledger (not agent_earnings); advances given/repaid are for advances issued in the range, outstanding and overdue are today''s balances.'::text,
    (SELECT count(DISTINCT ur.user_id) FROM public.user_roles ur WHERE ur.role::text = 'agent' AND ur.enabled AND NOT EXISTS (SELECT 1 FROM gone g WHERE g.id = ur.user_id)),
    (SELECT count(DISTINCT s.sub_agent_id) FROM public.agent_subagents s WHERE s.status = 'verified' AND NOT EXISTS (SELECT 1 FROM gone g WHERE g.id = s.sub_agent_id)),
    (SELECT count(*) FROM public._aom_scope('qualifying', v_s, v_e)),
    (SELECT count(DISTINCT h.agent_id) FROM public.house_listings h WHERE NOT EXISTS (SELECT 1 FROM gone g WHERE g.id = h.agent_id)),
    (SELECT count(*) FROM rws WHERE rws.houses_listed > 0),
    (SELECT COALESCE(sum(rws.houses_listed), 0)::bigint FROM rws),
    (SELECT COALESCE(sum(rws.houses_approved), 0)::bigint FROM rws),
    (SELECT COALESCE(sum(rws.houses_pending), 0)::bigint FROM rws),
    (SELECT COALESCE(sum(rws.houses_rejected), 0)::bigint FROM rws),
    (SELECT COALESCE(sum(rws.houses_gps), 0)::bigint FROM rws),
    (SELECT COALESCE(sum(rws.listing_earned), 0) FROM rws),
    (SELECT COALESCE(sum(rws.clawed_back), 0) FROM rws),
    (SELECT count(*) FROM adv WHERE adv.issued_at >= v_s AND adv.issued_at < v_e),
    (SELECT COALESCE(sum(adv.principal), 0) FROM adv WHERE adv.issued_at >= v_s AND adv.issued_at < v_e),
    (SELECT COALESCE(sum(GREATEST(adv.principal - COALESCE(adv.outstanding_balance, 0), 0)), 0) FROM adv WHERE adv.issued_at >= v_s AND adv.issued_at < v_e),
    (SELECT COALESCE(sum(adv.outstanding_balance), 0) FROM adv WHERE adv.status IN ('active', 'overdue')),
    (SELECT count(*) FROM adv WHERE adv.status = 'overdue'),
    (SELECT COALESCE(sum(adv.outstanding_balance), 0) FROM adv WHERE adv.status = 'overdue');
END;
$$;

-- ---------- 2. one row per agent ----------

CREATE OR REPLACE FUNCTION public.agent_ops_metrics_agents(
  p_start date, p_end date, p_search text DEFAULT NULL, p_sort text DEFAULT NULL, p_scope text DEFAULT 'qualifying',
  p_limit integer DEFAULT 50, p_offset integer DEFAULT 0
)
RETURNS TABLE (
  agent_id uuid, name text, phone text, main_agent_id uuid, main_agent_name text,
  houses_listed bigint, houses_approved bigint, houses_pending bigint, houses_rejected bigint,
  top_district text, gps_share numeric,
  listing_earned numeric, clawed_back numeric, net numeric,
  advance_principal numeric, advance_outstanding numeric, advance_status text,
  last_listing date, total_matched bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_scope text := lower(COALESCE(NULLIF(btrim(p_scope), ''), 'qualifying'));
  v_sort text := lower(COALESCE(NULLIF(btrim(p_sort), ''), 'houses_listed'));
  v_dir text := 'desc';
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF NOT public._aom_allowed() THEN RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL THEN RAISE EXCEPTION 'RANGE_REQUIRED: p_start and p_end are required' USING ERRCODE = '22023'; END IF;
  IF p_end < p_start THEN RAISE EXCEPTION 'RANGE_INVALID: p_end is before p_start' USING ERRCODE = '22023'; END IF;
  IF v_scope NOT IN ('linked', 'qualifying', 'all') THEN RAISE EXCEPTION 'SCOPE_INVALID: p_scope must be linked, qualifying or all' USING ERRCODE = '22023'; END IF;
  IF position(':' IN v_sort) > 0 THEN
    v_dir := split_part(v_sort, ':', 2);
    v_sort := split_part(v_sort, ':', 1);
    IF v_dir NOT IN ('asc', 'desc') THEN RAISE EXCEPTION 'SORT_INVALID: direction must be asc or desc' USING ERRCODE = '22023'; END IF;
  ELSIF v_sort = 'name' THEN v_dir := 'asc';
  END IF;
  IF v_sort NOT IN ('name', 'houses_listed', 'houses_approved', 'houses_pending', 'houses_rejected', 'listing_earned', 'clawed_back', 'net', 'advance_outstanding', 'last_listing') THEN
    RAISE EXCEPTION 'SORT_INVALID: unknown sort %', v_sort USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH m AS (
    SELECT r.* FROM public._aom_rows(p_start, p_end, v_scope) r
     WHERE v_search IS NULL
        OR r.name ILIKE '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
        OR COALESCE(r.phone, '') ILIKE '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  )
  SELECT m.agent_id, m.name, m.phone, m.main_agent_id, m.main_agent_name,
         m.houses_listed, m.houses_approved, m.houses_pending, m.houses_rejected, m.top_district, m.gps_share,
         m.listing_earned, m.clawed_back, m.net, m.advance_principal, m.advance_outstanding, m.advance_status, m.last_listing,
         count(*) OVER ()
    FROM m
   ORDER BY
     (CASE WHEN v_sort = 'name' AND v_dir = 'asc' THEN lower(m.name) END) ASC,
     (CASE WHEN v_sort = 'name' AND v_dir = 'desc' THEN lower(m.name) END) DESC,
     (CASE WHEN v_sort <> 'name' AND v_dir = 'asc' THEN
        CASE v_sort WHEN 'houses_listed' THEN m.houses_listed::numeric WHEN 'houses_approved' THEN m.houses_approved::numeric WHEN 'houses_pending' THEN m.houses_pending::numeric
          WHEN 'houses_rejected' THEN m.houses_rejected::numeric WHEN 'listing_earned' THEN m.listing_earned WHEN 'clawed_back' THEN m.clawed_back WHEN 'net' THEN m.net
          WHEN 'advance_outstanding' THEN m.advance_outstanding WHEN 'last_listing' THEN (m.last_listing - DATE '2000-01-01')::numeric END END) ASC NULLS LAST,
     (CASE WHEN v_sort <> 'name' AND v_dir = 'desc' THEN
        CASE v_sort WHEN 'houses_listed' THEN m.houses_listed::numeric WHEN 'houses_approved' THEN m.houses_approved::numeric WHEN 'houses_pending' THEN m.houses_pending::numeric
          WHEN 'houses_rejected' THEN m.houses_rejected::numeric WHEN 'listing_earned' THEN m.listing_earned WHEN 'clawed_back' THEN m.clawed_back WHEN 'net' THEN m.net
          WHEN 'advance_outstanding' THEN m.advance_outstanding WHEN 'last_listing' THEN (m.last_listing - DATE '2000-01-01')::numeric END END) DESC NULLS LAST,
     lower(m.name), m.agent_id
   LIMIT v_limit OFFSET v_offset;
END;
$$;

-- ---------- 3. locations and pins ----------

CREATE OR REPLACE FUNCTION public.agent_ops_metrics_locations(p_start date, p_end date, p_level text DEFAULT 'district')
RETURNS TABLE (region text, district text, sub_county text, houses_listed bigint, houses_verified bigint, houses_pending bigint, houses_with_gps bigint, agents bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_level text := lower(COALESCE(NULLIF(btrim(p_level), ''), 'district'));
  v_s timestamptz; v_e timestamptz;
BEGIN
  IF NOT public._aom_allowed() THEN RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL THEN RAISE EXCEPTION 'RANGE_REQUIRED: p_start and p_end are required' USING ERRCODE = '22023'; END IF;
  IF p_end < p_start THEN RAISE EXCEPTION 'RANGE_INVALID: p_end is before p_start' USING ERRCODE = '22023'; END IF;
  IF v_level NOT IN ('region', 'district', 'sub_county') THEN RAISE EXCEPTION 'LEVEL_INVALID: p_level must be region, district or sub_county' USING ERRCODE = '22023'; END IF;
  v_s := p_start::timestamp AT TIME ZONE 'Africa/Kampala';
  v_e := (p_end + 1)::timestamp AT TIME ZONE 'Africa/Kampala';

  RETURN QUERY
  WITH gone AS MATERIALIZED (
    SELECT p.id FROM public.profiles p WHERE p.deleted_at IS NOT NULL
    UNION
    SELECT d.user_id FROM public.deleted_accounts d WHERE d.status = 'soft_deleted' AND d.restored_at IS NULL AND d.purged_at IS NULL AND d.user_id IS NOT NULL
  ), hl AS (
    SELECT h.*, COALESCE(NULLIF(h.region, ''), '(none)') AS rg, COALESCE(NULLIF(h.district, ''), '(none)') AS ds, COALESCE(NULLIF(h.sub_county, ''), '(none)') AS sc
      FROM public.house_listings h
     WHERE h.created_at >= v_s AND h.created_at < v_e AND NOT EXISTS (SELECT 1 FROM gone g WHERE g.id = h.agent_id)
  )
  SELECT hl.rg,
         CASE WHEN v_level IN ('district', 'sub_county') THEN hl.ds END,
         CASE WHEN v_level = 'sub_county' THEN hl.sc END,
         count(*), count(*) FILTER (WHERE hl.verified IS TRUE),
         count(*) FILTER (WHERE hl.verified IS NOT TRUE AND COALESCE(hl.status, '') <> 'rejected'),
         count(*) FILTER (WHERE hl.latitude IS NOT NULL AND hl.longitude IS NOT NULL),
         count(DISTINCT hl.agent_id)
    FROM hl
   GROUP BY hl.rg, CASE WHEN v_level IN ('district', 'sub_county') THEN hl.ds END, CASE WHEN v_level = 'sub_county' THEN hl.sc END
   ORDER BY count(*) DESC, 1, 2, 3;
END;
$$;

CREATE OR REPLACE FUNCTION public.agent_ops_metrics_pins(p_min_lat double precision, p_min_lng double precision, p_max_lat double precision, p_max_lng double precision, p_limit integer DEFAULT 500)
RETURNS TABLE (listing_id uuid, latitude double precision, longitude double precision, verified boolean, status text, region text, district text, agent_id uuid, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
DECLARE v_limit int := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 2000);
BEGIN
  IF NOT public._aom_allowed() THEN RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'; END IF;
  IF p_min_lat IS NULL OR p_min_lng IS NULL OR p_max_lat IS NULL OR p_max_lng IS NULL THEN RAISE EXCEPTION 'BOX_REQUIRED: the four corners are required' USING ERRCODE = '22023'; END IF;
  IF p_min_lat > p_max_lat OR p_min_lng > p_max_lng THEN RAISE EXCEPTION 'BOX_INVALID: min is above max' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  SELECT h.id, h.latitude, h.longitude, h.verified, h.status, h.region, h.district, h.agent_id, h.created_at
    FROM public.house_listings h
   WHERE h.latitude BETWEEN p_min_lat AND p_max_lat AND h.longitude BETWEEN p_min_lng AND p_max_lng
     AND h.latitude IS NOT NULL AND h.longitude IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = h.agent_id AND p.deleted_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM public.deleted_accounts d WHERE d.user_id = h.agent_id AND d.status = 'soft_deleted' AND d.restored_at IS NULL AND d.purged_at IS NULL)
   ORDER BY h.created_at DESC, h.id
   LIMIT v_limit;
END;
$$;

-- ---------- 4. main agents and their teams ----------

CREATE OR REPLACE FUNCTION public.agent_ops_metrics_main_agents(p_start date, p_end date, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS TABLE (main_agent_id uuid, name text, phone text, team_size bigint, team_houses bigint, team_earnings numeric, team_advances_outstanding numeric, total_matched bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF NOT public._aom_allowed() THEN RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL THEN RAISE EXCEPTION 'RANGE_REQUIRED: p_start and p_end are required' USING ERRCODE = '22023'; END IF;
  IF p_end < p_start THEN RAISE EXCEPTION 'RANGE_INVALID: p_end is before p_start' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  WITH r AS MATERIALIZED (SELECT * FROM public._aom_rows(p_start, p_end, 'linked')),
  t AS (
    SELECT r.main_agent_id AS pid, count(*) AS size, sum(r.houses_listed) AS houses, sum(r.listing_earned) AS earn, sum(r.advance_outstanding) AS adv
      FROM r WHERE r.main_agent_id IS NOT NULL GROUP BY r.main_agent_id
  )
  SELECT t.pid, COALESCE(p.full_name, 'Unnamed agent'), p.phone, t.size, COALESCE(t.houses, 0)::bigint, COALESCE(t.earn, 0), COALESCE(t.adv, 0), count(*) OVER ()
    FROM t LEFT JOIN public.profiles p ON p.id = t.pid
   WHERE NOT EXISTS (SELECT 1 FROM public.profiles x WHERE x.id = t.pid AND x.deleted_at IS NOT NULL)
   ORDER BY t.size DESC, t.houses DESC NULLS LAST, t.pid
   LIMIT v_limit OFFSET v_offset;
END;
$$;

COMMENT ON FUNCTION public.agent_ops_metrics_totals(date, date) IS 'Read-only Agent Ops metrics totals (listings, listing money from the ledger, advances) for Kampala days p_start..p_end. Staff roles only.';
COMMENT ON FUNCTION public.agent_ops_metrics_agents(date, date, text, text, text, integer, integer) IS 'Read-only Agent Ops metrics, one row per agent (scope linked / qualifying / all), sortable, paged (limit 200). Staff roles only.';
COMMENT ON FUNCTION public.agent_ops_metrics_locations(date, date, text) IS 'Read-only Agent Ops metrics: houses by region, district or sub_county for Kampala days p_start..p_end. Staff roles only.';
COMMENT ON FUNCTION public.agent_ops_metrics_pins(double precision, double precision, double precision, double precision, integer) IS 'Read-only Agent Ops metrics: house map pins inside a box, at most 2000. Staff roles only.';
COMMENT ON FUNCTION public.agent_ops_metrics_main_agents(date, date, integer, integer) IS 'Read-only Agent Ops metrics: per main (parent) agent, the team size, houses, listing earnings and advances outstanding. Staff roles only.';

REVOKE ALL ON FUNCTION public._aom_allowed() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._aom_scope(text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._aom_rows(date, date, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_ops_metrics_totals(date, date) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.agent_ops_metrics_agents(date, date, text, text, text, integer, integer) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.agent_ops_metrics_locations(date, date, text) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.agent_ops_metrics_pins(double precision, double precision, double precision, double precision, integer) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.agent_ops_metrics_main_agents(date, date, integer, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.agent_ops_metrics_totals(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_ops_metrics_agents(date, date, text, text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_ops_metrics_locations(date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_ops_metrics_pins(double precision, double precision, double precision, double precision, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_ops_metrics_main_agents(date, date, integer, integer) TO authenticated;
