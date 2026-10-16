-- Agent Ops metrics, part 2: listing quality and risk. NEW read-only functions only; nothing existing is altered or replaced (the five
-- agent_ops_metrics_* functions of 20261016100000 and the _aom_* helpers are only called), nothing is written, no index is added.
--
--   agent_ops_metrics_listing_quality(p_start, p_end, p_limit, p_offset)  jsonb: { network, agents[], waiting[] }
--   agent_ops_metrics_risk(p_start, p_end, p_limit, p_offset)             jsonb: { summary, advance_no_listing[], advance_vs_earnings[],
--                                                                          inactive_listers[], never_listed_subagents[], main_agents_by_advance[] }
--
-- Access, grants and error codes are the same as the first five: _aom_allowed() (agent_ops, coo, ceo, cto, manager, super_admin with
-- user_roles.enabled), else 42501; RANGE_REQUIRED / RANGE_INVALID are 22023. SECURITY DEFINER, STABLE, search_path = public;
-- EXECUTE for authenticated only (revoked from PUBLIC, anon, service_role). p_limit is clamped to 1..200 and p_offset to 0 or more; each list
-- in the answer is paged with the same limit and offset and carries its full count in the summary / network object.
--
-- Definitions (the only ones; also in supabase/AGENTS.md). Everything the first migration defines (Kampala days, deleted accounts, houses,
-- verified / pending, listing money from the ledger only, advances, main agent) applies unchanged because the rows come from _aom_rows(..., 'all').
--   quality rows   one per agent who listed at least one house created in the range (so the rows add up to the totals' houses listed).
--   approval_rate  100 x houses verified / houses listed, one decimal.
--   avg_days_to_verify  average of (verified_at - created_at) in days, one decimal, over the verified houses of the range that have a verified_at.
--   currently_rejected  houses of the range that are not verified and whose listing status is 'rejected'. verified + pending + currently_rejected
--                  = listed for every row and for the network row. This is NOT agent_listing_rejections (rejection events in the range), which is
--                  returned beside it as rejection_events.
--   occupied / empty  houses of the range with / without house_listings.tenant_id.
--   earn_per_approved  listing earnings (ledger) / houses verified, whole UGX, null when nothing is verified. In the network row the earnings are
--                  everyone's (listing_earned, equal to the totals, including agents who listed nothing in the range); listing_earned_listers is the
--                  part earned by the agents in the rows (their sum).
--   waiting        pending houses (not verified, status not 'rejected') of ANY date, oldest first: the queue today, not range-bound;
--                  days_waiting = Kampala days from the day listed to today.
--   advance_no_listing  agents whose advance outstanding (today) is above 0 and who listed no house in the range.
--   advance_vs_earnings  agents with advance outstanding above 0: ratio = advance outstanding / listing earnings of the range (two decimals,
--                  null when earnings are 0); flag = 'no_earnings' (earnings 0), 'high' (ratio at least 3), 'watch' (at least 1), else 'ok'.
--                  Worst flag first, then biggest advance outstanding.
--   inactive_listers  agents who have listed before but listed nothing in the last 30 Kampala days (today and the 29 days before it); not range-bound.
--   never_listed_subagents  verified sub-agents (agent_subagents.status = 'verified') with no house_listings row at all; not range-bound.
--   main_agents_by_advance  main agents (verified parents) ranked by the advance outstanding of their team, from _aom_rows(..., 'linked').
-- Rollback: supabase/rollbacks/20261016180000_agent_ops_metrics_quality_risk.rollback.sql

CREATE OR REPLACE FUNCTION public.agent_ops_metrics_listing_quality(p_start date, p_end date, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_s timestamptz; v_e timestamptz;
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_out jsonb;
BEGIN
  IF NOT public._aom_allowed() THEN RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL THEN RAISE EXCEPTION 'RANGE_REQUIRED: p_start and p_end are required' USING ERRCODE = '22023'; END IF;
  IF p_end < p_start THEN RAISE EXCEPTION 'RANGE_INVALID: p_end is before p_start' USING ERRCODE = '22023'; END IF;
  v_s := p_start::timestamp AT TIME ZONE 'Africa/Kampala';
  v_e := (p_end + 1)::timestamp AT TIME ZONE 'Africa/Kampala';

  WITH gone AS MATERIALIZED (
    SELECT p.id FROM public.profiles p WHERE p.deleted_at IS NOT NULL
    UNION
    SELECT d.user_id FROM public.deleted_accounts d
     WHERE d.status = 'soft_deleted' AND d.restored_at IS NULL AND d.purged_at IS NULL AND d.user_id IS NOT NULL
  ),
  rws_all AS MATERIALIZED (SELECT * FROM public._aom_rows(p_start, p_end, 'all')),
  rws AS MATERIALIZED (SELECT * FROM rws_all r WHERE r.houses_listed > 0),
  hx AS MATERIALIZED (
    SELECT h.agent_id AS aid,
           count(*) FILTER (WHERE h.verified IS NOT TRUE AND h.status = 'rejected') AS rej_now,
           count(*) FILTER (WHERE h.tenant_id IS NOT NULL) AS occupied,
           count(*) FILTER (WHERE h.tenant_id IS NULL) AS empty_n,
           sum(extract(epoch FROM (h.verified_at - h.created_at)) / 86400.0) FILTER (WHERE h.verified IS TRUE AND h.verified_at IS NOT NULL AND h.verified_at >= h.created_at) AS dsum,
           count(*) FILTER (WHERE h.verified IS TRUE AND h.verified_at IS NOT NULL AND h.verified_at >= h.created_at) AS dn
      FROM public.house_listings h
     WHERE h.created_at >= v_s AND h.created_at < v_e AND h.agent_id IN (SELECT agent_id FROM rws)
     GROUP BY h.agent_id
  ),
  per AS MATERIALIZED (
    SELECT r.agent_id, r.name, r.phone, r.houses_listed, r.houses_approved, r.houses_pending,
           COALESCE(x.rej_now, 0) AS rej_now, COALESCE(x.occupied, 0) AS occupied, COALESCE(x.empty_n, 0) AS empty_n,
           round(100.0 * r.houses_approved / r.houses_listed, 1) AS approval_rate,
           CASE WHEN COALESCE(x.dn, 0) > 0 THEN round((x.dsum / x.dn)::numeric, 1) END AS avg_days,
           r.listing_earned,
           CASE WHEN r.houses_approved > 0 THEN round(r.listing_earned / r.houses_approved) END AS earn_per_approved,
           COALESCE(x.dsum, 0) AS dsum, COALESCE(x.dn, 0) AS dn
      FROM rws r LEFT JOIN hx x ON x.aid = r.agent_id
  ),
  net AS (
    SELECT count(*) AS agents, COALESCE(sum(houses_listed), 0) AS listed, COALESCE(sum(houses_approved), 0) AS verified,
           COALESCE(sum(houses_pending), 0) AS pending, COALESCE(sum(rej_now), 0) AS rej_now,
           COALESCE(sum(occupied), 0) AS occupied, COALESCE(sum(empty_n), 0) AS empty_n,
           COALESCE(sum(dsum), 0) AS dsum, COALESCE(sum(dn), 0) AS dn, COALESCE(sum(listing_earned), 0) AS earned
      FROM per
  ),
  ev AS (
    SELECT count(*) AS n FROM public.agent_listing_rejections x
     WHERE x.rejected_at >= v_s AND x.rejected_at < v_e AND NOT EXISTS (SELECT 1 FROM gone g WHERE g.id = x.agent_id)
  ),
  wq AS MATERIALIZED (
    SELECT h.id, h.agent_id, h.district, h.created_at
      FROM public.house_listings h
     WHERE h.verified IS NOT TRUE AND COALESCE(h.status, '') <> 'rejected'
       AND NOT EXISTS (SELECT 1 FROM gone g WHERE g.id = h.agent_id)
  ),
  agents_page AS (
    SELECT jsonb_build_object(
             'agent_id', p.agent_id, 'name', p.name, 'phone', p.phone,
             'houses_listed', p.houses_listed, 'houses_verified', p.houses_approved, 'houses_pending', p.houses_pending,
             'houses_currently_rejected', p.rej_now, 'approval_rate', p.approval_rate, 'avg_days_to_verify', p.avg_days,
             'occupied', p.occupied, 'empty', p.empty_n,
             'listing_earned', p.listing_earned, 'earn_per_approved', p.earn_per_approved) AS j,
           row_number() OVER (ORDER BY p.houses_listed DESC, lower(p.name), p.agent_id) AS rn
      FROM per p
  ),
  waiting_page AS (
    SELECT jsonb_build_object(
             'listing_id', w.id, 'agent_id', w.agent_id, 'agent_name', COALESCE(pr.full_name, 'Unnamed agent'), 'phone', pr.phone,
             'district', w.district, 'listed_at', w.created_at,
             'days_waiting', v_today - (w.created_at AT TIME ZONE 'Africa/Kampala')::date) AS j,
           row_number() OVER (ORDER BY w.created_at, w.id) AS rn
      FROM wq w LEFT JOIN public.profiles pr ON pr.id = w.agent_id
  )
  SELECT jsonb_build_object(
    'network', jsonb_build_object(
      'as_at', v_today, 'range_start', p_start, 'range_end', p_end,
      'basis', 'Kampala days. Houses are listings created in the range, one row per agent who listed. Currently rejected = not verified and listing status rejected; verified + pending + currently rejected = listed. Rejection events are the rejections recorded in the range and are a different count. Waiting is the queue today, not range-bound. Listing earnings come from the ledger only: listing_earned is everyone''s (equal to the totals), listing_earned_listers is the part earned by the agents in the rows.',
      'agents', n.agents, 'houses_listed', n.listed, 'houses_verified', n.verified, 'houses_pending', n.pending,
      'houses_currently_rejected', n.rej_now, 'rejection_events', ev.n,
      'occupied', n.occupied, 'empty', n.empty_n,
      'approval_rate', CASE WHEN n.listed > 0 THEN round(100.0 * n.verified / n.listed, 1) END,
      'avg_days_to_verify', CASE WHEN n.dn > 0 THEN round((n.dsum / n.dn)::numeric, 1) END,
      'listing_earned', (SELECT COALESCE(sum(a.listing_earned), 0) FROM rws_all a),
      'listing_earned_listers', n.earned,
      'earn_per_approved', CASE WHEN n.verified > 0 THEN round((SELECT COALESCE(sum(a.listing_earned), 0) FROM rws_all a) / n.verified) END,
      'waiting_total', (SELECT count(*) FROM wq),
      'oldest_waiting_days', (SELECT v_today - (min(wq.created_at) AT TIME ZONE 'Africa/Kampala')::date FROM wq)),
    'agents', COALESCE((SELECT jsonb_agg(a.j ORDER BY a.rn) FROM agents_page a WHERE a.rn > v_offset AND a.rn <= v_offset + v_limit), '[]'::jsonb),
    'waiting', COALESCE((SELECT jsonb_agg(w.j ORDER BY w.rn) FROM waiting_page w WHERE w.rn > v_offset AND w.rn <= v_offset + v_limit), '[]'::jsonb))
    INTO v_out
    FROM net n, ev;
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.agent_ops_metrics_risk(p_start date, p_end date, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_win timestamptz := (v_today - 29)::timestamp AT TIME ZONE 'Africa/Kampala';
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_out jsonb;
BEGIN
  IF NOT public._aom_allowed() THEN RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL THEN RAISE EXCEPTION 'RANGE_REQUIRED: p_start and p_end are required' USING ERRCODE = '22023'; END IF;
  IF p_end < p_start THEN RAISE EXCEPTION 'RANGE_INVALID: p_end is before p_start' USING ERRCODE = '22023'; END IF;

  WITH gone AS MATERIALIZED (
    SELECT p.id FROM public.profiles p WHERE p.deleted_at IS NOT NULL
    UNION
    SELECT d.user_id FROM public.deleted_accounts d
     WHERE d.status = 'soft_deleted' AND d.restored_at IS NULL AND d.purged_at IS NULL AND d.user_id IS NOT NULL
  ),
  rws AS MATERIALIZED (SELECT * FROM public._aom_rows(p_start, p_end, 'all')),
  owing AS MATERIALIZED (
    SELECT r.agent_id, r.name, r.phone, r.houses_listed, r.advance_outstanding, r.listing_earned, r.last_listing,
           CASE WHEN r.listing_earned > 0 THEN round(r.advance_outstanding / r.listing_earned, 2) END AS ratio,
           CASE WHEN r.listing_earned <= 0 THEN 'no_earnings'
                WHEN r.advance_outstanding / r.listing_earned >= 3 THEN 'high'
                WHEN r.advance_outstanding / r.listing_earned >= 1 THEN 'watch'
                ELSE 'ok' END AS flag
      FROM rws r WHERE r.advance_outstanding > 0
  ),
  nol AS (SELECT * FROM owing o WHERE o.houses_listed = 0),
  inact AS MATERIALIZED (
    SELECT h.agent_id, max(h.created_at) AS last_at, count(*) AS houses
      FROM public.house_listings h
     WHERE NOT EXISTS (SELECT 1 FROM gone g WHERE g.id = h.agent_id)
     GROUP BY h.agent_id HAVING max(h.created_at) < v_win
  ),
  nev AS MATERIALIZED (
    SELECT DISTINCT ON (s.sub_agent_id) s.sub_agent_id AS agent_id, s.parent_agent_id, s.verified_at, s.created_at
      FROM public.agent_subagents s
     WHERE s.status = 'verified' AND NOT EXISTS (SELECT 1 FROM gone g WHERE g.id = s.sub_agent_id)
       AND NOT EXISTS (SELECT 1 FROM public.house_listings h WHERE h.agent_id = s.sub_agent_id)
     ORDER BY s.sub_agent_id, s.verified_at NULLS LAST, s.created_at
  ),
  teams AS MATERIALIZED (
    SELECT r.main_agent_id AS pid, count(*) AS size, COALESCE(sum(r.houses_listed), 0) AS houses,
           COALESCE(sum(r.listing_earned), 0) AS earned, COALESCE(sum(r.advance_outstanding), 0) AS owed
      FROM public._aom_rows(p_start, p_end, 'linked') r
     WHERE r.main_agent_id IS NOT NULL GROUP BY r.main_agent_id
  ),
  a1 AS (SELECT jsonb_build_object('agent_id', n.agent_id, 'name', n.name, 'phone', n.phone, 'advance_outstanding', n.advance_outstanding, 'last_listing', n.last_listing) AS j,
                row_number() OVER (ORDER BY n.advance_outstanding DESC, lower(n.name), n.agent_id) AS rn FROM nol n),
  a2 AS (SELECT jsonb_build_object('agent_id', o.agent_id, 'name', o.name, 'phone', o.phone, 'advance_outstanding', o.advance_outstanding, 'listing_earned', o.listing_earned, 'ratio', o.ratio, 'flag', o.flag) AS j,
                row_number() OVER (ORDER BY CASE o.flag WHEN 'no_earnings' THEN 0 WHEN 'high' THEN 1 WHEN 'watch' THEN 2 ELSE 3 END, o.advance_outstanding DESC, lower(o.name), o.agent_id) AS rn FROM owing o),
  a3 AS (SELECT jsonb_build_object('agent_id', i.agent_id, 'name', COALESCE(p.full_name, 'Unnamed agent'), 'phone', p.phone, 'last_listing', (i.last_at AT TIME ZONE 'Africa/Kampala')::date,
                                   'days_inactive', v_today - (i.last_at AT TIME ZONE 'Africa/Kampala')::date, 'houses_listed_ever', i.houses) AS j,
                row_number() OVER (ORDER BY i.last_at DESC, i.agent_id) AS rn
           FROM inact i LEFT JOIN public.profiles p ON p.id = i.agent_id),
  a4 AS (SELECT jsonb_build_object('agent_id', v.agent_id, 'name', COALESCE(p.full_name, 'Unnamed agent'), 'phone', p.phone, 'main_agent_id', v.parent_agent_id,
                                   'main_agent_name', pp.full_name, 'linked_on', (COALESCE(v.verified_at, v.created_at) AT TIME ZONE 'Africa/Kampala')::date) AS j,
                row_number() OVER (ORDER BY COALESCE(v.verified_at, v.created_at), v.agent_id) AS rn
           FROM nev v LEFT JOIN public.profiles p ON p.id = v.agent_id LEFT JOIN public.profiles pp ON pp.id = v.parent_agent_id),
  a5 AS (SELECT jsonb_build_object('main_agent_id', t.pid, 'name', COALESCE(p.full_name, 'Unnamed agent'), 'phone', p.phone, 'team_size', t.size, 'team_houses', t.houses,
                                   'team_earnings', t.earned, 'team_advances_outstanding', t.owed) AS j,
                row_number() OVER (ORDER BY t.owed DESC, t.size DESC, t.pid) AS rn
           FROM teams t LEFT JOIN public.profiles p ON p.id = t.pid WHERE t.owed > 0)
  SELECT jsonb_build_object(
    'summary', jsonb_build_object(
      'as_at', v_today, 'range_start', p_start, 'range_end', p_end, 'inactive_window_start', v_today - 29,
      'basis', 'Kampala days. Advance outstanding is today''s balance of active and overdue advances. Listing earnings are from the ledger only. Inactive listers and never-listed sub-agents are not range-bound: inactive means listed before but nothing in the last 30 days. Ratio = advance outstanding / listing earnings in the dates; flag: no_earnings (none earned), high (3 times or more), watch (1 to 3 times).',
      'advance_no_listing_count', (SELECT count(*) FROM nol), 'advance_no_listing_amount', (SELECT COALESCE(sum(advance_outstanding), 0) FROM nol),
      'owing_agents', (SELECT count(*) FROM owing), 'owing_amount', (SELECT COALESCE(sum(advance_outstanding), 0) FROM owing),
      'flag_no_earnings', (SELECT count(*) FROM owing WHERE flag = 'no_earnings'), 'flag_high', (SELECT count(*) FROM owing WHERE flag = 'high'),
      'flag_watch', (SELECT count(*) FROM owing WHERE flag = 'watch'), 'flag_ok', (SELECT count(*) FROM owing WHERE flag = 'ok'),
      'inactive_listers_count', (SELECT count(*) FROM inact), 'never_listed_subagents_count', (SELECT count(*) FROM nev),
      'main_agents_owing_count', (SELECT count(*) FROM teams WHERE owed > 0), 'main_agents_owing_amount', (SELECT COALESCE(sum(owed), 0) FROM teams)),
    'advance_no_listing', COALESCE((SELECT jsonb_agg(a1.j ORDER BY a1.rn) FROM a1 WHERE a1.rn > v_offset AND a1.rn <= v_offset + v_limit), '[]'::jsonb),
    'advance_vs_earnings', COALESCE((SELECT jsonb_agg(a2.j ORDER BY a2.rn) FROM a2 WHERE a2.rn > v_offset AND a2.rn <= v_offset + v_limit), '[]'::jsonb),
    'inactive_listers', COALESCE((SELECT jsonb_agg(a3.j ORDER BY a3.rn) FROM a3 WHERE a3.rn > v_offset AND a3.rn <= v_offset + v_limit), '[]'::jsonb),
    'never_listed_subagents', COALESCE((SELECT jsonb_agg(a4.j ORDER BY a4.rn) FROM a4 WHERE a4.rn > v_offset AND a4.rn <= v_offset + v_limit), '[]'::jsonb),
    'main_agents_by_advance', COALESCE((SELECT jsonb_agg(a5.j ORDER BY a5.rn) FROM a5 WHERE a5.rn > v_offset AND a5.rn <= v_offset + v_limit), '[]'::jsonb))
    INTO v_out;
  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public.agent_ops_metrics_listing_quality(date, date, integer, integer) IS 'Agent Ops metrics: listing quality per agent, the network row and the longest-waiting pending houses. Read-only.';
COMMENT ON FUNCTION public.agent_ops_metrics_risk(date, date, integer, integer) IS 'Agent Ops metrics: advances without listings, advance vs listing earnings flags, inactive listers, never-listed sub-agents, teams that owe most. Read-only.';

REVOKE ALL ON FUNCTION public.agent_ops_metrics_listing_quality(date, date, integer, integer) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.agent_ops_metrics_risk(date, date, integer, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.agent_ops_metrics_listing_quality(date, date, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_ops_metrics_risk(date, date, integer, integer) TO authenticated;
