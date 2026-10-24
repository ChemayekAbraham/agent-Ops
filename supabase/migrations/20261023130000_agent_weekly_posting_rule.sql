-- Weekly posting rule for agents (replaces the 50% daily rule once switched on).
--
-- THE RULE (decided with Pius, 2026-10-23)
--   Week: Thursday 00:00 to Wednesday 23:59, Africa/Kampala. An agent is judged on the most
--   recent COMPLETED week, so the result is fixed from Thursday until the next Wednesday.
--   Every Rent Plan billed to the agent that week is put in one group for the whole week,
--   by its state on the week's first day:
--     in-window : its repayment window had not ended on Thursday
--     expired   : its window ended before Thursday (still billed, still repaying)
--   For each plan: due = what agent_expected_day_plans billed it that week;
--                  collected = the agent's non-reversed collections on it that week,
--                  CAPPED at that plan's due (one tenant overpaying cannot hide another who paid nothing).
--   Pass when:
--     nothing billed                 -> pass (nothing to measure)
--     only in-window plans billed    -> in-window collected >= 50% of in-window due
--     both groups billed             -> in-window >= 50% AND expired >= 20% of expired due
--     only expired plans billed      -> expired >= 70% of expired due
--   No staff exemptions and no weekly "good days" unlock under this rule.
--
-- ROLLOUT
--   Ships in SHADOW mode: results are computed and saved every week, the app can read them,
--   but rent_requests keeps enforcing the old daily rule until
--     UPDATE public.agent_posting_rule_settings SET enforce_weekly = true;
--   Flipping that one flag moves both the database gate and the app to the weekly rule.
--
-- Window end matches v_agent_daily_eligibility.stale_debt:
--   COALESCE(repayment_starts_on, funded_at::date in Kampala) + duration_days - 1.

-- ---------------------------------------------------------------------------------------
-- 1. Settings (one row)
-- ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_posting_rule_settings (
  id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
  week_start_isodow       smallint NOT NULL DEFAULT 4 CHECK (week_start_isodow BETWEEN 1 AND 7), -- 4 = Thursday
  in_window_required_pct  numeric  NOT NULL DEFAULT 0.50 CHECK (in_window_required_pct BETWEEN 0 AND 1),
  expired_required_pct    numeric  NOT NULL DEFAULT 0.20 CHECK (expired_required_pct BETWEEN 0 AND 1),
  all_expired_required_pct numeric NOT NULL DEFAULT 0.70 CHECK (all_expired_required_pct BETWEEN 0 AND 1),
  enforce_weekly          boolean  NOT NULL DEFAULT false,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.agent_posting_rule_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.agent_posting_rule_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_posting_rule_settings_read ON public.agent_posting_rule_settings;
CREATE POLICY agent_posting_rule_settings_read ON public.agent_posting_rule_settings
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.agent_posting_rule_settings FROM anon, authenticated;
GRANT SELECT ON public.agent_posting_rule_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_posting_rule_settings TO service_role;

-- ---------------------------------------------------------------------------------------
-- 2. Weekly results (one row per agent per week; written by the snapshot job)
-- ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_weekly_posting_eligibility (
  agent_id              uuid    NOT NULL,
  week_start            date    NOT NULL,
  week_end              date    NOT NULL,
  in_window_due         numeric NOT NULL DEFAULT 0,
  in_window_collected   numeric NOT NULL DEFAULT 0,
  in_window_plans       integer NOT NULL DEFAULT 0,
  expired_due           numeric NOT NULL DEFAULT 0,
  expired_collected     numeric NOT NULL DEFAULT 0,
  expired_plans         integer NOT NULL DEFAULT 0,
  book                  text    NOT NULL CHECK (book IN ('none','in_window_only','mixed','all_expired')),
  in_window_pct         numeric,
  expired_pct           numeric,
  in_window_required_pct numeric,
  expired_required_pct  numeric,
  passes                boolean NOT NULL,
  reason                text,
  computed_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, week_start)
);
CREATE INDEX IF NOT EXISTS agent_weekly_posting_eligibility_week_idx
  ON public.agent_weekly_posting_eligibility (week_start);

ALTER TABLE public.agent_weekly_posting_eligibility ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_weekly_posting_eligibility_read ON public.agent_weekly_posting_eligibility;
CREATE POLICY agent_weekly_posting_eligibility_read ON public.agent_weekly_posting_eligibility
  FOR SELECT TO authenticated
  USING (agent_id = auth.uid() OR public.can_view_staff_reports(auth.uid()));
