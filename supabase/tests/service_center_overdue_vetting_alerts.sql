-- Service Centre overdue vetting alerts (20261008100000_service_center_overdue_vetting_alerts.sql). One DO block that ends in an exception,
-- so NOTHING is kept; the report is the exception message. Run it AFTER the migration is applied.
-- It switches the policy on inside the block (rolled back), picks a real manager with pending Rent Plans, and compares the RPC with an independent count.
DO $$
DECLARE
  out text := ''; mgr uuid; r jsonb; expect_n int; expect_old numeric; ok boolean;
BEGIN
  out := out || format(E'\n(0) ships switched off: enabled=%s  [expect false]', (SELECT enabled FROM service_center_vetting_policy));

  SELECT rr.service_center_manager_id INTO mgr FROM rent_requests rr
   WHERE rr.status = 'service_center_review' AND rr.service_center_manager_id IS NOT NULL
   GROUP BY 1 ORDER BY count(*) DESC LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', mgr::text, true);

  r := get_my_overdue_vetting();
  out := out || format(E'\n(1) policy off -> enabled=%s overdue_count=%s  [expect false / 0]', r->>'enabled', r->>'overdue_count');

  -- policy on, effective long ago: ages are the real ages
  UPDATE service_center_vetting_policy SET enabled = true, effective_from = '2020-01-01' WHERE id;
  r := get_my_overdue_vetting();
  SELECT count(*), COALESCE(round(max(extract(epoch FROM (now() - clock_at)) / 3600.0)::numeric, 1), 0) INTO expect_n, expect_old
    FROM service_center_vetting_items() WHERE manager_id = mgr AND clock_at <= now() - interval '48 hours';
  out := out || format(E'\n(2) real ages -> overdue_count=%s (independent %s) oldest=%s (independent %s)  [expect equal]',
    r->>'overdue_count', expect_n, r->>'oldest_age_hours', expect_old);
  out := out || format(E'\n(2b) by_kind sums to overdue_count: %s',
    ((r->'by_kind'->>'rent_plan')::int + (r->'by_kind'->>'landlord')::int + (r->'by_kind'->>'lc1')::int) = (r->>'overdue_count')::int);

  -- backlog grace: effective_from = now() restarts every old item's clock, so nothing is overdue yet
  UPDATE service_center_vetting_policy SET effective_from = now() WHERE id;
  r := get_my_overdue_vetting();
  out := out || format(E'\n(3) effective_from=now -> overdue_count=%s  [expect 0]', r->>'overdue_count');

  -- audit is throttled and server-counted
  UPDATE service_center_vetting_policy SET effective_from = '2020-01-01' WHERE id;
  out := out || format(E'\n(4) first log=%s second log within 15 min=%s  [expect true / false]',
    log_overdue_vetting_alert_shown(), log_overdue_vetting_alert_shown());

  -- a normal agent cannot read the Ops overview
  ok := false;
  BEGIN PERFORM * FROM get_overdue_vetting_overview(); EXCEPTION WHEN OTHERS THEN ok := true; END;
  out := out || format(E'\n(5) non-ops refused from overview=%s  [expect true unless this manager also holds an ops role]', ok);

  -- grants
  out := out || format(E'\n(6) anon can execute get_my_overdue_vetting=%s helper callable by authenticated=%s  [expect false / false]',
    has_function_privilege('anon', 'public.get_my_overdue_vetting()', 'EXECUTE'),
    has_function_privilege('authenticated', 'public.service_center_vetting_items()', 'EXECUTE'));

  RAISE EXCEPTION E'service_center_overdue_vetting_alerts test report (rolled back):%', out;
END $$;
