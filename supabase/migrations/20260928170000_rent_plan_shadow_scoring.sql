-- Rent Plan scoring in SHADOW MODE (automation plan #6; Benjamin cleared the
-- shadow scoring table 2026-09-28 07:50 EAT).
--
-- What it does: scores each Rent Plan request (rent_requests row) once, from
-- four inputs - the tenant's repayment history, the tenant's current arrears
-- band, the agent's track record, and the rent amount - and logs the score in
-- a NEW table next to the human decision once one is made.
--
-- What it never does: it writes to NOTHING except public.rent_plan_shadow_scores.
-- No UPDATE/INSERT on rent_requests, no status change, no approval, no
-- auto-approve, no money, no messages. People keep making every decision.
--
-- Switch: system_config.rent_plan_shadow_scoring_enabled, seeded false (OFF).
-- Missing row = OFF. While OFF the scheduled run returns immediately.
--   Turn on : update public.system_config set value='true'::jsonb,  updated_at=now() where key='rent_plan_shadow_scoring_enabled';
--   Turn off: update public.system_config set value='false'::jsonb, updated_at=now() where key='rent_plan_shadow_scoring_enabled';
--
-- Model v0 (heuristic, NOT calibrated - cohort default data is not yet
-- available; that is what the shadow period is for). Start 50, clamp 0..100:
--   Repayment history (tenant's earlier plans): >=3 completed +20, 1-2 completed +10,
--       none 0; each earlier rejection -5 (max -10).
--   Arrears band (tenant's OTHER plans, v_rent_plan_arrears.max days_behind):
--       none (0) 0, warning (1-6) -15, critical (7+) -35.
--   Agent track record (current owner's billed plans in v_rent_plan_arrears,
--       share 7+ days behind; needs >=5 billed plans, else 0):
--       <=10% +15, <=30% +5, <=50% -10, >50% -20.
--   Amount (rent_amount UGX): <=100k +10, <=250k +5, <=500k 0, >500k -10.
--   Band: A >=75, B 60-74, C 40-59, D <40.
--   Shadow suggestion only: A/B = "would fast-lane", C = "normal review",
--   D = "would flag". Nothing acts on it.
--
-- Human decision (captured later, from rent_requests, read-only):
--   reject    = rejected_at set or status 'rejected'
--   withdrawn = status 'deleted_by_agent' or 'cancelled'
--   approve   = approved_at set or status in approved/funded/disbursed/repaying/completed
--   otherwise still undecided.
--
-- Rollback:
--   select cron.unschedule('rent-plan-shadow-score-15min');
--   drop view  if exists public.rent_plan_shadow_agreement_weekly;
--   drop function if exists public.rent_plan_shadow_score_run(integer);
--   drop function if exists public.rent_plan_shadow_decision(text, timestamptz, timestamptz);
--   drop table if exists public.rent_plan_shadow_scores;
--   delete from public.system_config where key = 'rent_plan_shadow_scoring_enabled';

INSERT INTO public.system_config (key, value)
VALUES ('rent_plan_shadow_scoring_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.rent_plan_shadow_scores (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id         uuid NOT NULL,
  model_version           text NOT NULL DEFAULT 'v0',
  scored_at               timestamptz NOT NULL DEFAULT now(),
  status_at_score         text,
  -- true when no human decision existed yet at scoring time; only these rows
  -- are a fair test of the rule (later rows can see post-decision arrears).
  pending_at_score        boolean NOT NULL,
  score                   integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  band                    text NOT NULL CHECK (band IN ('A','B','C','D')),
  shadow_suggestion       text NOT NULL CHECK (shadow_suggestion IN ('fast_lane','review','flag')),
  features                jsonb NOT NULL,
  human_decision          text CHECK (human_decision IN ('approve','reject','withdrawn')),
  human_decided_at        timestamptz,
  human_rejected_at_stage text,
  decision_captured_at    timestamptz,
  CONSTRAINT rent_plan_shadow_scores_uniq UNIQUE (rent_request_id, model_version)
);

CREATE INDEX IF NOT EXISTS idx_rent_plan_shadow_scores_scored_at
  ON public.rent_plan_shadow_scores (scored_at);
CREATE INDEX IF NOT EXISTS idx_rent_plan_shadow_scores_undecided
  ON public.rent_plan_shadow_scores (rent_request_id) WHERE human_decision IS NULL;

COMMENT ON TABLE public.rent_plan_shadow_scores IS
  'SHADOW MODE log: one rule score per Rent Plan request beside the eventual human decision. Written only by rent_plan_shadow_score_run(); nothing reads it to make or change a decision.';

ALTER TABLE public.rent_plan_shadow_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rent_plan_shadow_scores_staff_select ON public.rent_plan_shadow_scores;
CREATE POLICY rent_plan_shadow_scores_staff_select
  ON public.rent_plan_shadow_scores
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  );
-- No INSERT/UPDATE/DELETE policy: clients cannot write it. The SECURITY
-- DEFINER run function below is the only writer.
REVOKE INSERT, UPDATE, DELETE ON public.rent_plan_shadow_scores FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.rent_plan_shadow_decision(
  p_status text, p_approved_at timestamptz, p_rejected_at timestamptz
) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_rejected_at IS NOT NULL OR p_status = 'rejected' THEN 'reject'
    WHEN p_status IN ('deleted_by_agent', 'cancelled') THEN 'withdrawn'
    WHEN p_approved_at IS NOT NULL
      OR p_status IN ('approved', 'funded', 'disbursed', 'repaying', 'completed') THEN 'approve'
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.rent_plan_shadow_score_run(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled  boolean;
  v_scored   integer := 0;
  v_decided  integer := 0;
BEGIN
  SELECT COALESCE(
    (SELECT (value #>> '{}')::boolean FROM public.system_config
      WHERE key = 'rent_plan_shadow_scoring_enabled'),
    false) INTO v_enabled;
  IF NOT v_enabled THEN
    RETURN jsonb_build_object('enabled', false, 'scored', 0, 'decisions_captured', 0);
  END IF;

  -- 1. Score requests not yet scored by v0: every undecided request, plus
  --    anything created in the last 14 days (so a quick decision still gets
  --    a row, flagged pending_at_score = false).
  WITH todo AS (
    SELECT rr.id, rr.tenant_id, COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
           rr.rent_amount, rr.status, rr.created_at,
           public.rent_plan_shadow_decision(rr.status, rr.approved_at, rr.rejected_at) AS decision_now
      FROM public.rent_requests rr
     WHERE NOT EXISTS (SELECT 1 FROM public.rent_plan_shadow_scores s
                        WHERE s.rent_request_id = rr.id AND s.model_version = 'v0')
       AND (public.rent_plan_shadow_decision(rr.status, rr.approved_at, rr.rejected_at) IS NULL
            OR rr.created_at >= now() - interval '14 days')
     ORDER BY rr.created_at
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000))
  ),
  arr AS (
    SELECT a.rent_request_id, a.tenant_id, a.agent_id, a.days_behind
      FROM public.v_rent_plan_arrears a
     WHERE a.tenant_id IN (SELECT tenant_id FROM todo)
        OR a.agent_id  IN (SELECT agent_id FROM todo WHERE agent_id IS NOT NULL)
  ),
  f AS (
    SELECT t.*,
      (SELECT count(*) FROM public.rent_requests p
        WHERE p.tenant_id = t.tenant_id AND p.id <> t.id AND p.created_at < t.created_at
          AND p.status = 'completed')                                        AS prior_completed,
      (SELECT count(*) FROM public.rent_requests p
        WHERE p.tenant_id = t.tenant_id AND p.id <> t.id AND p.created_at < t.created_at
          AND (p.status = 'rejected' OR p.rejected_at IS NOT NULL))          AS prior_rejected,
      (SELECT COALESCE(max(a.days_behind), 0) FROM arr a
        WHERE a.tenant_id = t.tenant_id AND a.rent_request_id <> t.id)       AS tenant_max_days_behind,
      (SELECT count(*) FROM arr a WHERE a.agent_id = t.agent_id)             AS agent_billed_plans,
      (SELECT count(*) FROM arr a WHERE a.agent_id = t.agent_id
          AND a.days_behind >= 7)                                            AS agent_critical_plans
    FROM todo t
  ),
  p AS (
    SELECT f.*,
      CASE WHEN f.prior_completed >= 3 THEN 20 WHEN f.prior_completed >= 1 THEN 10 ELSE 0 END
        - LEAST(10, 5 * f.prior_rejected)                                    AS pts_history,
      CASE WHEN f.tenant_max_days_behind >= 7 THEN 'critical'
           WHEN f.tenant_max_days_behind >= 1 THEN 'warning' ELSE 'none' END AS arrears_band,
      CASE WHEN f.tenant_max_days_behind >= 7 THEN -35
           WHEN f.tenant_max_days_behind >= 1 THEN -15 ELSE 0 END            AS pts_arrears,
      CASE WHEN f.agent_id IS NULL OR f.agent_billed_plans < 5 THEN NULL
           ELSE round(f.agent_critical_plans::numeric / f.agent_billed_plans, 3) END AS agent_critical_share,
      CASE WHEN f.agent_id IS NULL OR f.agent_billed_plans < 5 THEN 0
           WHEN f.agent_critical_plans::numeric / f.agent_billed_plans <= 0.10 THEN 15
           WHEN f.agent_critical_plans::numeric / f.agent_billed_plans <= 0.30 THEN 5
           WHEN f.agent_critical_plans::numeric / f.agent_billed_plans <= 0.50 THEN -10
           ELSE -20 END                                                      AS pts_agent,
      CASE WHEN f.rent_amount <= 100000 THEN 10 WHEN f.rent_amount <= 250000 THEN 5
           WHEN f.rent_amount <= 500000 THEN 0 ELSE -10 END                  AS pts_amount
    FROM f
  ),
  s AS (
    SELECT p.*, GREATEST(0, LEAST(100, 50 + pts_history + pts_arrears + pts_agent + pts_amount)) AS score
      FROM p
  ),
  ins AS (
    INSERT INTO public.rent_plan_shadow_scores
      (rent_request_id, model_version, status_at_score, pending_at_score, score, band,
       shadow_suggestion, features)
    SELECT s.id, 'v0', s.status, s.decision_now IS NULL, s.score,
           CASE WHEN s.score >= 75 THEN 'A' WHEN s.score >= 60 THEN 'B'
                WHEN s.score >= 40 THEN 'C' ELSE 'D' END,
           CASE WHEN s.score >= 60 THEN 'fast_lane' WHEN s.score >= 40 THEN 'review' ELSE 'flag' END,
           jsonb_build_object(
             'prior_completed', s.prior_completed, 'prior_rejected', s.prior_rejected,
             'tenant_max_days_behind', s.tenant_max_days_behind, 'arrears_band', s.arrears_band,
             'agent_id', s.agent_id, 'agent_billed_plans', s.agent_billed_plans,
             'agent_critical_plans', s.agent_critical_plans, 'agent_critical_share', s.agent_critical_share,
             'rent_amount', s.rent_amount,
             'points', jsonb_build_object('history', s.pts_history, 'arrears', s.pts_arrears,
                                          'agent', s.pts_agent, 'amount', s.pts_amount))
      FROM s
    ON CONFLICT (rent_request_id, model_version) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_scored FROM ins;

  -- 2. Copy the human decision onto earlier score rows once it exists.
  --    Reads rent_requests; writes only this log table.
  WITH d AS (
    UPDATE public.rent_plan_shadow_scores sc
       SET human_decision = public.rent_plan_shadow_decision(rr.status, rr.approved_at, rr.rejected_at),
           human_decided_at = COALESCE(rr.rejected_at, rr.approved_at, rr.updated_at),
           human_rejected_at_stage = rr.rejected_at_stage,
           decision_captured_at = now()
      FROM public.rent_requests rr
     WHERE sc.rent_request_id = rr.id
       AND sc.human_decision IS NULL
       AND public.rent_plan_shadow_decision(rr.status, rr.approved_at, rr.rejected_at) IS NOT NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_decided FROM d;

  RETURN jsonb_build_object('enabled', true, 'scored', v_scored, 'decisions_captured', v_decided);
END;
$$;

REVOKE ALL ON FUNCTION public.rent_plan_shadow_score_run(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rent_plan_shadow_decision(text, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rent_plan_shadow_decision(text, timestamptz, timestamptz) TO authenticated;

-- Weekly agreement report: score band vs human decision, pending-at-score rows only.
-- security_invoker so the table's staff-only RLS applies to whoever reads it.
CREATE OR REPLACE VIEW public.rent_plan_shadow_agreement_weekly
WITH (security_invoker = true) AS
SELECT
  date_trunc('week', s.scored_at AT TIME ZONE 'Africa/Kampala')::date      AS week_start_eat,
  s.model_version,
  s.band,
  count(*)                                                                  AS scored,
  count(*) FILTER (WHERE s.human_decision = 'approve')                      AS human_approved,
  count(*) FILTER (WHERE s.human_decision = 'reject')                       AS human_rejected,
  count(*) FILTER (WHERE s.human_decision = 'withdrawn')                    AS withdrawn,
  count(*) FILTER (WHERE s.human_decision IS NULL)                          AS undecided,
  round(100.0 * count(*) FILTER (WHERE s.human_decision = 'approve')
        / NULLIF(count(*) FILTER (WHERE s.human_decision IN ('approve','reject')), 0), 1)
                                                                            AS human_approve_pct,
  -- Agreement: A/B (fast_lane) vs human approve, D (flag) vs human reject.
  -- C (review) has no call to agree with, so it is left null.
  CASE WHEN s.band IN ('A','B') THEN
         round(100.0 * count(*) FILTER (WHERE s.human_decision = 'approve')
               / NULLIF(count(*) FILTER (WHERE s.human_decision IN ('approve','reject')), 0), 1)
       WHEN s.band = 'D' THEN
         round(100.0 * count(*) FILTER (WHERE s.human_decision = 'reject')
               / NULLIF(count(*) FILTER (WHERE s.human_decision IN ('approve','reject')), 0), 1)
  END                                                                       AS agreement_pct
FROM public.rent_plan_shadow_scores s
WHERE s.pending_at_score
GROUP BY 1, 2, 3;

REVOKE ALL ON public.rent_plan_shadow_agreement_weekly FROM anon;
GRANT SELECT ON public.rent_plan_shadow_agreement_weekly TO authenticated;

-- Every 15 minutes; a no-op while the flag is OFF. Pure SQL, no HTTP, no key.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rent-plan-shadow-score-15min') THEN
    PERFORM cron.unschedule('rent-plan-shadow-score-15min');
  END IF;
END
$$;
SELECT cron.schedule(
  'rent-plan-shadow-score-15min',
  '*/15 * * * *',
  $$ select public.rent_plan_shadow_score_run(200); $$
);
