-- =============================================================================
-- Migration: 20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql
-- Purpose:   Zoe (My Space AI Assistant) — Prompt 4: Zoe as an Advisor That
--            Suggests Improvements (And Never Acts):
--              1. Read-only advisor tools (`assistant_staff_insight_*`), all
--                 STABLE, SECURITY DEFINER, search_path = public, and role-checked,
--                 built only from existing official figures:
--                   - assistant_staff_insight_desk_wait_times(p_weeks)
--                   - assistant_staff_insight_collection_coverage_trends(p_weeks)
--                   - assistant_staff_insight_calling_reach_and_themes(p_days)
--                   - assistant_staff_insight_payout_delays(p_days)
--                   - assistant_staff_insight_zoe_unanswered_and_feedback(p_days)
--                   - assistant_staff_insight_anomalies(p_category, p_limit)
--              2. Anomaly notes table (`public.staff_assistant_insights`) with
--                 explicit SELECT-only grant for `authenticated`, `mfa_required_for_staff`
--                 RESTRICTIVE policy, and daily read-only computation job
--                 `public.staff_assistant_compute_daily_insights(p_as_of)` comparing
--                 today's key figures with the last 4 weeks.
--              3. Ideas list table (`public.staff_assistant_ideas`) with explicit
--                 SELECT-only grant for `authenticated`, `mfa_required_for_staff`
--                 RESTRICTIVE policy, server-stored `'idea'` draft binding in
--                 `public.staff_assistant_drafts`, click-confirmed save RPC
--                 `public.staff_assistant_save_idea(...)`, list RPC
--                 `public.staff_assistant_list_ideas(...)`, and manager-only status
--                 update RPC `public.staff_assistant_update_idea_status(...)`.
--              4. Monday "What to look at this week" summary RPC
--                 `public.staff_assistant_weekly_focus_summary()` for managers,
--                 the COO, and the CEO in My Space: top 5 issues with evidence,
--                 figures, sources, and links to the screens (never sent outside
--                 the app).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Ensure `staff_assistant_crm_can_review()` alias exists as STABLE
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_crm_can_review()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT public.staff_assistant_is_crm_reviewer();
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_crm_can_review() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_crm_can_review() TO authenticated;

-- Helper: can the signed-in caller view/manage saved Ideas for Welile & Weekly Focus?
-- Visible to managers, the COO, and the CEO (plus super_admin).
CREATE OR REPLACE FUNCTION public.staff_assistant_can_manage_ideas()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT (SELECT auth.uid()) IS NOT NULL
     AND public.staff_assistant_has_access()
     AND public._has_enabled_role(
       (SELECT auth.uid()),
       ARRAY['manager', 'coo', 'ceo', 'super_admin']
     );
$function$;

COMMENT ON FUNCTION public.staff_assistant_can_manage_ideas() IS
  'Returns true when the signed-in caller is an active staff member holding manager, coo, ceo, or super_admin role — authorized to view all saved Ideas for Welile, change idea statuses, and read the Monday Weekly Focus summary.';

REVOKE ALL ON FUNCTION public.staff_assistant_can_manage_ideas() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_can_manage_ideas() TO authenticated;

-- -----------------------------------------------------------------------------
-- 1. Anomaly Notes Table: `public.staff_assistant_insights` (Prompt 4 item 2)
--    Stores notable changes comparing today's key figures with the last 4 weeks,
--    with numbers and official sources. `authenticated` gets SELECT only.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_insights (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kampala_date          date NOT NULL DEFAULT ((now() AT TIME ZONE 'Africa/Kampala')::date),
  metric_key            text NOT NULL,
  category              text NOT NULL
                        CONSTRAINT staff_assistant_insights_category_chk
                        CHECK (category IN ('collections', 'desk_waiting', 'calling_reach', 'payout_delays', 'zoe_learning', 'finance')),
  area_or_scope         text NOT NULL,
  headline              text NOT NULL,
  summary               text NOT NULL,
  current_value         numeric NOT NULL DEFAULT 0,
  four_week_avg         numeric NOT NULL DEFAULT 0,
  pct_change            numeric NOT NULL DEFAULT 0,
  direction             text NOT NULL DEFAULT 'flat'
                        CONSTRAINT staff_assistant_insights_dir_chk
                        CHECK (direction IN ('up', 'down', 'flat')),
  severity              text NOT NULL DEFAULT 'notable'
                        CONSTRAINT staff_assistant_insights_sev_chk
                        CHECK (severity IN ('info', 'notable', 'high')),
  evidence              jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_function       text NOT NULL,
  screen_link           text NOT NULL DEFAULT '/me',
  requires_finance_gate boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_assistant_insights_day_metric_scope_uniq
    UNIQUE (kampala_date, metric_key, area_or_scope)
);

COMMENT ON TABLE public.staff_assistant_insights IS
  'Daily anomaly notes comparing today''s key figures with the prior 4-week average, with numbers and official sources. Read-only for staff (SELECT only for authenticated).';

CREATE INDEX IF NOT EXISTS idx_staff_assistant_insights_date_cat
  ON public.staff_assistant_insights (kampala_date DESC, category, severity);

ALTER TABLE public.staff_assistant_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_insights;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_insights
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS "Staff read authorized staff_assistant_insights" ON public.staff_assistant_insights;
CREATE POLICY "Staff read authorized staff_assistant_insights"
  ON public.staff_assistant_insights
  FOR SELECT TO authenticated
  USING (
    (SELECT public.staff_assistant_has_access())
    AND (
      CASE
        WHEN requires_finance_gate THEN (SELECT public.can_view_finance_reports((SELECT auth.uid())))
        ELSE (SELECT public.can_view_staff_reports((SELECT auth.uid())))
      END
    )
  );

REVOKE ALL ON TABLE public.staff_assistant_insights FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.staff_assistant_insights TO authenticated;
GRANT ALL    ON TABLE public.staff_assistant_insights TO service_role;