REVOKE ALL ON public.agent_weekly_posting_eligibility FROM anon, authenticated;
GRANT SELECT ON public.agent_weekly_posting_eligibility TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_weekly_posting_eligibility TO service_role;

-- ---------------------------------------------------------------------------------------
-- 3. Week arithmetic
-- ---------------------------------------------------------------------------------------
-- First day of the rule week that contains p_day.
CREATE OR REPLACE FUNCTION public._agent_rule_week_start(p_day date)
RETURNS date
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT p_day - ((extract(isodow FROM p_day)::int - s.week_start_isodow + 7) % 7)
  FROM public.agent_posting_rule_settings s
  WHERE s.id;
$function$;

-- First day of the week an agent is judged on today: the last COMPLETED week.
CREATE OR REPLACE FUNCTION public._agent_rule_judged_week_start()
RETURNS date
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT public._agent_rule_week_start((now() AT TIME ZONE 'Africa/Kampala')::date) - 7;
$function$;

-- ---------------------------------------------------------------------------------------
-- 4. The calculation (pure read; p_agent_ids NULL = every agent billed that week)
-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._agent_weekly_posting_compute(p_week_start date, p_agent_ids uuid[] DEFAULT NULL)
RETURNS SETOF public.agent_weekly_posting_eligibility
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH s AS (
    SELECT * FROM public.agent_posting_rule_settings WHERE id
  ), w AS (
    SELECT p_week_start AS lo, p_week_start + 6 AS hi
  ), bill AS (
    -- One row per (agent, plan): what the plan was billed this week, and which group it is in.
    SELECT e.agent_id,
           e.rent_request_id,
           (array_agg(e.tenant_id) FILTER (WHERE e.tenant_id IS NOT NULL))[1] AS tenant_id,
           sum(e.expected_ugx) AS due,
           bool_or(
             COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date)
               + COALESCE(rr.duration_days, 0) - 1 < w.lo
           ) AS expired
    FROM public.agent_expected_day_plans e
    JOIN public.rent_requests rr ON rr.id = e.rent_request_id
    CROSS JOIN w
    WHERE e.day BETWEEN w.lo AND w.hi
      AND e.agent_id IS NOT NULL
      AND e.expected_ugx > 0
      AND (p_agent_ids IS NULL OR e.agent_id = ANY (p_agent_ids))
    GROUP BY e.agent_id, e.rent_request_id
  ), per_plan AS (
    SELECT b.agent_id, b.expired, b.due,
           LEAST(COALESCE(c.paid, 0), b.due) AS collected
    FROM bill b
    CROSS JOIN w
    LEFT JOIN LATERAL (
      -- Same matching as snapshot_agent_daily_eligibility: by plan, or by tenant when the
      -- collection carries no plan id.
      SELECT sum(ac.amount) AS paid
      FROM public.agent_collections ac
      WHERE ac.reversed_at IS NULL
        AND ac.amount > 0
        AND ac.agent_id = b.agent_id
        AND (ac.rent_request_id = b.rent_request_id
             OR (ac.rent_request_id IS NULL AND ac.tenant_id IS NOT NULL AND ac.tenant_id = b.tenant_id))
        AND ac.created_at >= (w.lo::timestamp AT TIME ZONE 'Africa/Kampala')
        AND ac.created_at <  ((w.hi + 1)::timestamp AT TIME ZONE 'Africa/Kampala')
    ) c ON true
  ), agg AS (
    SELECT p.agent_id,
           COALESCE(sum(p.due)       FILTER (WHERE NOT p.expired), 0) AS in_due,
           COALESCE(sum(p.collected) FILTER (WHERE NOT p.expired), 0) AS in_got,
           count(*) FILTER (WHERE NOT p.expired)::int                 AS in_plans,
           COALESCE(sum(p.due)       FILTER (WHERE p.expired), 0)     AS ex_due,
           COALESCE(sum(p.collected) FILTER (WHERE p.expired), 0)     AS ex_got,
           count(*) FILTER (WHERE p.expired)::int                     AS ex_plans
    FROM per_plan p
    GROUP BY p.agent_id
  ), judged AS (
    SELECT a.*,
           CASE WHEN a.in_due > 0 AND a.ex_due > 0 THEN 'mixed'
                WHEN a.in_due > 0 THEN 'in_window_only'
                WHEN a.ex_due > 0 THEN 'all_expired'
                ELSE 'none' END AS book,
           CASE WHEN a.in_due > 0 THEN round(a.in_got / a.in_due, 4) END AS in_pct,
           CASE WHEN a.ex_due > 0 THEN round(a.ex_got / a.ex_due, 4) END AS ex_pct
    FROM agg a
  ), ruled AS (
    SELECT j.*,
           CASE WHEN j.in_due > 0 THEN s.in_window_required_pct END AS in_req,
           CASE j.book WHEN 'mixed' THEN s.expired_required_pct
                       WHEN 'all_expired' THEN s.all_expired_required_pct END AS ex_req
    FROM judged j CROSS JOIN s
  )
  SELECT r.agent_id, w.lo, w.hi,
         r.in_due, r.in_got, r.in_plans,
         r.ex_due, r.ex_got, r.ex_plans,
         r.book, r.in_pct, r.ex_pct, r.in_req, r.ex_req,
         -- Compared on amounts, not on rounded percentages.
         (r.in_req IS NULL OR r.in_got >= r.in_req * r.in_due)
           AND (r.ex_req IS NULL OR r.ex_got >= r.ex_req * r.ex_due) AS passes,
         NULLIF(concat_ws(' ',
           CASE WHEN r.in_req IS NOT NULL AND r.in_got < r.in_req * r.in_due THEN
             format('Last week (%s to %s) you collected %s%% of what your current Rent Plans were due (UGX %s of UGX %s). You need %s%%.',
                    to_char(w.lo, 'FMDD Mon'), to_char(w.hi, 'FMDD Mon'),
                    to_char(floor(r.in_pct * 1000) / 10, 'FM990.0'),
                    to_char(r.in_got, 'FM999,999,999,990'), to_char(r.in_due, 'FM999,999,999,990'),
                    to_char(r.in_req * 100, 'FM990'))
           END,
           CASE WHEN r.ex_req IS NOT NULL AND r.ex_got < r.ex_req * r.ex_due THEN
             -- When the current-plans sentence is already there, don't repeat "Last week (...)".
             format('%s %s%% of what %s were due (UGX %s of UGX %s). You need %s%%.',
                    CASE WHEN r.in_req IS NOT NULL AND r.in_got < r.in_req * r.in_due
                         THEN 'On your expired Rent Plans you collected'
                         ELSE format('Last week (%s to %s) you collected', to_char(w.lo, 'FMDD Mon'), to_char(w.hi, 'FMDD Mon'))
                    END,
                    to_char(floor(r.ex_pct * 1000) / 10, 'FM990.0'),
                    CASE WHEN r.in_req IS NOT NULL AND r.in_got < r.in_req * r.in_due
                         THEN 'they' ELSE 'your expired Rent Plans' END,
                    to_char(r.ex_got, 'FM999,999,999,990'), to_char(r.ex_due, 'FM999,999,999,990'),
                    to_char(r.ex_req * 100, 'FM990'))
           END
         ), '') AS reason,
         now()
  FROM ruled r CROSS JOIN w;
$function$;

-- ---------------------------------------------------------------------------------------
-- 5. Snapshot job: saves the judged week's results (re-runnable; upserts)
-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.snapshot_agent_weekly_posting_eligibility(p_week_start date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_week date := COALESCE(p_week_start, public._agent_rule_judged_week_start());
  v_rows int := 0;
BEGIN
  -- Re-runs replace the week: an agent who no longer has a billed plan that week loses its row.
  DELETE FROM public.agent_weekly_posting_eligibility WHERE week_start = v_week;

  INSERT INTO public.agent_weekly_posting_eligibility
  SELECT * FROM public._agent_weekly_posting_compute(v_week, NULL);

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END
$function$;

-- ---------------------------------------------------------------------------------------
-- 6. One agent's result for the judged week: saved snapshot, else live
-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._agent_weekly_posting_result(p_agent_id uuid)
RETURNS public.agent_weekly_posting_eligibility
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_week date := public._agent_rule_judged_week_start();
  v_row  public.agent_weekly_posting_eligibility;
BEGIN
  SELECT * INTO v_row FROM public.agent_weekly_posting_eligibility
  WHERE agent_id = p_agent_id AND week_start = v_week;
  IF FOUND THEN RETURN v_row; END IF;

  -- The job ran and this agent had nothing billed: nothing to measure.
  IF EXISTS (SELECT 1 FROM public.agent_weekly_posting_eligibility WHERE week_start = v_week) THEN
    RETURN NULL;
  END IF;

  -- The job has not run for this week (failed, or just deployed): work it out live.
  SELECT * INTO v_row FROM public._agent_weekly_posting_compute(v_week, ARRAY[p_agent_id]);
  IF FOUND THEN RETURN v_row; END IF;
  RETURN NULL;
END
$function$;

-- ---------------------------------------------------------------------------------------
-- 7. App read: one row per requested agent, plus whether the rule is enforced
-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_agent_weekly_posting_eligibility(p_agent_ids uuid[])
RETURNS TABLE(
  agent_id uuid, week_start date, week_end date,
  in_window_due numeric, in_window_collected numeric, in_window_plans integer,
  expired_due numeric, expired_collected numeric, expired_plans integer,
  book text, in_window_pct numeric, expired_pct numeric,
  in_window_required_pct numeric, expired_required_pct numeric,
  passes boolean, reason text, computed_at timestamptz,
  enforced boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_week date := public._agent_rule_judged_week_start();
  v_enforced boolean;
  v_id uuid;
  v_row public.agent_weekly_posting_eligibility;
BEGIN
  -- Same access rule as get_agent_daily_eligibility: yourself, your network, or staff reports.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING errcode = '42501';
  END IF;
  IF NOT (public.can_view_staff_reports(auth.uid())
          OR NOT EXISTS (SELECT 1 FROM unnest(p_agent_ids) a(id)
                         WHERE a.id IS DISTINCT FROM auth.uid()
                           AND a.id NOT IN (SELECT public.agent_wallet_network_ids(auth.uid())))) THEN
    RAISE EXCEPTION 'not authorized' USING errcode = '42501';
  END IF;

  SELECT s.enforce_weekly INTO v_enforced FROM public.agent_posting_rule_settings s WHERE s.id;

  FOR v_id IN SELECT DISTINCT a.id FROM unnest(p_agent_ids) a(id) WHERE a.id IS NOT NULL LOOP
    v_row := public._agent_weekly_posting_result(v_id);
    IF v_row.agent_id IS NULL THEN
      -- Nothing billed last week: passes.
      agent_id := v_id; week_start := v_week; week_end := v_week + 6;
      in_window_due := 0; in_window_collected := 0; in_window_plans := 0;
      expired_due := 0; expired_collected := 0; expired_plans := 0;
      book := 'none'; in_window_pct := NULL; expired_pct := NULL;
      in_window_required_pct := NULL; expired_required_pct := NULL;
      passes := true; reason := NULL; computed_at := now();
    ELSE
      agent_id := v_row.agent_id; week_start := v_row.week_start; week_end := v_row.week_end;
      in_window_due := v_row.in_window_due; in_window_collected := v_row.in_window_collected;
      in_window_plans := v_row.in_window_plans;
      expired_due := v_row.expired_due; expired_collected := v_row.expired_collected;
      expired_plans := v_row.expired_plans;
      book := v_row.book; in_window_pct := v_row.in_window_pct; expired_pct := v_row.expired_pct;
      in_window_required_pct := v_row.in_window_required_pct;
      expired_required_pct := v_row.expired_required_pct;
      passes := v_row.passes; reason := v_row.reason; computed_at := v_row.computed_at;
    END IF;
    enforced := COALESCE(v_enforced, false);
    RETURN NEXT;
  END LOOP;
END
$function$;

-- ---------------------------------------------------------------------------------------
-- 8. The gate on rent_requests: weekly when enforced, otherwise the old daily rule unchanged
-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_agent_daily_eligibility()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_active_count int;
  v_tenants_due  int;
  v_cov_today    numeric;
  v_cov_yest     numeric;
  v_best_cov     numeric;
  v_today        date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_bypass       text;
  v_weekly       boolean;
  v_week_row     public.agent_weekly_posting_eligibility;
BEGIN
  v_bypass := current_setting('app.bypass_daily_eligibility', true);
  IF v_bypass = 'true' THEN RETURN NEW; END IF;
  IF NEW.agent_id IS NULL THEN RETURN NEW; END IF;

  SELECT s.enforce_weekly INTO v_weekly FROM public.agent_posting_rule_settings s WHERE s.id;

  IF COALESCE(v_weekly, false) THEN
    -- Weekly rule (20261023130000). No exemptions, no unlock.
    v_week_row := public._agent_weekly_posting_result(NEW.agent_id);
    IF v_week_row.agent_id IS NOT NULL AND NOT v_week_row.passes THEN
      RAISE EXCEPTION 'WEEKLY_ELIGIBILITY_BLOCKED: %', v_week_row.reason
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- ---- Old daily rule (unchanged; dead once enforce_weekly is true) ----
  SELECT active_count, tenants_due, coverage_today, coverage_yesterday
    INTO v_active_count, v_tenants_due, v_cov_today, v_cov_yest
  FROM public.v_agent_daily_eligibility
  WHERE agent_id = NEW.agent_id;

  -- No measurable book at all.
  IF v_active_count IS NULL OR v_active_count = 0 THEN
    RETURN NEW;
  END IF;

  -- Guard 1: nothing was billed to this agent today or yesterday, so there is
  -- no denominator. Never let an absent measurement read as a failed one.
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_expected_day_plans e
    WHERE e.agent_id = NEW.agent_id
      AND e.day >= v_today - 1
  ) THEN
    RETURN NEW;
  END IF;

  -- Guard 1b: an explicit, recorded one-day grant by staff.
  IF EXISTS (
    SELECT 1 FROM public.agent_posting_gate_exemptions x
    WHERE x.agent_id = NEW.agent_id
      AND x.day = v_today
  ) THEN
    RETURN NEW;
  END IF;

  -- Guard 2: the weekly good-standing unlock the app already promises.
  IF EXISTS (
    SELECT 1
    FROM public.agent_daily_eligibility_history h
    WHERE h.agent_id = NEW.agent_id
      AND h.day >= v_today - 7
      AND h.rating IN ('Good', 'Very Good')
    GROUP BY h.agent_id
    HAVING count(DISTINCT h.day) >= 2
  ) THEN
    RETURN NEW;
  END IF;

  v_best_cov := GREATEST(COALESCE(v_cov_today, 0), COALESCE(v_cov_yest, 0));

  IF v_best_cov < 0.50 THEN
    RAISE EXCEPTION
      'DAILY_ELIGIBILITY_BLOCKED: agent reached % of the tenants who owed (target 50 percent). Collect from more of your existing tenants before posting new Rent Plans.',
      to_char(v_best_cov * 100, 'FM990.0') || '%'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$function$;

-- ---------------------------------------------------------------------------------------
-- 9. Grants: helpers closed, the app read open to signed-in users (it checks the caller)
-- ---------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._agent_rule_week_start(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._agent_rule_judged_week_start() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._agent_weekly_posting_compute(date, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._agent_weekly_posting_result(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.snapshot_agent_weekly_posting_eligibility(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_agent_weekly_posting_eligibility(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_agent_weekly_posting_eligibility(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public._agent_rule_week_start(date) TO service_role;
GRANT EXECUTE ON FUNCTION public._agent_rule_judged_week_start() TO service_role;
GRANT EXECUTE ON FUNCTION public._agent_weekly_posting_compute(date, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public._agent_weekly_posting_result(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.snapshot_agent_weekly_posting_eligibility(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_agent_weekly_posting_eligibility(uuid[]) TO service_role;

-- ---------------------------------------------------------------------------------------
-- 10. Schedule (UTC): Thursday 00:15 Kampala, and again 06:00 Kampala to pick up
--     collections that synced late overnight, before the working day starts.
-- ---------------------------------------------------------------------------------------
DO $cron$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job
   WHERE jobname IN ('snapshot-agent-weekly-posting-eligibility', 'snapshot-agent-weekly-posting-eligibility-am');
  PERFORM cron.schedule('snapshot-agent-weekly-posting-eligibility', '15 21 * * 3',
                        'SELECT public.snapshot_agent_weekly_posting_eligibility();');
  PERFORM cron.schedule('snapshot-agent-weekly-posting-eligibility-am', '0 3 * * 4',
                        'SELECT public.snapshot_agent_weekly_posting_eligibility();');
END
$cron$;

-- First result straight away for the week agents are judged on now.
SELECT public.snapshot_agent_weekly_posting_eligibility();