-- -----------------------------------------------------------------------------
-- 2. Saved Ideas Table: `public.staff_assistant_ideas` (Prompt 4 item 3 & 5)
--    Stores click-confirmed improvement suggestions with evidence, figures,
--    source, author, date, and manager-controlled status.
--    `authenticated` gets SELECT only; all writes go through checked RPCs.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_ideas (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  author_name            text NOT NULL,
  author_email           text NOT NULL,
  author_roles           text[] NOT NULL DEFAULT ARRAY[]::text[],
  conversation_id        uuid REFERENCES public.staff_assistant_conversations(id) ON DELETE SET NULL,
  draft_id               uuid REFERENCES public.staff_assistant_drafts(id) ON DELETE SET NULL,
  title                  text NOT NULL,
  idea                   text NOT NULL,
  category               text NOT NULL DEFAULT 'operations'
                         CONSTRAINT staff_assistant_ideas_cat_chk
                         CHECK (category IN ('operations', 'collections', 'desk_waiting', 'calling_reach', 'payout_delays', 'zoe_learning', 'finance')),
  evidence_summary       text NOT NULL,
  evidence_figures       jsonb NOT NULL DEFAULT '{}'::jsonb,
  source                 text NOT NULL,
  period_label           text NOT NULL DEFAULT 'Current period',
  screen_link            text NOT NULL DEFAULT '/me/ideas',
  status                 text NOT NULL DEFAULT 'new'
                         CONSTRAINT staff_assistant_ideas_status_chk
                         CHECK (status IN ('new', 'being_looked_at', 'done', 'not_now')),
  status_note            text,
  status_updated_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status_updated_by_name text,
  status_updated_at      timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.staff_assistant_ideas IS
  'Saved "Ideas for Welile" suggestions with evidence, figures, official source, author, and date. Visible to managers, the COO, the CEO, and the author. Status is changed only by managers via ordinary screen action.';

CREATE INDEX IF NOT EXISTS idx_staff_assistant_ideas_status_created
  ON public.staff_assistant_ideas (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_assistant_ideas_author_created
  ON public.staff_assistant_ideas (created_by, created_at DESC);

ALTER TABLE public.staff_assistant_ideas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_ideas;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_ideas
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS "Staff and leadership read staff_assistant_ideas" ON public.staff_assistant_ideas;
CREATE POLICY "Staff and leadership read staff_assistant_ideas"
  ON public.staff_assistant_ideas
  FOR SELECT TO authenticated
  USING (
    (SELECT public.staff_assistant_has_access())
    AND (
      created_by = (SELECT auth.uid())
      OR (SELECT public.staff_assistant_can_manage_ideas())
    )
  );

REVOKE ALL ON TABLE public.staff_assistant_ideas FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.staff_assistant_ideas TO authenticated;
GRANT ALL    ON TABLE public.staff_assistant_ideas TO service_role;

-- -----------------------------------------------------------------------------
-- 3. Extend `staff_assistant_drafts` and `staff_assistant_is_valid_link_path`
--    to support `'idea'` drafts and `/me/ideas`
-- -----------------------------------------------------------------------------
ALTER TABLE public.staff_assistant_drafts
  DROP CONSTRAINT IF EXISTS staff_assistant_drafts_kind_chk;

ALTER TABLE public.staff_assistant_drafts
  ADD CONSTRAINT staff_assistant_drafts_kind_chk
  CHECK (kind IN ('email', 'reminder', 'notification', 'schedule', 'idea'));

CREATE OR REPLACE FUNCTION public.staff_assistant_compute_draft_hash(
  p_kind text,
  p_payload jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_kind text := lower(btrim(COALESCE(p_payload ->> 'kind', p_kind, '')));
  v_canonical jsonb;
  v_emails jsonb;
BEGIN
  IF v_kind = 'reminder' THEN
    v_canonical := jsonb_build_object(
      'kind', 'reminder',
      'title', btrim(COALESCE(p_payload ->> 'title', '')),
      'remind_at', (COALESCE(NULLIF(btrim(p_payload ->> 'remind_at'), '')::timestamptz, to_timestamp(0)) AT TIME ZONE 'UTC'),
      'note', COALESCE(NULLIF(btrim(COALESCE(p_payload ->> 'note', '')), ''), '')
    );
  ELSIF v_kind = 'notification' THEN
    v_canonical := jsonb_build_object(
      'kind', 'notification',
      'recipient_email', lower(btrim(COALESCE(p_payload ->> 'recipient_email', ''))),
      'title', btrim(COALESCE(p_payload ->> 'title', '')),
      'message', btrim(COALESCE(p_payload ->> 'message', '')),
      'link_path', COALESCE(NULLIF(btrim(COALESCE(p_payload ->> 'link_path', '')), ''), '/me')
    );
  ELSIF v_kind = 'schedule' THEN
    SELECT COALESCE(jsonb_agg( lower(btrim(val)) ORDER BY lower(btrim(val)) ), '[]'::jsonb)
      INTO v_emails
      FROM jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(p_payload -> 'recipient_emails') = 'array'
            THEN p_payload -> 'recipient_emails'
          WHEN COALESCE(p_payload ->> 'recipient_email', '') <> ''
            THEN jsonb_build_array(p_payload ->> 'recipient_email')
          ELSE '[]'::jsonb
        END
      ) AS t(val)
     WHERE btrim(val) <> '';

    v_canonical := jsonb_build_object(
      'kind', 'schedule',
      'title', btrim(COALESCE(p_payload ->> 'title', '')),
      'report_tool', lower(btrim(COALESCE(p_payload ->> 'report_tool', ''))),
      'report_rpc', lower(btrim(COALESCE(p_payload ->> 'report_rpc', ''))),
      'report_args', COALESCE(p_payload -> 'report_args', '{}'::jsonb),
      'frequency', lower(btrim(COALESCE(p_payload ->> 'frequency', 'daily'))),
      'day_of_week', CASE
        WHEN lower(btrim(COALESCE(p_payload ->> 'frequency', 'daily'))) = 'weekly'
          THEN COALESCE((p_payload ->> 'day_of_week')::integer, 1)
        ELSE NULL
      END,
      'send_time_kampala', COALESCE(NULLIF(btrim(COALESCE(p_payload ->> 'send_time_kampala', '')), ''), '07:30'),
      'recipient_emails', v_emails,
      'custom_message', COALESCE(NULLIF(btrim(COALESCE(p_payload ->> 'custom_message', '')), ''), '')
    );
  ELSIF v_kind = 'email' THEN
    v_canonical := jsonb_build_object(
      'kind', 'email',
      'recipient_email', lower(btrim(COALESCE(p_payload ->> 'recipient_email', ''))),
      'subject', btrim(COALESCE(p_payload ->> 'subject', '')),
      'message', btrim(COALESCE(p_payload ->> 'message', '')),
      'report_tool', lower(btrim(COALESCE(p_payload #>> '{report_reference,tool}', p_payload ->> 'report_tool', ''))),
      'report_rpc', lower(btrim(COALESCE(p_payload #>> '{report_reference,rpc}', p_payload ->> 'report_rpc', ''))),
      'report_args', COALESCE(p_payload #> '{report_reference,args}', p_payload -> 'report_args', '{}'::jsonb)
    );
  ELSIF v_kind = 'idea' THEN
    v_canonical := jsonb_build_object(
      'kind', 'idea',
      'title', btrim(COALESCE(p_payload ->> 'title', '')),
      'idea', btrim(COALESCE(p_payload ->> 'idea', '')),
      'category', lower(btrim(COALESCE(p_payload ->> 'category', 'operations'))),
      'evidence_summary', btrim(COALESCE(p_payload ->> 'evidence_summary', '')),
      'source', btrim(COALESCE(p_payload ->> 'source', '')),
      'period_label', btrim(COALESCE(p_payload ->> 'period_label', p_payload ->> 'period', 'Current period'))
    );
  ELSE
    RAISE EXCEPTION 'Invalid draft kind: %', v_kind USING ERRCODE = '22023';
  END IF;

  RETURN encode(extensions.digest(v_canonical::text, 'sha256'), 'hex');
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_compute_draft_hash(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_compute_draft_hash(text, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.staff_assistant_save_draft(
  p_kind text,
  p_payload jsonb,
  p_conversation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_kind text := lower(btrim(COALESCE(p_kind, '')));
  v_hash text;
  v_row public.staff_assistant_drafts;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;

  IF v_kind NOT IN ('email', 'reminder', 'notification', 'schedule', 'idea') THEN
    RAISE EXCEPTION 'Invalid draft kind: %', v_kind USING ERRCODE = '22023';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Draft payload must be a JSON object.' USING ERRCODE = '22023';
  END IF;

  v_hash := public.staff_assistant_compute_draft_hash(v_kind, p_payload);

  INSERT INTO public.staff_assistant_drafts (
    user_id,
    kind,
    payload,
    payload_hash,
    conversation_id,
    expires_at
  )
  VALUES (
    v_uid,
    v_kind,
    p_payload,
    v_hash,
    p_conversation_id,
    now() + interval '30 minutes'
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'draft_id', v_row.id,
    'kind', v_row.kind,
    'payload_hash', v_row.payload_hash,
    'expires_at', v_row.expires_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_save_draft(text, jsonb, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_save_draft(text, jsonb, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_assistant_is_valid_link_path(
  p_link_path text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_path text := btrim(COALESCE(p_link_path, ''));
BEGIN
  IF v_path = '' THEN
    RETURN false;
  END IF;

  IF left(v_path, 1) <> '/' OR left(v_path, 2) = '//' OR v_path ~* '[:\\]' OR v_path ~ '[\x00-\x1F\x7F]' THEN
    RETURN false;
  END IF;

  RETURN v_path IN (
    '/me',
    '/me/zoe',
    '/me/ideas',
    '/me/payslips',
    '/me/work',
    '/me/tickets',
    '/me/requisitions',
    '/me/concerns',
    '/me/food',
    '/me/reports',
    '/me/staff-reports',
    '/your-profile',
    '/cfo/cash-position',
    '/cfo/receivables-analysis',
    '/cfo/payables-forecast',
    '/cfo-dashboard',
    '/financial-ops',
    '/coo-dashboard',
    '/ceo-dashboard',
    '/executive-hub',
    '/executive-hub?tab=agent-ops',
    '/executive-hub?tab=partner-ops',
    '/hr-dashboard',
    '/tenant-ops/workspace',
    '/landlord-ops',
    '/landlord-ops/principal-recovered',
    '/crm/dashboard',
    '/operations',
    '/admin/dashboard'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_is_valid_link_path(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_is_valid_link_path(text) TO authenticated, service_role;

-- =============================================================================
-- 4. SIX READ-ONLY ADVISOR TOOLS (`assistant_staff_insight_*`, Prompt 4 item 1)
--    All STABLE, SECURITY DEFINER, SET search_path = public, zero identity
--    parameters, role-checked, and built only from existing official figures.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- I1. Where Rent Plan requests wait longest, by desk and week
--     (`assistant_staff_insight_desk_wait_times`)
--     Built from `public.rent_request_timing(p_request_ids)` and
--     `public.tenant_ops_rent_request_lifetime()`.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_insight_desk_wait_times(
  p_weeks integer DEFAULT 4
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_weeks integer := LEAST(GREATEST(coalesce(p_weeks, 4), 1), 12);
  v_from date := v_today - (v_weeks * 7);
  v_ids uuid[];
  v_timing jsonb := '{}'::jsonb;
  v_lifetime jsonb := '{}'::jsonb;
  v_by_desk jsonb := '[]'::jsonb;
  v_by_week jsonb := '[]'::jsonb;
  v_longest_desk text := 'none';
  v_longest_avg_hours numeric := 0;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT (
       public.is_ops_role(v_uid)
       OR public._has_enabled_role(
         v_uid,
         ARRAY['tenant_ops', 'agent_ops', 'landlord_ops', 'partner_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
       )
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Rent Plan desk wait-time insights.'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_lifetime := public.staff_assistant_sanitize_jsonb(
      public.tenant_ops_rent_request_lifetime(),
      false,
      200
    );
  EXCEPTION
    WHEN OTHERS THEN
      v_lifetime := '{}'::jsonb;
  END;

  SELECT coalesce(array_agg(q.id), ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT rr.id
        FROM public.rent_requests rr
       WHERE rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')
         AND (
           rr.status IN (
             'service_center_review',
             'pending',
             'agent_ops_approved',
             'agent_verified',
             'tenant_ops_approved',
             'landlord_ops_approved',
             'partner_ops_approved',
             'coo_approved'
           )
           OR rr.created_at >= (v_from::timestamp AT TIME ZONE 'Africa/Kampala')
         )
       ORDER BY rr.created_at DESC
       LIMIT 200
    ) q;

  IF cardinality(v_ids) > 0 THEN
    BEGIN
      v_timing := public.rent_request_timing(v_ids);
    EXCEPTION
      WHEN OTHERS THEN
        v_timing := '{}'::jsonb;
    END;

    -- Aggregate wait times by current desk
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'desk', d.desk,
          'request_count', d.cnt,
          'avg_wait_hours', d.avg_hours,
          'max_wait_hours', d.max_hours,
          'total_rent_ugx', d.rent_sum
        )
        ORDER BY d.avg_hours DESC, d.cnt DESC
      ),
      '[]'::jsonb
    )
    INTO v_by_desk
    FROM (
      SELECT
        coalesce(nullif(tr.val -> 'current_desk' ->> 'desk', ''), rr.status::text) AS desk,
        count(*)::integer AS cnt,
        round(avg(coalesce((tr.val -> 'current_desk' ->> 'elapsed_seconds')::numeric, 0) / 3600.0), 1) AS avg_hours,
        round(max(coalesce((tr.val -> 'current_desk' ->> 'elapsed_seconds')::numeric, 0) / 3600.0), 1) AS max_hours,
        coalesce(sum(rr.rent_amount), 0)::numeric AS rent_sum
      FROM jsonb_array_elements(coalesce(v_timing -> 'rows', '[]'::jsonb)) AS tr(val)
      JOIN public.rent_requests rr ON rr.id = (tr.val ->> 'request_id')::uuid
      GROUP BY coalesce(nullif(tr.val -> 'current_desk' ->> 'desk', ''), rr.status::text)
    ) d;

    -- Aggregate wait times by Kampala week and desk
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'week_start', w.week_start,
          'desk', w.desk,
          'request_count', w.cnt,
          'avg_wait_hours', w.avg_hours,
          'max_wait_hours', w.max_hours
        )
        ORDER BY w.week_start DESC, w.avg_hours DESC
      ),
      '[]'::jsonb
    )
    INTO v_by_week
    FROM (
      SELECT
        date_trunc('week', (rr.created_at AT TIME ZONE 'Africa/Kampala'))::date AS week_start,
        coalesce(nullif(tr.val -> 'current_desk' ->> 'desk', ''), rr.status::text) AS desk,
        count(*)::integer AS cnt,
        round(avg(coalesce((tr.val -> 'current_desk' ->> 'elapsed_seconds')::numeric, 0) / 3600.0), 1) AS avg_hours,
        round(max(coalesce((tr.val -> 'current_desk' ->> 'elapsed_seconds')::numeric, 0) / 3600.0), 1) AS max_hours
      FROM jsonb_array_elements(coalesce(v_timing -> 'rows', '[]'::jsonb)) AS tr(val)
      JOIN public.rent_requests rr ON rr.id = (tr.val ->> 'request_id')::uuid
      GROUP BY
        date_trunc('week', (rr.created_at AT TIME ZONE 'Africa/Kampala'))::date,
        coalesce(nullif(tr.val -> 'current_desk' ->> 'desk', ''), rr.status::text)
      LIMIT 60
    ) w;

    IF jsonb_array_length(v_by_desk) > 0 THEN
      v_longest_desk := coalesce(v_by_desk -> 0 ->> 'desk', 'none');
      v_longest_avg_hours := coalesce((v_by_desk -> 0 ->> 'avg_wait_hours')::numeric, 0);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'source', 'rent_request_timing + tenant_ops_rent_request_lifetime (Rent Plan Desk Wait Times by Desk & Week)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_today,
      'weeks', v_weeks,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'longest_waiting_desk', v_longest_desk,
    'longest_waiting_avg_hours', v_longest_avg_hours,
    'by_desk', v_by_desk,
    'by_week', v_by_week,
    'lifetime_funnel', v_lifetime,
    'row_count', jsonb_array_length(v_by_desk),
    'rows', v_by_desk
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_insight_desk_wait_times(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_insight_desk_wait_times(integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- I2. Collection coverage trends and the agents and areas dropping week on week
--     (`assistant_staff_insight_collection_coverage_trends`)
--     Built from `get_tenant_ops_weekly_performance_amclock`,
--     `get_agent_ops_network_overview`, `agent_ops_metrics_locations`, and
--     `agent_ops_metrics_agents`.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_insight_collection_coverage_trends(
  p_weeks integer DEFAULT 4
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_weeks integer := LEAST(GREATEST(coalesce(p_weeks, 4), 2), 8);
  v_curr_start date := v_today - 6;
  v_prev_start date := v_today - 13;
  v_prev_end date := v_today - 7;
  v_four_wk_start date := v_today - (v_weeks * 7 - 1);
  v_curr_perf jsonb := '{}'::jsonb;
  v_prev_perf jsonb := '{}'::jsonb;
  v_network_curr jsonb := '{}'::jsonb;
  v_network_4w jsonb := '{}'::jsonb;
  v_areas_dropping jsonb := '[]'::jsonb;
  v_agents_dropping jsonb := '[]'::jsonb;
  v_anomalies jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT (
       public._am_staff_ok()
       OR public.is_ops_role(v_uid)
       OR public._has_enabled_role(
         v_uid,
         ARRAY['tenant_ops', 'agent_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
       )
     )
  THEN
    RAISE EXCEPTION 'Not authorized for collection coverage trend insights.'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_curr_perf := public.staff_assistant_sanitize_jsonb(
      public.get_tenant_ops_weekly_performance_amclock(v_today),
      false,
      200
    );
  EXCEPTION
    WHEN OTHERS THEN
      v_curr_perf := '{}'::jsonb;
  END;

  BEGIN
    v_prev_perf := public.staff_assistant_sanitize_jsonb(
      public.get_tenant_ops_weekly_performance_amclock(v_today - 7),
      false,
      200
    );
  EXCEPTION
    WHEN OTHERS THEN
      v_prev_perf := '{}'::jsonb;
  END;

  BEGIN
    v_network_curr := public.staff_assistant_sanitize_jsonb(
      public.get_agent_ops_network_overview(v_curr_start, v_today, 50000),
      false,
      200
    );
    v_network_4w := public.staff_assistant_sanitize_jsonb(
      public.get_agent_ops_network_overview(v_four_wk_start, v_today, 50000),
      false,
      200
    );
  EXCEPTION
    WHEN OTHERS THEN
      v_network_curr := '{}'::jsonb;
      v_network_4w := '{}'::jsonb;
  END;

  -- Areas/districts dropping week on week from official `agent_ops_metrics_locations`
  BEGIN
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'region', d.region,
          'district', d.district,
          'current_week_houses', d.curr_houses,
          'previous_week_houses', d.prev_houses,
          'change_houses', d.curr_houses - d.prev_houses,
          'pct_change', CASE
            WHEN d.prev_houses > 0 THEN round(((d.curr_houses - d.prev_houses)::numeric / d.prev_houses::numeric) * 100.0, 1)
            ELSE 0
          END,
          'current_week_agents', d.curr_agents,
          'previous_week_agents', d.prev_agents
        )
        ORDER BY (d.curr_houses - d.prev_houses) ASC, d.prev_houses DESC
      ),
      '[]'::jsonb
    )
    INTO v_areas_dropping
    FROM (
      SELECT
        coalesce(p.region, c.region, '(none)') AS region,
        coalesce(p.district, c.district, '(none)') AS district,
        coalesce(c.houses_listed, 0)::bigint AS curr_houses,
        coalesce(p.houses_listed, 0)::bigint AS prev_houses,
        coalesce(c.agents, 0)::bigint AS curr_agents,
        coalesce(p.agents, 0)::bigint AS prev_agents
      FROM public.agent_ops_metrics_locations(v_prev_start, v_prev_end, 'district') p
      FULL OUTER JOIN public.agent_ops_metrics_locations(v_curr_start, v_today, 'district') c
        ON coalesce(p.region, '') = coalesce(c.region, '')
       AND coalesce(p.district, '') = coalesce(c.district, '')
      WHERE coalesce(c.houses_listed, 0) < coalesce(p.houses_listed, 0)
      LIMIT 25
    ) d;
  EXCEPTION
    WHEN OTHERS THEN
      v_areas_dropping := '[]'::jsonb;
  END;

  -- Agents dropping week on week from official `agent_ops_metrics_agents`
  BEGIN
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'agent_name', a.name,
          'top_district', a.top_district,
          'current_week_houses', a.curr_houses,
          'previous_week_houses', a.prev_houses,
          'change_houses', a.curr_houses - a.prev_houses,
          'pct_change', CASE
            WHEN a.prev_houses > 0 THEN round(((a.curr_houses - a.prev_houses)::numeric / a.prev_houses::numeric) * 100.0, 1)
            ELSE 0
          END
        )
        ORDER BY (a.curr_houses - a.prev_houses) ASC, a.prev_houses DESC
      ),
      '[]'::jsonb
    )
    INTO v_agents_dropping
    FROM (
      SELECT
        p.name,
        coalesce(p.top_district, c.top_district, '(none)') AS top_district,
        coalesce(c.houses_listed, 0)::bigint AS curr_houses,
        coalesce(p.houses_listed, 0)::bigint AS prev_houses
      FROM public.agent_ops_metrics_agents(v_prev_start, v_prev_end, NULL, 'houses_listed', 'qualifying', 50, 0) p
      LEFT JOIN public.agent_ops_metrics_agents(v_curr_start, v_today, NULL, 'houses_listed', 'qualifying', 50, 0) c
        ON c.agent_id = p.agent_id
      WHERE coalesce(c.houses_listed, 0) < coalesce(p.houses_listed, 0)
      LIMIT 25
    ) a;
  EXCEPTION
    WHEN OTHERS THEN
      v_agents_dropping := '[]'::jsonb;
  END;

  -- Include latest collection anomaly notes from `staff_assistant_insights`
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kampala_date', i.kampala_date,
        'area_or_scope', i.area_or_scope,
        'headline', i.headline,
        'summary', i.summary,
        'current_value', i.current_value,
        'four_week_avg', i.four_week_avg,
        'pct_change', i.pct_change,
        'direction', i.direction,
        'source_function', i.source_function
      )
      ORDER BY i.kampala_date DESC, abs(i.pct_change) DESC
    ),
    '[]'::jsonb
  )
  INTO v_anomalies
  FROM (
    SELECT *
      FROM public.staff_assistant_insights si
     WHERE si.category = 'collections'
     ORDER BY si.kampala_date DESC, abs(si.pct_change) DESC
     LIMIT 15
  ) i;

  RETURN jsonb_build_object(
    'source', 'get_tenant_ops_weekly_performance_amclock + get_agent_ops_network_overview + agent_ops_metrics_locations + agent_ops_metrics_agents (Collection Coverage Trends & Dropping Areas/Agents)',
    'period', jsonb_build_object(
      'from', v_four_wk_start,
      'to', v_today,
      'current_week_from', v_curr_start,
      'previous_week_from', v_prev_start,
      'previous_week_to', v_prev_end,
      'weeks', v_weeks,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'current_week_performance', v_curr_perf,
    'previous_week_performance', v_prev_perf,
    'current_week_network', v_network_curr,
    'four_week_network', v_network_4w,
    'areas_dropping_count', jsonb_array_length(v_areas_dropping),
    'areas_dropping_week_on_week', v_areas_dropping,
    'agents_dropping_count', jsonb_array_length(v_agents_dropping),
    'agents_dropping_week_on_week', v_agents_dropping,
    'anomaly_notes', v_anomalies,
    'row_count', jsonb_array_length(v_areas_dropping),
    'rows', v_areas_dropping
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_insight_collection_coverage_trends(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_insight_collection_coverage_trends(integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- I3. Calling Center reach rates and the most common feedback themes
--     (`assistant_staff_insight_calling_reach_and_themes`)
--     Built from `cc_weekly_all_calls_report`, `staff_calling_detailed_report`,
--     `landlord_cc_weekly_report`, and `landlord_cc_concerns_report`.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_insight_calling_reach_and_themes(
  p_days integer DEFAULT 28
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_days integer := LEAST(GREATEST(coalesce(p_days, 28), 7), 90);
  v_from date := v_today - (v_days - 1);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end timestamptz := ((v_today + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_total_calls integer := 0;
  v_answered_calls integer := 0;
  v_reach_rate_pct numeric := 0;
  v_by_source jsonb := '[]'::jsonb;
  v_feedback_themes jsonb := '[]'::jsonb;
  v_landlord_weekly jsonb := '{}'::jsonb;
  v_landlord_concerns jsonb := '{}'::jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT (
       public._landlord_cc_staff_ok()
       OR public._am_staff_ok()
       OR public._has_enabled_role(
         v_uid,
         ARRAY['tenant_ops', 'landlord_ops', 'operations', 'hr', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
       )
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Calling Center reach rate and feedback theme insights.'
      USING ERRCODE = '42501';
  END IF;

  -- 1. Reach rates by calling channel/source from official `staff_calling_detailed_report`
  BEGIN
    SELECT
      count(*)::integer,
      count(*) FILTER (WHERE sdr.answered IS TRUE)::integer
    INTO v_total_calls, v_answered_calls
    FROM public.staff_calling_detailed_report(v_start, v_end) sdr;

    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'source', s.source_name,
          'total_calls', s.total_cnt,
          'answered_calls', s.ans_cnt,
          'unreached_calls', s.total_cnt - s.ans_cnt,
          'reach_rate_pct', CASE
            WHEN s.total_cnt > 0 THEN round((s.ans_cnt::numeric / s.total_cnt::numeric) * 100.0, 1)
            ELSE 0
          END
        )
        ORDER BY s.total_cnt DESC, s.source_name ASC
      ),
      '[]'::jsonb
    )
    INTO v_by_source
    FROM (
      SELECT
        coalesce(sdr.source, 'Calling Center') AS source_name,
        count(*)::integer AS total_cnt,
        count(*) FILTER (WHERE sdr.answered IS TRUE)::integer AS ans_cnt
      FROM public.staff_calling_detailed_report(v_start, v_end) sdr
      GROUP BY coalesce(sdr.source, 'Calling Center')
    ) s;
  EXCEPTION
    WHEN OTHERS THEN
      v_total_calls := 0;
      v_answered_calls := 0;
      v_by_source := '[]'::jsonb;
  END;

  IF v_total_calls > 0 THEN
    v_reach_rate_pct := round((v_answered_calls::numeric / v_total_calls::numeric) * 100.0, 1);
  END IF;

  -- 2. Landlord Calling Center weekly report & concerns breakdown
  BEGIN
    v_landlord_weekly := public.staff_assistant_sanitize_jsonb(
      public.landlord_cc_weekly_report(v_today),
      false,
      200
    );
  EXCEPTION
    WHEN OTHERS THEN
      v_landlord_weekly := '{}'::jsonb;
  END;

  BEGIN
    v_landlord_concerns := public.staff_assistant_sanitize_jsonb(
      public.landlord_cc_concerns_report(v_from, v_today),
      false,
      200
    );
  EXCEPTION
    WHEN OTHERS THEN
      v_landlord_concerns := '{}'::jsonb;
  END;

  -- 3. Most common feedback themes from `cc_feedback` + `cc_feedback_categories` + `cc_forwarded_concerns`
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'theme_code', t.theme_code,
        'theme_label', t.theme_label,
        'feedback_count', t.cnt,
        'open_concerns_count', t.open_cnt
      )
      ORDER BY t.cnt DESC, t.theme_label ASC
    ),
    '[]'::jsonb
  )
  INTO v_feedback_themes
  FROM (
    SELECT
      coalesce(cat.code, 'general_feedback') AS theme_code,
      coalesce(cat.label, 'General Calling Feedback') AS theme_label,
      count(*)::integer AS cnt,
      count(fc.id) FILTER (WHERE fc.status <> 'completed')::integer AS open_cnt
    FROM public.cc_feedback fb
    LEFT JOIN public.cc_feedback_categories cat ON cat.id = fb.category_id
    LEFT JOIN public.cc_forwarded_concerns fc ON fc.feedback_id = fb.id
    WHERE fb.created_at >= v_start
      AND fb.created_at < v_end
    GROUP BY coalesce(cat.code, 'general_feedback'), coalesce(cat.label, 'General Calling Feedback')
    ORDER BY count(*) DESC
    LIMIT 25
  ) t;

  IF jsonb_array_length(v_feedback_themes) = 0 AND jsonb_typeof(v_landlord_concerns -> 'by_category') = 'array' THEN
    v_feedback_themes := v_landlord_concerns -> 'by_category';
  END IF;

  RETURN jsonb_build_object(
    'source', 'cc_weekly_all_calls_report + staff_calling_detailed_report + landlord_cc_weekly_report + landlord_cc_concerns_report (Calling Center Reach Rates & Feedback Themes)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_today,
      'days', v_days,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'total_calls', coalesce(v_total_calls, 0),
    'answered_calls', coalesce(v_answered_calls, 0),
    'unreached_calls', GREATEST(coalesce(v_total_calls, 0) - coalesce(v_answered_calls, 0), 0),
    'reach_rate_pct', coalesce(v_reach_rate_pct, 0),
    'by_source', v_by_source,
    'feedback_themes_count', jsonb_array_length(v_feedback_themes),
    'feedback_themes', v_feedback_themes,
    'landlord_weekly_summary', coalesce(v_landlord_weekly -> 'totals', '{}'::jsonb),
    'landlord_concerns_summary', coalesce(v_landlord_concerns -> 'totals', '{}'::jsonb),
    'row_count', jsonb_array_length(v_by_source),
    'rows', v_by_source
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_insight_calling_reach_and_themes(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_insight_calling_reach_and_themes(integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- I4. Payout delays (`assistant_staff_insight_payout_delays`)
--     Built from `tops_landlord_not_paid_summary_amclock`, `am_uncovered_plans`,
--     and `ops_landlord_ops_home_range`.
--     Gated the same way as finance and landlord payout reports.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_insight_payout_delays(
  p_days integer DEFAULT 28
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_days integer := LEAST(GREATEST(coalesce(p_days, 28), 7), 90);
  v_from date := v_today - (v_days - 1);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end timestamptz := ((v_today + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_allow_phones boolean;
  v_summary record;
  v_lops_home jsonb := '{}'::jsonb;
  v_by_bucket jsonb := '[]'::jsonb;
  v_delayed_rows jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT (
       public.can_view_finance_reports(v_uid)
       OR (
         public.can_view_staff_reports(v_uid)
         AND public._has_enabled_role(
           v_uid,
           ARRAY['landlord_ops', 'tenant_ops', 'financial_ops', 'cfo', 'coo', 'ceo', 'manager', 'super_admin']
         )
       )
     )
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['financial_ops', 'cfo', 'coo', 'ceo', 'landlord_ops', 'tenant_ops', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for payout delay insights.'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('landlord_ops');

  BEGIN
    SELECT *
      INTO v_summary
      FROM public.tops_landlord_not_paid_summary_amclock()
     LIMIT 1;
  EXCEPTION
    WHEN OTHERS THEN
      v_summary := NULL;
  END;

  BEGIN
    v_lops_home := public.staff_assistant_sanitize_jsonb(
      public.ops_landlord_ops_home_range(v_start, v_end),
      v_allow_phones,
      200
    );
  EXCEPTION
    WHEN OTHERS THEN
      v_lops_home := '{}'::jsonb;
  END;

  BEGIN
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'bucket', b.bucket,
          'plan_count', b.cnt,
          'avg_days_since_funding', b.avg_days,
          'max_days_since_funding', b.max_days,
          'total_funded_ugx', b.funded_sum
        )
        ORDER BY b.avg_days DESC NULLS LAST, b.cnt DESC
      ),
      '[]'::jsonb
    )
    INTO v_by_bucket
    FROM (
      SELECT
        coalesce(u.bucket, 'uncovered') AS bucket,
        count(*)::integer AS cnt,
        round(avg(coalesce(u.days_since_funding, 0)::numeric), 1) AS avg_days,
        max(coalesce(u.days_since_funding, 0))::integer AS max_days,
        coalesce(sum(u.funded_amount), 0)::numeric AS funded_sum
      FROM public.am_uncovered_plans(v_today, 200, 0) u
      GROUP BY coalesce(u.bucket, 'uncovered')
    ) b;

    SELECT coalesce(
      jsonb_agg(
        public.staff_assistant_sanitize_jsonb(
          jsonb_build_object(
            'bucket', u.bucket,
            'tenant_name', u.tenant_name,
            'agent_name', u.agent_name,
            'funded_amount_ugx', u.funded_amount,
            'days_since_funding', u.days_since_funding,
            'payout_kind', u.payout_kind,
            'pipeline_status', u.pipeline_status
          ),
          v_allow_phones,
          200
        )
        ORDER BY coalesce(u.days_since_funding, 0) DESC
      ),
      '[]'::jsonb
    )
    INTO v_delayed_rows
    FROM (
      SELECT *
        FROM public.am_uncovered_plans(v_today, 50, 0)
       ORDER BY days_since_funding DESC NULLS LAST
       LIMIT 50
    ) u;
  EXCEPTION
    WHEN OTHERS THEN
      v_by_bucket := '[]'::jsonb;
      v_delayed_rows := '[]'::jsonb;
  END;

  RETURN jsonb_build_object(
    'source', 'tops_landlord_not_paid_summary_amclock + am_uncovered_plans + ops_landlord_ops_home_range (Landlord Payout Delays)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_today,
      'days', v_days,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'tenant_paying_no_landlord_count', coalesce(v_summary.tenant_paying_no_landlord, 0),
    'awaiting_landlord_count', coalesce(v_summary.awaiting_landlord, 0),
    'total_uncovered_plans_count', coalesce(v_summary.total_plans, 0),
    'by_delay_bucket', v_by_bucket,
    'landlord_ops_home_summary', v_lops_home,
    'row_count', jsonb_array_length(v_delayed_rows),
    'rows', v_delayed_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_insight_payout_delays(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_insight_payout_delays(integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- I5. Zoe's own unanswered questions and thumbs-down themes
--     (`assistant_staff_insight_zoe_unanswered_and_feedback`)
--     Built from `staff_assistant_unanswered` and `staff_assistant_feedback`
--     (same redacted aggregation as `staff_assistant_crm_weekly_learning_report`,
--     never exposing assistant answer text or figures across roles).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_insight_zoe_unanswered_and_feedback(
  p_days integer DEFAULT 28
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_days integer := LEAST(GREATEST(coalesce(p_days, 28), 7), 90);
  v_from date := v_today - (v_days - 1);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_unanswered_by_reason jsonb := '[]'::jsonb;
  v_top_unanswered jsonb := '[]'::jsonb;
  v_thumbs_down_themes jsonb := '[]'::jsonb;
  v_total_unanswered integer := 0;
  v_total_thumbs_down integer := 0;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT (
       public.staff_assistant_is_crm_reviewer()
       OR (
         public.can_view_staff_reports(v_uid)
         AND public._has_enabled_role(
           v_uid,
           ARRAY['crm', 'hr', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'admin', 'super_admin']
         )
       )
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Zoe unanswered question and feedback insights.'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer
    INTO v_total_unanswered
    FROM public.staff_assistant_unanswered u
   WHERE u.created_at >= v_start;

  SELECT count(*)::integer
    INTO v_total_thumbs_down
    FROM public.staff_assistant_feedback f
   WHERE f.rating = 'down'
     AND f.created_at >= v_start;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'reason', r.reason,
        'question_count', r.cnt,
        'open_count', r.open_cnt
      )
      ORDER BY r.cnt DESC, r.reason ASC
    ),
    '[]'::jsonb
  )
  INTO v_unanswered_by_reason
  FROM (
    SELECT
      coalesce(u.reason, 'unmatched') AS reason,
      count(*)::integer AS cnt,
      count(*) FILTER (WHERE u.status = 'open')::integer AS open_cnt
    FROM public.staff_assistant_unanswered u
    WHERE u.created_at >= v_start
    GROUP BY coalesce(u.reason, 'unmatched')
  ) r;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'question_theme', q.display_question,
        'reason', q.reason,
        'ask_count', q.ask_count,
        'distinct_staff_count', q.staff_count,
        'status', q.latest_status
      )
      ORDER BY q.ask_count DESC, q.last_asked DESC
    ),
    '[]'::jsonb
  )
  INTO v_top_unanswered
  FROM (
    SELECT
      max(public.assistant_clean_text(btrim(u.question), 180)) AS display_question,
      (array_agg(u.reason ORDER BY u.created_at DESC))[1] AS reason,
      count(*)::integer AS ask_count,
      count(DISTINCT u.user_id)::integer AS staff_count,
      (array_agg(u.status ORDER BY u.created_at DESC))[1] AS latest_status,
      max(u.created_at) AS last_asked
    FROM public.staff_assistant_unanswered u
    WHERE u.created_at >= v_start
    GROUP BY lower(regexp_replace(btrim(u.question), '\s+', ' ', 'g'))
    ORDER BY count(*) DESC, max(u.created_at) DESC
    LIMIT 20
  ) q;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'feedback_theme', f.comment_theme,
        'thumbs_down_count', f.cnt,
        'latest_at', f.latest_at
      )
      ORDER BY f.cnt DESC, f.latest_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_thumbs_down_themes
  FROM (
    SELECT
      coalesce(
        nullif(public.assistant_clean_text(btrim(fb.comment), 160), ''),
        'Thumbs-down without written comment'
      ) AS comment_theme,
      count(*)::integer AS cnt,
      max(fb.created_at) AS latest_at
    FROM public.staff_assistant_feedback fb
    WHERE fb.rating = 'down'
      AND fb.created_at >= v_start
    GROUP BY coalesce(
      nullif(public.assistant_clean_text(btrim(fb.comment), 160), ''),
      'Thumbs-down without written comment'
    )
    ORDER BY count(*) DESC, max(fb.created_at) DESC
    LIMIT 20
  ) f;

  RETURN jsonb_build_object(
    'source', 'staff_assistant_crm_weekly_learning_report + staff_assistant_unanswered + staff_assistant_feedback (Zoe Unanswered Questions & Thumbs-Down Themes)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_today,
      'days', v_days,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'total_unanswered_count', coalesce(v_total_unanswered, 0),
    'total_thumbs_down_count', coalesce(v_total_thumbs_down, 0),
    'unanswered_by_reason', v_unanswered_by_reason,
    'top_unanswered_questions', v_top_unanswered,
    'thumbs_down_themes', v_thumbs_down_themes,
    'row_count', jsonb_array_length(v_top_unanswered),
    'rows', v_top_unanswered
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_insight_zoe_unanswered_and_feedback(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_insight_zoe_unanswered_and_feedback(integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- I6. Daily Anomaly Notes Reader (`assistant_staff_insight_anomalies`)
--     Reads notable 4-week comparison anomalies from `public.staff_assistant_insights`,
--     gated by the caller's finance/staff report permissions.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_insight_anomalies(
  p_category text DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_cat text := nullif(lower(btrim(coalesce(p_category, ''))), '');
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 20), 1), 100);
  v_can_finance boolean;
  v_can_staff boolean;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required.'
      USING ERRCODE = '42501';
  END IF;

  v_can_finance := public.can_view_finance_reports(v_uid);
  v_can_staff := public.can_view_staff_reports(v_uid);

  IF NOT (v_can_finance OR v_can_staff) THEN
    RAISE EXCEPTION 'Not authorized for anomaly insights.'
      USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', i.id,
        'kampala_date', i.kampala_date,
        'metric_key', i.metric_key,
        'category', i.category,
        'area_or_scope', i.area_or_scope,
        'headline', i.headline,
        'summary', i.summary,
        'current_value', i.current_value,
        'four_week_avg', i.four_week_avg,
        'pct_change', i.pct_change,
        'direction', i.direction,
        'severity', i.severity,
        'source_function', i.source_function,
        'screen_link', i.screen_link
      )
      ORDER BY
        i.kampala_date DESC,
        CASE i.severity WHEN 'high' THEN 1 WHEN 'notable' THEN 2 ELSE 3 END,
        abs(i.pct_change) DESC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM (
    SELECT *
      FROM public.staff_assistant_insights si
     WHERE (v_cat IS NULL OR si.category = v_cat)
       AND (
         (si.requires_finance_gate IS TRUE AND v_can_finance IS TRUE)
         OR (si.requires_finance_gate IS FALSE AND v_can_staff IS TRUE)
       )
     ORDER BY
       si.kampala_date DESC,
       CASE si.severity WHEN 'high' THEN 1 WHEN 'notable' THEN 2 ELSE 3 END,
       abs(si.pct_change) DESC
     LIMIT v_limit
  ) i;

  RETURN jsonb_build_object(
    'source', 'staff_assistant_insights (Daily 4-Week Anomaly Notes)',
    'period', jsonb_build_object(
      'as_of', v_today,
      'category_filter', coalesce(v_cat, 'all_authorized'),
      'timezone', 'Africa/Kampala'
    ),
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_insight_anomalies(text, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_insight_anomalies(text, integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Update `staff_assistant_can_user_read_report` to include the 6 new
--    `assistant_staff_insight_*` advisor RPCs
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_can_user_read_report(
  p_user_id uuid,
  p_report_rpc text,
  p_owner_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller_role text := COALESCE(auth.role(), '');
  v_caller_uid uuid := (SELECT auth.uid());
  v_rpc text := lower(btrim(COALESCE(p_report_rpc, '')));
  v_roles text[];
BEGIN
  IF v_caller_role <> 'service_role' THEN
    IF v_caller_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
      RETURN false;
    END IF;
  END IF;

  IF p_user_id IS NULL OR v_rpc !~ '^assistant_staff_[a-z0-9_]+$' THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.staff_assistant_config c
    WHERE c.id = true AND c.enabled = true
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = p_user_id
      AND COALESCE(p.is_frozen, false) IS TRUE
  ) THEN
    RETURN false;
  END IF;

  SELECT COALESCE(
    array_agg(DISTINCT lower(ur.role::text)) FILTER (WHERE ur.enabled IS TRUE),
    ARRAY[]::text[]
  )
    INTO v_roles
    FROM public.user_roles ur
   WHERE ur.user_id = p_user_id
     AND ur.enabled IS TRUE;

  IF NOT (
    v_roles && public.staff_assistant_write_or_read_roles_list()
    OR EXISTS (
      SELECT 1
      FROM public.hr_staff hs
      WHERE hs.user_id = p_user_id
        AND hs.active IS TRUE
        AND hs.ended_on IS NULL
    )
  ) THEN
    RETURN false;
  END IF;

  IF v_rpc LIKE 'assistant_staff_my_%' THEN
    RETURN (p_owner_id IS NULL OR p_user_id = p_owner_id);
  END IF;

  IF v_rpc IN (
    'assistant_staff_tops_first_seven_summary',
    'assistant_staff_tops_tenant_classification',
    'assistant_staff_tops_smartphone_usage',
    'assistant_staff_tops_no_payment_report',
    'assistant_staff_tops_rent_requests_by_stage',
    'assistant_staff_tops_time_on_desk',
    'assistant_staff_tops_find_tenant'
  ) THEN
    RETURN v_roles && ARRAY['tenant_ops','operations','coo','ceo','cfo','cto','manager','super_admin'];
  END IF;

  IF v_rpc = 'assistant_staff_tops_awareness_calls' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['tenant_ops','landlord_ops','operations','hr','coo','ceo','cfo','cto','manager','super_admin']);
  END IF;

  IF v_rpc IN (
    'assistant_staff_tops_arrears_ageing',
    'assistant_staff_tops_landlord_not_paid'
  ) THEN
    RETURN v_roles && ARRAY['tenant_ops','operations','coo','ceo','cfo','super_admin'];
  END IF;

  IF v_rpc IN (
    'assistant_staff_tops_weekly_performance',
    'assistant_staff_tops_rent_request_lifetime',
    'assistant_staff_tops_pipeline_waiting_on_lops'
  ) THEN
    RETURN v_roles && ARRAY['tenant_ops','operations','coo','ceo','cto','manager','super_admin'];
  END IF;

  IF v_rpc IN ('assistant_staff_lops_home_range', 'assistant_staff_lops_verification_queue') THEN
    RETURN v_roles && ARRAY['landlord_ops','coo','cfo','ceo','manager','super_admin'];
  END IF;

  IF v_rpc = 'assistant_staff_lops_paid_lists' THEN
    RETURN v_roles && ARRAY['landlord_ops','coo','cfo','ceo','super_admin'];
  END IF;

  IF v_rpc = 'assistant_staff_lops_principal_comparison' THEN
    RETURN v_roles && ARRAY['landlord_ops','cfo','ceo','coo','manager','financial_ops','super_admin','cto'];
  END IF;

  IF v_rpc IN (
    'assistant_staff_lops_calling_summary',
    'assistant_staff_lops_calling_coverage'
  ) THEN
    RETURN v_roles && ARRAY['landlord_ops','operations','coo','ceo','cfo','cto','manager','hr','super_admin'];
  END IF;

  IF v_rpc = 'assistant_staff_aops_network_overview' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['operations','coo','ceo','cfo','cto','manager','super_admin']);
  END IF;

  IF v_rpc IN (
    'assistant_staff_aops_metrics_totals',
    'assistant_staff_aops_metrics_agents',
    'assistant_staff_aops_listing_quality_and_risk',
    'assistant_staff_aops_subagent_teams'
  ) THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['agent_ops','operations','coo','ceo','cfo','cto','manager','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_aops_silent_collectors' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['agent_ops','tenant_ops','operations','coo','ceo','cfo','cto','manager','super_admin']);
  END IF;

  IF v_rpc IN (
    'assistant_staff_pops_pending_summary',
    'assistant_staff_pops_search_supporters'
  ) THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['partner_ops','cfo','ceo','coo','manager','super_admin']);
  END IF;

  IF v_rpc IN (
    'assistant_staff_pops_report_overview',
    'assistant_staff_pops_returns_due',
    'assistant_staff_pops_topups_and_withdrawals_waiting'
  ) THEN
    RETURN (public.can_view_staff_reports(p_user_id) OR public.can_view_finance_reports(p_user_id))
       AND (v_roles && ARRAY['partner_ops','financial_ops','cfo','ceo','coo','manager','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_pso_cohort_performance' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['partner_ops','hr','coo','ceo','super_admin']);
  END IF;

  IF v_rpc IN (
    'assistant_staff_cfo_treasury_cash_position',
    'assistant_staff_cfo_receivables_and_payables',
    'assistant_staff_cfo_seven_day_expenses'
  ) THEN
    RETURN public.can_view_finance_reports(p_user_id)
       AND (v_roles && ARRAY['cfo','ceo','coo','manager','financial_ops','cto','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_cfo_money_flow_summary' THEN
    RETURN public.can_view_finance_reports(p_user_id)
       AND (v_roles && ARRAY['cfo','ceo','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_cfo_budget_revised_position' THEN
    RETURN public.can_view_finance_reports(p_user_id)
       AND (v_roles && ARRAY['cfo','ceo','coo','super_admin']);
  END IF;

  IF v_rpc IN (
    'assistant_staff_fops_verification_and_requisitions',
    'assistant_staff_fops_disbursements',
    'assistant_staff_fops_merchant_cashouts'
  ) THEN
    RETURN public.can_view_finance_reports(p_user_id)
       AND (v_roles && ARRAY['financial_ops','cfo','ceo','coo','manager','super_admin']);
  END IF;

  IF v_rpc IN (
    'assistant_staff_coo_overview',
    'assistant_staff_ceo_growth_and_approvals'
  ) THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['coo','ceo','cfo','manager','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_hr_calling_detailed_report' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (
         p_user_id IN (
           '5295252d-f477-42a9-92f5-af56e503e33d'::uuid,
           'a9258d45-3e27-4827-af71-64344e76fb4f'::uuid,
           'fda0d518-98c4-45e4-83d8-64266b25eefa'::uuid,
           'fe1e9f51-a2c3-49fc-bd40-b2c143afe628'::uuid
         )
         OR (v_roles && ARRAY['hr','tenant_ops','landlord_ops','operations','coo','cfo','ceo','manager','super_admin'])
       );
  END IF;

  IF v_rpc = 'assistant_staff_hr_contracts_and_birthdays' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['hr','coo','ceo','cfo','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_hr_payroll_cost_by_department' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['hr','cfo','coo','ceo','super_admin']);
  END IF;

  -- Group I: Prompt 4 Advisor Insights (`assistant_staff_insight_*`)
  IF v_rpc = 'assistant_staff_insight_desk_wait_times' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['tenant_ops','agent_ops','landlord_ops','partner_ops','operations','coo','ceo','cfo','cto','manager','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_insight_collection_coverage_trends' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['tenant_ops','agent_ops','operations','coo','ceo','cfo','cto','manager','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_insight_calling_reach_and_themes' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['tenant_ops','landlord_ops','operations','hr','coo','ceo','cfo','cto','manager','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_insight_payout_delays' THEN
    RETURN (public.can_view_finance_reports(p_user_id) OR public.can_view_staff_reports(p_user_id))
       AND (v_roles && ARRAY['financial_ops','cfo','coo','ceo','landlord_ops','tenant_ops','manager','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_insight_zoe_unanswered_and_feedback' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['crm','hr','operations','coo','ceo','cfo','cto','manager','admin','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_insight_anomalies' THEN
    RETURN public.can_view_staff_reports(p_user_id) OR public.can_view_finance_reports(p_user_id);
  END IF;

  RETURN false;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_can_user_read_report(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_can_user_read_report(uuid, text, uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6. Daily Anomaly Computation Job (`staff_assistant_compute_daily_insights`)
--    Compares today's / current week's key figures with the last 4 weeks and
--    saves notable changes to `public.staff_assistant_insights`.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_compute_daily_insights(
  p_as_of date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller_role text := COALESCE(auth.role(), '');
  v_uid uuid := (SELECT auth.uid());
  v_today date := COALESCE(p_as_of, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_curr_start timestamptz := ((v_today - 6)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_curr_end timestamptz := ((v_today + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_base_start timestamptz := ((v_today - 34)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_base_end timestamptz := ((v_today - 6)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_inserted integer := 0;
  v_rec record;
  v_open_desk_cnt integer := 0;
  v_base_desk_avg numeric := 0;
  v_desk_pct numeric := 0;
  v_curr_reach numeric := 0;
  v_base_reach numeric := 0;
  v_reach_diff numeric := 0;
  v_unans_curr integer := 0;
  v_unans_base numeric := 0;
  v_unans_pct numeric := 0;
BEGIN
  IF v_caller_role <> 'service_role' AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    IF v_uid IS NULL OR NOT public.staff_assistant_can_manage_ideas() THEN
      RAISE EXCEPTION 'Not authorized to compute daily Zoe insights.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- A. District / Area collection & listing activity vs 4-week average
  FOR v_rec IN
    WITH curr_area AS (
      SELECT
        COALESCE(NULLIF(btrim(h.district), ''), 'Kampala') AS area_name,
        count(*)::numeric AS curr_cnt
      FROM public.house_listings h
      WHERE h.created_at >= v_curr_start
        AND h.created_at < v_curr_end
      GROUP BY COALESCE(NULLIF(btrim(h.district), ''), 'Kampala')
    ),
    base_area AS (
      SELECT
        COALESCE(NULLIF(btrim(h.district), ''), 'Kampala') AS area_name,
        round((count(*)::numeric / 4.0), 1) AS four_wk_avg
      FROM public.house_listings h
      WHERE h.created_at >= v_base_start
        AND h.created_at < v_base_end
      GROUP BY COALESCE(NULLIF(btrim(h.district), ''), 'Kampala')
    )
    SELECT
      COALESCE(b.area_name, c.area_name) AS area_name,
      COALESCE(c.curr_cnt, 0) AS curr_val,
      COALESCE(b.four_wk_avg, 0) AS avg_val,
      CASE
        WHEN COALESCE(b.four_wk_avg, 0) > 0
          THEN round(((COALESCE(c.curr_cnt, 0) - b.four_wk_avg) / b.four_wk_avg) * 100.0, 1)
        ELSE 0
      END AS pct_chg
    FROM base_area b
    FULL OUTER JOIN curr_area c ON c.area_name = b.area_name
    WHERE COALESCE(b.four_wk_avg, 0) >= 2
      AND abs(
        CASE
          WHEN COALESCE(b.four_wk_avg, 0) > 0
            THEN ((COALESCE(c.curr_cnt, 0) - b.four_wk_avg) / b.four_wk_avg) * 100.0
          ELSE 0
        END
      ) >= 15
    ORDER BY abs(
      CASE
        WHEN COALESCE(b.four_wk_avg, 0) > 0
          THEN ((COALESCE(c.curr_cnt, 0) - b.four_wk_avg) / b.four_wk_avg) * 100.0
        ELSE 0
      END
    ) DESC
    LIMIT 6
  LOOP
    INSERT INTO public.staff_assistant_insights (
      kampala_date,
      metric_key,
      category,
      area_or_scope,
      headline,
      summary,
      current_value,
      four_week_avg,
      pct_change,
      direction,
      severity,
      evidence,
      source_function,
      screen_link,
      requires_finance_gate
    )
    VALUES (
      v_today,
      'area_weekly_activity',
      'collections',
      v_rec.area_name,
      format(
        'Activity in %s is %s%% %s its 4-week average',
        v_rec.area_name,
        abs(v_rec.pct_chg),
        CASE WHEN v_rec.pct_chg < 0 THEN 'below' ELSE 'above' END
      ),
      format(
        '%s recorded %s verified/listed units in the last 7 days compared with a 4-week weekly average of %s (%s%%).',
        v_rec.area_name,
        v_rec.curr_val,
        v_rec.avg_val,
        v_rec.pct_chg
      ),
      v_rec.curr_val,
      v_rec.avg_val,
      v_rec.pct_chg,
      CASE WHEN v_rec.pct_chg < 0 THEN 'down' WHEN v_rec.pct_chg > 0 THEN 'up' ELSE 'flat' END,
      CASE WHEN abs(v_rec.pct_chg) >= 30 THEN 'high' ELSE 'notable' END,
      jsonb_build_object(
        'area', v_rec.area_name,
        'current_7d_count', v_rec.curr_val,
        'four_week_weekly_avg', v_rec.avg_val,
        'pct_change', v_rec.pct_chg
      ),
      'agent_ops_metrics_locations + get_tenant_ops_weekly_performance_amclock',
      '/executive-hub?tab=agent-ops',
      false
    )
    ON CONFLICT (kampala_date, metric_key, area_or_scope) DO UPDATE
      SET headline = EXCLUDED.headline,
          summary = EXCLUDED.summary,
          current_value = EXCLUDED.current_value,
          four_week_avg = EXCLUDED.four_week_avg,
          pct_change = EXCLUDED.pct_change,
          direction = EXCLUDED.direction,
          severity = EXCLUDED.severity,
          evidence = EXCLUDED.evidence;
    v_inserted := v_inserted + 1;
  END LOOP;

  -- B. Rent Plan Pipeline Desk Queue vs 4-week weekly intake average
  SELECT count(*)::integer
    INTO v_open_desk_cnt
    FROM public.rent_requests rr
   WHERE rr.status IN (
     'service_center_review',
     'pending',
     'agent_ops_approved',
     'agent_verified',
     'tenant_ops_approved',
     'landlord_ops_approved',
     'partner_ops_approved',
     'coo_approved'
   );

  SELECT round((count(*)::numeric / 4.0), 1)
    INTO v_base_desk_avg
    FROM public.rent_requests rr
   WHERE rr.created_at >= v_base_start
     AND rr.created_at < v_base_end
     AND rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent');

  v_base_desk_avg := GREATEST(COALESCE(v_base_desk_avg, 1), 1);
  v_desk_pct := round(((v_open_desk_cnt::numeric - v_base_desk_avg) / v_base_desk_avg) * 100.0, 1);

  INSERT INTO public.staff_assistant_insights (
    kampala_date,
    metric_key,
    category,
    area_or_scope,
    headline,
    summary,
    current_value,
    four_week_avg,
    pct_change,
    direction,
    severity,
    evidence,
    source_function,
    screen_link,
    requires_finance_gate
  )
  VALUES (
    v_today,
    'open_desk_pipeline_queue',
    'desk_waiting',
    'All Approval Desks',
    format('Open Rent Plan desk queue stands at %s applications vs %s weekly baseline', v_open_desk_cnt, v_base_desk_avg),
    format(
      'There are %s Rent Plan applications currently waiting across approval desks compared with a 4-week average weekly intake of %s (%s%% difference).',
      v_open_desk_cnt,
      v_base_desk_avg,
      v_desk_pct
    ),
    v_open_desk_cnt,
    v_base_desk_avg,
    v_desk_pct,
    CASE WHEN v_desk_pct > 0 THEN 'up' WHEN v_desk_pct < 0 THEN 'down' ELSE 'flat' END,
    CASE WHEN v_open_desk_cnt >= 25 THEN 'high' ELSE 'notable' END,
    jsonb_build_object(
      'open_desk_requests', v_open_desk_cnt,
      'four_week_weekly_avg', v_base_desk_avg,
      'pct_change', v_desk_pct
    ),
    'rent_request_timing + tenant_ops_rent_request_lifetime',
    '/tenant-ops/workspace',
    false
  )
  ON CONFLICT (kampala_date, metric_key, area_or_scope) DO UPDATE
    SET headline = EXCLUDED.headline,
        summary = EXCLUDED.summary,
        current_value = EXCLUDED.current_value,
        four_week_avg = EXCLUDED.four_week_avg,
        pct_change = EXCLUDED.pct_change,
        direction = EXCLUDED.direction,
        severity = EXCLUDED.severity,
        evidence = EXCLUDED.evidence;
  v_inserted := v_inserted + 1;

  -- C. Calling Center 7-day reach rate vs prior 4-week reach rate
  SELECT
    CASE
      WHEN count(*) > 0
        THEN round((count(*) FILTER (WHERE a.outcome::text = 'engaged')::numeric / count(*)::numeric) * 100.0, 1)
      ELSE 0
    END
  INTO v_curr_reach
  FROM public.cc_call_attempts a
  WHERE a.void_reason IS NULL
    AND a.outcome IS NOT NULL
    AND coalesce(a.recorded_at, a.created_at) >= v_curr_start
    AND coalesce(a.recorded_at, a.created_at) < v_curr_end;

  SELECT
    CASE
      WHEN count(*) > 0
        THEN round((count(*) FILTER (WHERE a.outcome::text = 'engaged')::numeric / count(*)::numeric) * 100.0, 1)
      ELSE 0
    END
  INTO v_base_reach
  FROM public.cc_call_attempts a
  WHERE a.void_reason IS NULL
    AND a.outcome IS NOT NULL
    AND coalesce(a.recorded_at, a.created_at) >= v_base_start
    AND coalesce(a.recorded_at, a.created_at) < v_base_end;

  v_reach_diff := round(COALESCE(v_curr_reach, 0) - COALESCE(v_base_reach, 0), 1);

  INSERT INTO public.staff_assistant_insights (
    kampala_date,
    metric_key,
    category,
    area_or_scope,
    headline,
    summary,
    current_value,
    four_week_avg,
    pct_change,
    direction,
    severity,
    evidence,
    source_function,
    screen_link,
    requires_finance_gate
  )
  VALUES (
    v_today,
    'calling_center_reach_rate',
    'calling_reach',
    'Calling Center',
    format('Calling Center 7-day reach rate is %s%% vs %s%% 4-week average', v_curr_reach, v_base_reach),
    format(
      'Calling Center answered/engaged reach rate over the last 7 days is %s%% compared with %s%% over the prior 4 weeks (%s percentage points).',
      v_curr_reach,
      v_base_reach,
      v_reach_diff
    ),
    v_curr_reach,
    v_base_reach,
    v_reach_diff,
    CASE WHEN v_reach_diff < 0 THEN 'down' WHEN v_reach_diff > 0 THEN 'up' ELSE 'flat' END,
    CASE WHEN v_reach_diff <= -10 THEN 'high' ELSE 'notable' END,
    jsonb_build_object(
      'current_7d_reach_pct', v_curr_reach,
      'four_week_reach_pct', v_base_reach,
      'pct_point_change', v_reach_diff
    ),
    'cc_weekly_all_calls_report + staff_calling_detailed_report',
    '/me/staff-reports',
    false
  )
  ON CONFLICT (kampala_date, metric_key, area_or_scope) DO UPDATE
    SET headline = EXCLUDED.headline,
        summary = EXCLUDED.summary,
        current_value = EXCLUDED.current_value,
        four_week_avg = EXCLUDED.four_week_avg,
        pct_change = EXCLUDED.pct_change,
        direction = EXCLUDED.direction,
        severity = EXCLUDED.severity,
        evidence = EXCLUDED.evidence;
  v_inserted := v_inserted + 1;

  -- D. Zoe unanswered questions 7-day volume vs 4-week weekly average
  SELECT count(*)::integer
    INTO v_unans_curr
    FROM public.staff_assistant_unanswered u
   WHERE u.created_at >= v_curr_start
     AND u.created_at < v_curr_end;

  SELECT round((count(*)::numeric / 4.0), 1)
    INTO v_unans_base
    FROM public.staff_assistant_unanswered u
   WHERE u.created_at >= v_base_start
     AND u.created_at < v_base_end;

  v_unans_base := GREATEST(COALESCE(v_unans_base, 1), 1);
  v_unans_pct := round(((v_unans_curr::numeric - v_unans_base) / v_unans_base) * 100.0, 1);

  INSERT INTO public.staff_assistant_insights (
    kampala_date,
    metric_key,
    category,
    area_or_scope,
    headline,
    summary,
    current_value,
    four_week_avg,
    pct_change,
    direction,
    severity,
    evidence,
    source_function,
    screen_link,
    requires_finance_gate
  )
  VALUES (
    v_today,
    'zoe_unanswered_questions_weekly',
    'zoe_learning',
    'Zoe Staff Assistant',
    format('Zoe recorded %s unanswered questions in the last 7 days vs %s weekly average', v_unans_curr, v_unans_base),
    format(
      'Staff asked %s unmatched/unanswered questions in the last 7 days compared with a 4-week average of %s per week (%s%%).',
      v_unans_curr,
      v_unans_base,
      v_unans_pct
    ),
    v_unans_curr,
    v_unans_base,
    v_unans_pct,
    CASE WHEN v_unans_pct > 0 THEN 'up' WHEN v_unans_pct < 0 THEN 'down' ELSE 'flat' END,
    'info',
    jsonb_build_object(
      'current_7d_unanswered', v_unans_curr,
      'four_week_weekly_avg', v_unans_base,
      'pct_change', v_unans_pct
    ),
    'staff_assistant_crm_weekly_learning_report',
    '/crm/dashboard',
    false
  )
  ON CONFLICT (kampala_date, metric_key, area_or_scope) DO UPDATE
    SET headline = EXCLUDED.headline,
        summary = EXCLUDED.summary,
        current_value = EXCLUDED.current_value,
        four_week_avg = EXCLUDED.four_week_avg,
        pct_change = EXCLUDED.pct_change,
        direction = EXCLUDED.direction,
        severity = EXCLUDED.severity,
        evidence = EXCLUDED.evidence;
  v_inserted := v_inserted + 1;

  RETURN jsonb_build_object(
    'ok', true,
    'kampala_date', v_today,
    'insights_upserted', v_inserted
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_compute_daily_insights(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_compute_daily_insights(date) TO authenticated, service_role;

-- Schedule daily anomaly computation at 03:00 UTC (06:00 Africa/Kampala) if pg_cron is installed,
-- and run initial calculation now so anomaly notes are immediately populated.
DO $do$
BEGIN
  PERFORM public.staff_assistant_compute_daily_insights(NULL);
EXCEPTION
  WHEN OTHERS THEN
    NULL;
END
$do$;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('zoe-daily-anomaly-insights');
    EXCEPTION
      WHEN OTHERS THEN NULL;
    END;

    PERFORM cron.schedule(
      'zoe-daily-anomaly-insights',
      '0 3 * * *',
      $job$SELECT public.staff_assistant_compute_daily_insights(NULL);$job$
    );
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    NULL;
END
$cron$;

-- =============================================================================
-- 7. IDEAS FOR WELILE RPCs (`staff_assistant_save_idea`,
--    `staff_assistant_list_ideas`, `staff_assistant_update_idea_status`)
--    & MONDAY WEEKLY SUMMARY (`staff_assistant_weekly_focus_summary`)
-- =============================================================================

-- 7a. Click-confirmed Save Idea RPC (`staff_assistant_save_idea`)
--     Requires an unexpired, unused `'idea'` draft in `staff_assistant_drafts`
--     owned by `auth.uid()`. Saves only to `staff_assistant_ideas` (and
--     `audit_logs`). Never turns an idea into an action, never changes business
--     data or settings, and never contacts anyone.
CREATE OR REPLACE FUNCTION public.staff_assistant_save_idea(
  p_title            text,
  p_idea             text,
  p_category         text DEFAULT 'operations',
  p_evidence_summary text DEFAULT '',
  p_evidence_figures jsonb DEFAULT '{}'::jsonb,
  p_source           text DEFAULT '',
  p_period_label     text DEFAULT 'Current period',
  p_screen_link      text DEFAULT '/me/ideas',
  p_conversation_id  uuid DEFAULT NULL,
  p_draft_id         uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid              uuid := (SELECT auth.uid());
  v_title            text := btrim(regexp_replace(COALESCE(p_title, ''), '[\x00-\x1F\x7F]', '', 'g'));
  v_idea             text := btrim(regexp_replace(COALESCE(p_idea, ''), '[\x00-\x1F\x7F]', '', 'g'));
  v_cat              text := lower(btrim(COALESCE(p_category, 'operations')));
  v_evidence_summary text := btrim(regexp_replace(COALESCE(p_evidence_summary, ''), '[\x00-\x1F\x7F]', '', 'g'));
  v_source           text := btrim(regexp_replace(COALESCE(p_source, ''), '[\x00-\x1F\x7F]', '', 'g'));
  v_period           text := COALESCE(NULLIF(btrim(COALESCE(p_period_label, '')), ''), 'Current period');
  v_link             text := COALESCE(NULLIF(btrim(COALESCE(p_screen_link, '')), ''), '/me/ideas');
  v_author_name      text;
  v_author_email     text;
  v_author_roles     text[];
  v_row              public.staff_assistant_ideas;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;

  IF char_length(v_title) < 3 OR char_length(v_title) > 200 THEN
    RAISE EXCEPTION 'Idea title must be between 3 and 200 characters.' USING ERRCODE = '22023';
  END IF;

  IF char_length(v_idea) < 10 OR char_length(v_idea) > 2000 THEN
    RAISE EXCEPTION 'Idea description must be between 10 and 2,000 characters.' USING ERRCODE = '22023';
  END IF;

  IF char_length(v_evidence_summary) < 3 OR char_length(v_evidence_summary) > 1500 THEN
    RAISE EXCEPTION 'Idea evidence summary is required (between 3 and 1,500 characters).' USING ERRCODE = '22023';
  END IF;

  IF char_length(v_source) < 2 OR char_length(v_source) > 300 THEN
    RAISE EXCEPTION 'Official source name is required when saving an idea.' USING ERRCODE = '22023';
  END IF;

  IF v_cat NOT IN ('operations', 'collections', 'desk_waiting', 'calling_reach', 'payout_delays', 'zoe_learning', 'finance') THEN
    v_cat := 'operations';
  END IF;

  IF NOT public.staff_assistant_is_valid_link_path(v_link) THEN
    v_link := '/me/ideas';
  END IF;

  -- Consume server-stored draft (enforces owner, 30-min expiry, single use, and matching canonical payload hash)
  PERFORM public.staff_assistant_consume_draft(
    p_draft_id,
    'idea',
    jsonb_build_object(
      'kind', 'idea',
      'title', v_title,
      'idea', v_idea,
      'category', v_cat,
      'evidence_summary', v_evidence_summary,
      'source', v_source,
      'period_label', v_period
    )
  );

  -- Read author identity strictly from `public.profiles` and `public.user_roles`
  SELECT
    COALESCE(NULLIF(btrim(p.full_name), ''), 'Welile Staff'),
    COALESCE(lower(public.assistant_real_email(btrim(p.email))), 'staff@welile.com')
  INTO v_author_name, v_author_email
  FROM public.profiles p
  WHERE p.id = v_uid;

  SELECT COALESCE(
    array_agg(DISTINCT lower(ur.role::text) ORDER BY lower(ur.role::text))
      FILTER (WHERE ur.enabled IS TRUE),
    ARRAY[]::text[]
  )
  INTO v_author_roles
  FROM public.user_roles ur
  WHERE ur.user_id = v_uid
    AND ur.enabled IS TRUE;

  INSERT INTO public.staff_assistant_ideas (
    created_by,
    author_name,
    author_email,
    author_roles,
    conversation_id,
    draft_id,
    title,
    idea,
    category,
    evidence_summary,
    evidence_figures,
    source,
    period_label,
    screen_link,
    status
  )
  VALUES (
    v_uid,
    COALESCE(v_author_name, 'Welile Staff'),
    COALESCE(v_author_email, 'staff@welile.com'),
    COALESCE(v_author_roles, ARRAY[]::text[]),
    p_conversation_id,
    p_draft_id,
    v_title,
    v_idea,
    v_cat,
    v_evidence_summary,
    COALESCE(p_evidence_figures, '{}'::jsonb),
    v_source,
    v_period,
    v_link,
    'new'
  )
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (
    user_id,
    action_type,
    table_name,
    record_id,
    metadata
  )
  VALUES (
    v_uid,
    'staff_assistant_idea_saved',
    'staff_assistant_ideas',
    v_row.id::text,
    jsonb_build_object(
      'title', v_row.title,
      'category', v_row.category,
      'source', v_row.source,
      'draft_id', p_draft_id,
      'conversation_id', p_conversation_id
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idea', jsonb_build_object(
      'id', v_row.id,
      'title', v_row.title,
      'idea', v_row.idea,
      'category', v_row.category,
      'evidence_summary', v_row.evidence_summary,
      'evidence_figures', v_row.evidence_figures,
      'source', v_row.source,
      'period_label', v_row.period_label,
      'screen_link', v_row.screen_link,
      'author_name', v_row.author_name,
      'author_roles', v_row.author_roles,
      'status', v_row.status,
      'created_at', v_row.created_at
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_save_idea(text, text, text, text, jsonb, text, text, text, uuid, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_save_idea(text, text, text, text, jsonb, text, text, text, uuid, uuid) TO authenticated;

-- 7b. List Saved Ideas (`staff_assistant_list_ideas`)
--     Managers, the COO, and the CEO see all ideas; other staff see their own.
CREATE OR REPLACE FUNCTION public.staff_assistant_list_ideas(
  p_status text DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_can_manage boolean;
  v_status text := NULLIF(lower(btrim(COALESCE(p_status, ''))), '');
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);
  v_counts jsonb := '{}'::jsonb;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;

  v_can_manage := public.staff_assistant_can_manage_ideas();

  SELECT jsonb_build_object(
    'total', count(*)::integer,
    'new', count(*) FILTER (WHERE i.status = 'new')::integer,
    'being_looked_at', count(*) FILTER (WHERE i.status = 'being_looked_at')::integer,
    'done', count(*) FILTER (WHERE i.status = 'done')::integer,
    'not_now', count(*) FILTER (WHERE i.status = 'not_now')::integer
  )
  INTO v_counts
  FROM public.staff_assistant_ideas i
  WHERE (v_can_manage IS TRUE OR i.created_by = v_uid);

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', q.id,
        'created_by', q.created_by,
        'author_name', q.author_name,
        'author_email', q.author_email,
        'author_roles', q.author_roles,
        'title', q.title,
        'idea', q.idea,
        'category', q.category,
        'evidence_summary', q.evidence_summary,
        'evidence_figures', q.evidence_figures,
        'source', q.source,
        'period_label', q.period_label,
        'screen_link', q.screen_link,
        'status', q.status,
        'status_note', q.status_note,
        'status_updated_by_name', q.status_updated_by_name,
        'status_updated_at', q.status_updated_at,
        'created_at', q.created_at,
        'updated_at', q.updated_at
      )
      ORDER BY q.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM (
    SELECT *
      FROM public.staff_assistant_ideas i
     WHERE (v_can_manage IS TRUE OR i.created_by = v_uid)
       AND (v_status IS NULL OR v_status = 'all' OR i.status = v_status)
     ORDER BY i.created_at DESC
     LIMIT v_limit
  ) q;

  RETURN jsonb_build_object(
    'can_manage_status', v_can_manage,
    'counts', COALESCE(v_counts, '{}'::jsonb),
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_list_ideas(text, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_list_ideas(text, integer) TO authenticated;

-- 7c. Update Idea Status (`staff_assistant_update_idea_status`)
--     Ordinary screen action on `/me/ideas`, restricted to managers, the COO,
--     and the CEO (`staff_assistant_can_manage_ideas()`). Never exposed as a Zoe tool.
CREATE OR REPLACE FUNCTION public.staff_assistant_update_idea_status(
  p_idea_id     uuid,
  p_status      text,
  p_status_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid        uuid := (SELECT auth.uid());
  v_status     text := lower(btrim(COALESCE(p_status, '')));
  v_note       text := NULLIF(btrim(regexp_replace(COALESCE(p_status_note, ''), '[\x00-\x1F\x7F]', '', 'g')), '');
  v_actor_name text;
  v_prev_status text;
  v_row        public.staff_assistant_ideas;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_can_manage_ideas() THEN
    RAISE EXCEPTION 'Only managers, the COO, or the CEO can change the status of a saved idea.'
      USING ERRCODE = '42501';
  END IF;

  IF p_idea_id IS NULL THEN
    RAISE EXCEPTION 'idea_id is required.' USING ERRCODE = '22023';
  END IF;

  IF v_status NOT IN ('new', 'being_looked_at', 'done', 'not_now') THEN
    RAISE EXCEPTION 'Invalid idea status (%). Allowed values: new, being_looked_at, done, not_now.', v_status
      USING ERRCODE = '22023';
  END IF;

  IF v_note IS NOT NULL AND char_length(v_note) > 600 THEN
    RAISE EXCEPTION 'Status note must be at most 600 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), 'Welile Manager')
    INTO v_actor_name
    FROM public.profiles p
   WHERE p.id = v_uid;

  SELECT i.status
    INTO v_prev_status
    FROM public.staff_assistant_ideas i
   WHERE i.id = p_idea_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Saved idea not found.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.staff_assistant_ideas i
     SET status = v_status,
         status_note = COALESCE(v_note, i.status_note),
         status_updated_by = v_uid,
         status_updated_by_name = v_actor_name,
         status_updated_at = now(),
         updated_at = now()
   WHERE i.id = p_idea_id
   RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (
    user_id,
    action_type,
    table_name,
    record_id,
    metadata
  )
  VALUES (
    v_uid,
    'staff_assistant_idea_status_updated',
    'staff_assistant_ideas',
    v_row.id::text,
    jsonb_build_object(
      'previous_status', v_prev_status,
      'new_status', v_row.status,
      'status_note', v_row.status_note,
      'updated_by_name', v_actor_name
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idea', jsonb_build_object(
      'id', v_row.id,
      'title', v_row.title,
      'status', v_row.status,
      'status_note', v_row.status_note,
      'status_updated_by_name', v_row.status_updated_by_name,
      'status_updated_at', v_row.status_updated_at
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_update_idea_status(uuid, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_update_idea_status(uuid, text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 8. Monday "What to look at this week" Summary Card RPC
--    (`public.staff_assistant_weekly_focus_summary`, Prompt 4 item 4)
--    STABLE, SECURITY DEFINER, gated to managers, the COO, and the CEO.
--    Returns the top 5 issues with evidence, figures, official sources, and
--    internal links to the screens. Never sent outside the app.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_weekly_focus_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_week_start date := date_trunc('week', (now() AT TIME ZONE 'Africa/Kampala'))::date;
  v_is_monday boolean := (extract(isodow FROM (now() AT TIME ZONE 'Africa/Kampala'))::int = 1);
  v_can_finance boolean;
  v_open_desk_cnt integer := 0;
  v_top_desk text := 'tenant_ops_approved';
  v_top_desk_cnt integer := 0;
  v_uncovered_cnt integer := 0;
  v_awaiting_landlord_cnt integer := 0;
  v_reach_pct numeric := 0;
  v_total_calls_7d integer := 0;
  v_answered_calls_7d integer := 0;
  v_unans_cnt integer := 0;
  v_new_ideas_cnt integer := 0;
  v_top_area_headline text;
  v_top_area_summary text;
  v_top_area_source text;
  v_issues jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_can_manage_ideas() THEN
    RAISE EXCEPTION 'Not authorized for the weekly leadership focus summary.'
      USING ERRCODE = '42501';
  END IF;

  v_can_finance := public.can_view_finance_reports(v_uid);

  -- Issue 1: Desk bottlenecks (`rent_requests` / `rent_request_timing`)
  SELECT
    count(*)::integer
  INTO v_open_desk_cnt
  FROM public.rent_requests rr
  WHERE rr.status IN (
    'service_center_review',
    'pending',
    'agent_ops_approved',
    'agent_verified',
    'tenant_ops_approved',
    'landlord_ops_approved',
    'partner_ops_approved',
    'coo_approved'
  );

  SELECT
    rr.status::text,
    count(*)::integer
  INTO v_top_desk, v_top_desk_cnt
  FROM public.rent_requests rr
  WHERE rr.status IN (
    'service_center_review',
    'pending',
    'agent_ops_approved',
    'agent_verified',
    'tenant_ops_approved',
    'landlord_ops_approved',
    'partner_ops_approved',
    'coo_approved'
  )
  GROUP BY rr.status::text
  ORDER BY count(*) DESC, rr.status::text ASC
  LIMIT 1;

  -- Issue 2: Collection / Area anomaly note from `staff_assistant_insights`
  SELECT
    si.headline,
    si.summary,
    si.source_function
  INTO v_top_area_headline, v_top_area_summary, v_top_area_source
  FROM public.staff_assistant_insights si
  WHERE si.category = 'collections'
  ORDER BY si.kampala_date DESC, abs(si.pct_change) DESC
  LIMIT 1;

  -- Issue 3: Landlord payout delays (`tops_landlord_not_paid_summary_amclock`)
  BEGIN
    SELECT
      coalesce(s.tenant_paying_no_landlord, 0)::integer,
      coalesce(s.awaiting_landlord, 0)::integer
    INTO v_uncovered_cnt, v_awaiting_landlord_cnt
    FROM public.tops_landlord_not_paid_summary_amclock() s
    LIMIT 1;
  EXCEPTION
    WHEN OTHERS THEN
      v_uncovered_cnt := 0;
      v_awaiting_landlord_cnt := 0;
  END;

  -- Issue 4: Calling Center reach rate over the last 7 days
  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE a.outcome::text = 'engaged')::integer
  INTO v_total_calls_7d, v_answered_calls_7d
  FROM public.cc_call_attempts a
  WHERE a.void_reason IS NULL
    AND a.outcome IS NOT NULL
    AND coalesce(a.recorded_at, a.created_at) >= ((v_today - 6)::timestamp AT TIME ZONE 'Africa/Kampala');

  IF v_total_calls_7d > 0 THEN
    v_reach_pct := round((v_answered_calls_7d::numeric / v_total_calls_7d::numeric) * 100.0, 1);
  END IF;

  -- Issue 5: Saved Ideas & Zoe unanswered questions waiting for review
  SELECT count(*)::integer
    INTO v_new_ideas_cnt
    FROM public.staff_assistant_ideas i
   WHERE i.status IN ('new', 'being_looked_at');

  SELECT count(*)::integer
    INTO v_unans_cnt
    FROM public.staff_assistant_unanswered u
   WHERE u.status = 'open'
     AND u.created_at >= ((v_today - 6)::timestamp AT TIME ZONE 'Africa/Kampala');

  v_issues := jsonb_build_array(
    jsonb_build_object(
      'rank', 1,
      'category', 'desk_waiting',
      'title', format('Rent Plan approval queue (%s open applications)', coalesce(v_open_desk_cnt, 0)),
      'evidence', format(
        '%s applications are waiting across approval desks; highest stage queue is %s with %s applications.',
        coalesce(v_open_desk_cnt, 0),
        coalesce(v_top_desk, 'none'),
        coalesce(v_top_desk_cnt, 0)
      ),
      'metric_value', coalesce(v_open_desk_cnt, 0),
      'source', 'rent_request_timing + tenant_ops_rent_request_lifetime',
      'screen_link', '/tenant-ops/workspace',
      'screen_label', 'Open Tenant Ops Workspace'
    ),
    jsonb_build_object(
      'rank', 2,
      'category', 'collections',
      'title', coalesce(v_top_area_headline, 'Weekly collection & field coverage trend'),
      'evidence', coalesce(
        v_top_area_summary,
        'Review district-by-district weekly listing and collection coverage trends against the 4-week baseline.'
      ),
      'metric_value', 4,
      'source', coalesce(v_top_area_source, 'get_tenant_ops_weekly_performance_amclock + agent_ops_metrics_locations'),
      'screen_link', '/executive-hub?tab=agent-ops',
      'screen_label', 'Open Agent Ops Metrics'
    ),
    jsonb_build_object(
      'rank', 3,
      'category', 'payout_delays',
      'title', format('Landlord payout follow-up (%s awaiting landlord)', coalesce(v_awaiting_landlord_cnt, 0)),
      'evidence', format(
        '%s funded Rent Plans have tenants paying with no landlord linked and %s are awaiting landlord payout completion.',
        coalesce(v_uncovered_cnt, 0),
        coalesce(v_awaiting_landlord_cnt, 0)
      ),
      'metric_value', coalesce(v_awaiting_landlord_cnt, 0) + coalesce(v_uncovered_cnt, 0),
      'source', 'tops_landlord_not_paid_summary_amclock + am_uncovered_plans',
      'screen_link', CASE WHEN v_can_finance THEN '/financial-ops' ELSE '/landlord-ops' END,
      'screen_label', CASE WHEN v_can_finance THEN 'Open Financial Ops' ELSE 'Open Landlord Ops' END
    ),
    jsonb_build_object(
      'rank', 4,
      'category', 'calling_reach',
      'title', format('Calling Center 7-day reach rate (%s%%)', coalesce(v_reach_pct, 0)),
      'evidence', format(
        '%s of %s logged Calling Center attempts reached and engaged the callee over the last 7 Kampala days.',
        coalesce(v_answered_calls_7d, 0),
        coalesce(v_total_calls_7d, 0)
      ),
      'metric_value', coalesce(v_reach_pct, 0),
      'source', 'cc_weekly_all_calls_report + staff_calling_detailed_report',
      'screen_link', '/me/staff-reports',
      'screen_label', 'Open Calling Reports'
    ),
    jsonb_build_object(
      'rank', 5,
      'category', 'zoe_learning',
      'title', format('Saved Ideas (%s active) & unanswered Zoe questions (%s this week)', coalesce(v_new_ideas_cnt, 0), coalesce(v_unans_cnt, 0)),
      'evidence', format(
        '%s staff improvement ideas are new or being looked at, and %s unanswered Zoe questions were logged in the last 7 days.',
        coalesce(v_new_ideas_cnt, 0),
        coalesce(v_unans_cnt, 0)
      ),
      'metric_value', coalesce(v_new_ideas_cnt, 0),
      'source', 'staff_assistant_ideas + staff_assistant_crm_weekly_learning_report',
      'screen_link', '/me/ideas',
      'screen_label', 'Review Saved Ideas'
    )
  );

  RETURN jsonb_build_object(
    'available', true,
    'headline', 'What to look at this week',
    'week_start', v_week_start,
    'as_of', v_today,
    'is_monday', v_is_monday,
    'delivery_policy', 'in_app_only_never_sent_outside',
    'source', 'staff_assistant_weekly_focus_summary (In-App Leadership Focus)',
    'issues_count', jsonb_array_length(v_issues),
    'issues', v_issues
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_weekly_focus_summary() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_weekly_focus_summary() TO authenticated;

COMMIT;
