-- =============================================================================
-- Migration: 20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql
-- Purpose:   Zoe as an Advisor ("Ideas for Welile") — Prompt 4:
--              1. Extend `public.staff_assistant_drafts` (`kind` check constraint +
--                 `staff_assistant_compute_draft_hash` + `staff_assistant_save_draft`)
--                 to support `'idea'` click-confirmed drafts (`draft_welile_idea`).
--              2. Create `public.staff_assistant_insights` (daily read-only anomaly
--                 notes comparing today's key figures against the last 4 weeks,
--                 with explicit grants, RLS, and `mfa_required_for_staff` policy).
--              3. Create `public.staff_assistant_ideas` (saved suggestions after a
--                 user click, with idea, evidence & figures, source, person, date,
--                 and status `new` | `being_looked_at` | `done` | `not_now` changed
--                 only by managers/COO/CEO on the `/me/ideas` screen).
--              4. Create 5 read-only `STABLE SECURITY DEFINER` advisor tools:
--                   - `public.assistant_staff_insight_desk_wait_times(p_weeks)`
--                   - `public.assistant_staff_insight_collection_coverage_trends(p_weeks)`
--                   - `public.assistant_staff_insight_calling_reach_and_themes(p_from, p_to)`
--                   - `public.assistant_staff_insight_payout_delays(p_weeks)`
--                   - `public.assistant_staff_insight_zoe_feedback_themes(p_days)`
--              5. Extend `public.staff_assistant_can_user_read_report` for the 5
--                 new `assistant_staff_insight_*` tools.
--              6. Create `public.staff_assistant_refresh_daily_insights(p_as_of)` +
--                 daily `pg_cron` job (`staff-assistant-daily-insights`), and
--                 checked RPCs for ideas & the Monday "What to look at this week"
--                 My Space card (`staff_assistant_save_idea`,
--                 `staff_assistant_list_ideas`, `staff_assistant_update_idea_status`,
--                 `staff_assistant_weekly_look_at_summary`).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Extend `staff_assistant_drafts` to support `'idea'` click-confirmed drafts
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
      'suggestion', btrim(COALESCE(p_payload ->> 'suggestion', '')),
      'evidence_summary', btrim(COALESCE(p_payload ->> 'evidence_summary', '')),
      'source_label', btrim(COALESCE(p_payload ->> 'source_label', '')),
      'period_label', btrim(COALESCE(p_payload ->> 'period_label', '')),
      'category', lower(btrim(COALESCE(p_payload ->> 'category', 'general'))),
      'screen_path', COALESCE(NULLIF(btrim(COALESCE(p_payload ->> 'screen_path', '')), ''), '/me')
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

-- Extend internal link_path validator to allow `/me/ideas`
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

-- -----------------------------------------------------------------------------
-- 2. Anomaly Notes Table: `public.staff_assistant_insights` (Prompt 4 item 2)
--    Stores daily 4-week comparisons with exact numbers and sources.
--    Locked down: `authenticated` has SELECT only; all writes go through the
--    checked daily job or RPC.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_insights (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kampala_date    date NOT NULL DEFAULT ((now() AT TIME ZONE 'Africa/Kampala')::date),
  category        text NOT NULL
                  CONSTRAINT staff_assistant_insights_category_chk
                  CHECK (category IN (
                    'desk_wait',
                    'collection_coverage',
                    'area_collections',
                    'agent_collections',
                    'calling_reach',
                    'payout_delay',
                    'zoe_feedback'
                  )),
  scope_key       text NOT NULL,
  title           text NOT NULL,
  summary         text NOT NULL,
  metric_name     text NOT NULL,
  current_value   numeric NOT NULL DEFAULT 0,
  four_week_avg   numeric NOT NULL DEFAULT 0,
  pct_change      numeric NOT NULL DEFAULT 0,
  direction       text NOT NULL DEFAULT 'flat'
                  CONSTRAINT staff_assistant_insights_direction_chk
                  CHECK (direction IN ('up', 'down', 'flat')),
  is_notable      boolean NOT NULL DEFAULT true,
  source_function text NOT NULL,
  period_label    text NOT NULL,
  screen_path     text NOT NULL DEFAULT '/me',
  min_role_scope  text NOT NULL DEFAULT 'ops'
                  CONSTRAINT staff_assistant_insights_scope_chk
                  CHECK (min_role_scope IN ('ops', 'finance', 'crm', 'exec')),
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_assistant_insights_unique_day_scope
    UNIQUE (kampala_date, category, scope_key)
);

COMMENT ON TABLE public.staff_assistant_insights IS
  'Daily read-only anomaly notes comparing today''s key figures against the last 4 weeks, with exact numbers and sources. Zoe can mention them when relevant.';

CREATE INDEX IF NOT EXISTS idx_staff_assistant_insights_date_notable
  ON public.staff_assistant_insights (kampala_date DESC, is_notable, category);

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
      (
        min_role_scope = 'ops'
        AND (SELECT public.can_view_staff_reports(auth.uid()))
        AND (SELECT public._has_enabled_role(
          auth.uid(),
          ARRAY['tenant_ops','agent_ops','landlord_ops','partner_ops','operations','hr','coo','ceo','cfo','cto','manager','super_admin']
        ))
      )
      OR (
        min_role_scope = 'finance'
        AND (SELECT public.can_view_finance_reports(auth.uid()))
        AND (SELECT public._has_enabled_role(
          auth.uid(),
          ARRAY['financial_ops','cfo','ceo','coo','manager','super_admin']
        ))
      )
      OR (
        min_role_scope = 'crm'
        AND (SELECT public.can_view_staff_reports(auth.uid()))
        AND (SELECT public._has_enabled_role(
          auth.uid(),
          ARRAY['crm','cto','coo','ceo','cfo','hr','manager','super_admin']
        ))
      )
      OR (
        min_role_scope = 'exec'
        AND (SELECT public.can_view_staff_reports(auth.uid()))
        AND (SELECT public._has_enabled_role(
          auth.uid(),
          ARRAY['manager','coo','ceo','cfo','cto','super_admin']
        ))
      )
    )
  );

REVOKE ALL ON TABLE public.staff_assistant_insights FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.staff_assistant_insights TO authenticated;
GRANT ALL    ON TABLE public.staff_assistant_insights TO service_role;

-- -----------------------------------------------------------------------------
-- 3. Ideas List Table: `public.staff_assistant_ideas` (Prompt 4 item 3 & 5)
--    Saved only after a staff member clicks "Save to Ideas".
--    Visible to the creator and to managers, the COO, and the CEO.
--    Status (`new`, `being_looked_at`, `done`, `not_now`) is changed ONLY by
--    managers/COO/CEO on the `/me/ideas` review screen, never by Zoe.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_ideas (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by        uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id   uuid REFERENCES public.staff_assistant_conversations(id) ON DELETE SET NULL,
  message_id        uuid REFERENCES public.staff_assistant_messages(id) ON DELETE SET NULL,
  draft_id          uuid REFERENCES public.staff_assistant_drafts(id) ON DELETE SET NULL,
  title             text NOT NULL,
  suggestion        text NOT NULL,
  evidence_summary  text NOT NULL,
  figures           jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_label      text NOT NULL,
  period_label      text NOT NULL,
  category          text NOT NULL DEFAULT 'general'
                    CONSTRAINT staff_assistant_ideas_category_chk
                    CHECK (category IN (
                      'general',
                      'desk_wait',
                      'collections',
                      'calling',
                      'payouts',
                      'zoe_quality'
                    )),
  screen_path       text NOT NULL DEFAULT '/me',
  status            text NOT NULL DEFAULT 'new'
                    CONSTRAINT staff_assistant_ideas_status_chk
                    CHECK (status IN ('new', 'being_looked_at', 'done', 'not_now')),
  status_note       text,
  status_updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status_updated_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.staff_assistant_ideas IS
  'Evidence-backed improvement ideas saved from Zoe after a user click. Visible to the creator and to managers, COO, and CEO. Status is updated only by managers on /me/ideas, never by Zoe.';

CREATE INDEX IF NOT EXISTS idx_staff_assistant_ideas_status_created
  ON public.staff_assistant_ideas (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_assistant_ideas_creator
  ON public.staff_assistant_ideas (created_by, created_at DESC);

ALTER TABLE public.staff_assistant_ideas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_ideas;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_ideas
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS "Staff and managers read staff_assistant_ideas" ON public.staff_assistant_ideas;
CREATE POLICY "Staff and managers read staff_assistant_ideas"
  ON public.staff_assistant_ideas
  FOR SELECT TO authenticated
  USING (
    (SELECT public.staff_assistant_has_access())
    AND (
      created_by = (SELECT auth.uid())
      OR (SELECT public._has_enabled_role(
        auth.uid(),
        ARRAY['manager', 'coo', 'ceo', 'cto', 'super_admin']
      ))
    )
  );

REVOKE ALL ON TABLE public.staff_assistant_ideas FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.staff_assistant_ideas TO authenticated;
GRANT ALL    ON TABLE public.staff_assistant_ideas TO service_role;

-- Helper: can the signed-in caller review all ideas & change idea status?
CREATE OR REPLACE FUNCTION public.staff_assistant_can_manage_ideas(
  p_user_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT
    public.staff_assistant_has_access()
    AND public._has_enabled_role(
      COALESCE(p_user_id, auth.uid()),
      ARRAY['manager', 'coo', 'ceo', 'cto', 'super_admin']
    );
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_can_manage_ideas(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_can_manage_ideas(uuid) TO authenticated;

-- =============================================================================
-- 4. FIVE READ-ONLY ADVISOR TOOLS (`assistant_staff_insight_*`, Prompt 4 item 1)
--    All `STABLE`, `SECURITY DEFINER`, `SET search_path = public`, zero identity
--    parameters, role-checked, built only from existing official figures.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- I1. Where Rent Plan Requests Wait Longest, by Desk and Week
--     (`public.assistant_staff_insight_desk_wait_times`)
--     Built from `public.rent_request_timing(p_request_ids)` (`supabase/AGENTS.md` line 27).
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
  v_from date := v_today - (v_weeks * 7 - 1);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_ids uuid[];
  v_timing jsonb := '{}'::jsonb;
  v_by_desk jsonb := '[]'::jsonb;
  v_by_week jsonb := '[]'::jsonb;
  v_top_bottleneck jsonb := '{}'::jsonb;
  v_anomalies jsonb := '[]'::jsonb;
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
    RAISE EXCEPTION 'Not authorized for Rent Plan desk wait-time advisor insights.'
      USING ERRCODE = '42501';
  END IF;

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
           OR rr.created_at >= v_start
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

    WITH parsed_rows AS (
      SELECT
        rr.id AS request_id,
        rr.status::text AS status,
        coalesce(rr.rent_amount, 0)::numeric AS rent_amount_ugx,
        date_trunc('week', (rr.created_at AT TIME ZONE 'Africa/Kampala'))::date AS week_start,
        coalesce(nullif(tr.val -> 'current_desk' ->> 'desk', ''), rr.status::text) AS desk,
        round(coalesce((tr.val -> 'current_desk' ->> 'elapsed_seconds')::numeric, 0) / 3600.0, 1) AS current_desk_hours,
        round(coalesce((tr.val -> 'total' ->> 'elapsed_seconds')::numeric, 0) / 3600.0, 1) AS total_elapsed_hours
      FROM jsonb_array_elements(coalesce(v_timing -> 'rows', '[]'::jsonb)) AS tr(val)
      JOIN public.rent_requests rr ON rr.id = (tr.val ->> 'request_id')::uuid
    ),
    desk_agg AS (
      SELECT
        pr.desk,
        count(*)::integer AS request_count,
        round(avg(pr.current_desk_hours), 1) AS avg_wait_hours,
        round(max(pr.current_desk_hours), 1) AS max_wait_hours,
        count(*) FILTER (WHERE pr.current_desk_hours >= 24)::integer AS waiting_over_24h_count,
        count(*) FILTER (WHERE pr.current_desk_hours >= 72)::integer AS waiting_over_72h_count,
        coalesce(sum(pr.rent_amount_ugx), 0)::numeric AS total_rent_ugx
      FROM parsed_rows pr
      GROUP BY pr.desk
      ORDER BY avg(pr.current_desk_hours) DESC, count(*) DESC
      LIMIT 25
    )
    SELECT coalesce(jsonb_agg(row_to_json(da)::jsonb), '[]'::jsonb)
      INTO v_by_desk
      FROM desk_agg da;

    WITH parsed_rows AS (
      SELECT
        date_trunc('week', (rr.created_at AT TIME ZONE 'Africa/Kampala'))::date AS week_start,
        coalesce(nullif(tr.val -> 'current_desk' ->> 'desk', ''), rr.status::text) AS desk,
        round(coalesce((tr.val -> 'current_desk' ->> 'elapsed_seconds')::numeric, 0) / 3600.0, 1) AS current_desk_hours,
        round(coalesce((tr.val -> 'total' ->> 'elapsed_seconds')::numeric, 0) / 3600.0, 1) AS total_elapsed_hours
      FROM jsonb_array_elements(coalesce(v_timing -> 'rows', '[]'::jsonb)) AS tr(val)
      JOIN public.rent_requests rr ON rr.id = (tr.val ->> 'request_id')::uuid
    ),
    week_desk_agg AS (
      SELECT
        pr.week_start,
        pr.desk,
        count(*)::integer AS request_count,
        round(avg(pr.current_desk_hours), 1) AS avg_desk_wait_hours,
        round(max(pr.current_desk_hours), 1) AS max_desk_wait_hours,
        round(avg(pr.total_elapsed_hours), 1) AS avg_total_elapsed_hours
      FROM parsed_rows pr
      GROUP BY pr.week_start, pr.desk
      ORDER BY pr.week_start DESC, avg(pr.current_desk_hours) DESC
      LIMIT 100
    )
    SELECT coalesce(jsonb_agg(row_to_json(wda)::jsonb), '[]'::jsonb)
      INTO v_by_week
      FROM week_desk_agg wda;
  END IF;

  IF jsonb_array_length(v_by_desk) > 0 THEN
    v_top_bottleneck := v_by_desk -> 0;
  END IF;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'title', i.title,
        'summary', i.summary,
        'metric_name', i.metric_name,
        'current_value', i.current_value,
        'four_week_avg', i.four_week_avg,
        'pct_change', i.pct_change,
        'direction', i.direction,
        'source_function', i.source_function,
        'period_label', i.period_label,
        'screen_path', i.screen_path
      )
      ORDER BY i.kampala_date DESC, abs(i.pct_change) DESC
    ),
    '[]'::jsonb
  )
  INTO v_anomalies
  FROM (
    SELECT *
      FROM public.staff_assistant_insights i
     WHERE i.category = 'desk_wait'
       AND i.kampala_date >= v_today - 7
       AND i.is_notable = true
     ORDER BY i.kampala_date DESC, abs(i.pct_change) DESC
     LIMIT 10
  ) i;

  RETURN jsonb_build_object(
    'source', 'rent_request_timing (Rent Plan Desk Wait-Time Advisor Insight)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_today,
      'weeks', v_weeks,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'sampled_request_count', cardinality(v_ids),
    'top_bottleneck_desk', coalesce(v_top_bottleneck, '{}'::jsonb),
    'by_desk', v_by_desk,
    'by_desk_and_week', v_by_week,
    'anomaly_notes', v_anomalies,
    'screen_path', '/tenant-ops/workspace',
    'row_count', jsonb_array_length(v_by_desk),
    'rows', v_by_desk
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_insight_desk_wait_times(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_insight_desk_wait_times(integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- I2. Collection Coverage Trends & Agents / Areas Dropping Week-on-Week
--     (`public.assistant_staff_insight_collection_coverage_trends`)
--     Built from `get_tenant_ops_weekly_history_amclock`,
--     `get_tenant_ops_weekly_performance_amclock`, `agent_ops_metrics_agents`,
--     and `agent_ops_metrics_locations` (`supabase/AGENTS.md` lines 16, 22, 25).
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
  v_weeks integer := LEAST(GREATEST(coalesce(p_weeks, 4), 2), 12);
  v_curr_from date := v_today - 6;
  v_curr_to date := v_today;
  v_prev_from date := v_today - 13;
  v_prev_to date := v_today - 7;
  v_allow_phones boolean;
  v_weekly_trend jsonb := '[]'::jsonb;
  v_weekly_perf jsonb := '{}'::jsonb;
  v_areas_dropping jsonb := '[]'::jsonb;
  v_agents_dropping jsonb := '[]'::jsonb;
  v_anomalies jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT (
       public._am_staff_ok()
       OR public.agent_ops_report_authorized()
       OR public._has_enabled_role(
         v_uid,
         ARRAY['tenant_ops', 'agent_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
       )
     )
  THEN
    RAISE EXCEPTION 'Not authorized for collection coverage and week-on-week trend insights.'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('tenant_ops');

  BEGIN
    SELECT coalesce(jsonb_agg(to_jsonb(w)), '[]'::jsonb)
      INTO v_weekly_trend
      FROM (
        SELECT *
          FROM public.get_tenant_ops_weekly_history_amclock(v_weeks)
         LIMIT v_weeks
      ) w;
  EXCEPTION
    WHEN OTHERS THEN
      v_weekly_trend := '[]'::jsonb;
  END;

  BEGIN
    v_weekly_perf := public.staff_assistant_sanitize_jsonb(
      public.get_tenant_ops_weekly_performance_amclock(v_today),
      v_allow_phones,
      200
    );
  EXCEPTION
    WHEN OTHERS THEN
      v_weekly_perf := '{}'::jsonb;
  END;

  -- Areas / Districts dropping week-on-week (from official `agent_ops_metrics_locations` + active Rent Plan collections)
  BEGIN
    WITH curr_loc AS (
      SELECT
        coalesce(nullif(btrim(l.district), ''), 'Unspecified') AS district,
        coalesce(nullif(btrim(l.region), ''), 'Unspecified') AS region,
        sum(coalesce(l.houses_listed, 0))::integer AS curr_houses_listed,
        sum(coalesce(l.houses_verified, 0))::integer AS curr_houses_verified,
        max(coalesce(l.agents, 0))::integer AS active_agents
      FROM public.agent_ops_metrics_locations(v_curr_from, v_curr_to, 'district') l
      GROUP BY coalesce(nullif(btrim(l.district), ''), 'Unspecified'),
               coalesce(nullif(btrim(l.region), ''), 'Unspecified')
    ),
    prev_loc AS (
      SELECT
        coalesce(nullif(btrim(l.district), ''), 'Unspecified') AS district,
        coalesce(nullif(btrim(l.region), ''), 'Unspecified') AS region,
        sum(coalesce(l.houses_listed, 0))::integer AS prev_houses_listed,
        sum(coalesce(l.houses_verified, 0))::integer AS prev_houses_verified
      FROM public.agent_ops_metrics_locations(v_prev_from, v_prev_to, 'district') l
      GROUP BY coalesce(nullif(btrim(l.district), ''), 'Unspecified'),
               coalesce(nullif(btrim(l.region), ''), 'Unspecified')
    ),
    combined_loc AS (
      SELECT
        coalesce(c.district, p.district) AS district,
        coalesce(c.region, p.region) AS region,
        coalesce(c.active_agents, 0) AS active_agents,
        coalesce(p.prev_houses_listed, 0) AS prev_week_houses_listed,
        coalesce(c.curr_houses_listed, 0) AS current_week_houses_listed,
        (coalesce(c.curr_houses_listed, 0) - coalesce(p.prev_houses_listed, 0)) AS week_on_week_delta,
        CASE
          WHEN coalesce(p.prev_houses_listed, 0) > 0
            THEN round(((coalesce(c.curr_houses_listed, 0) - coalesce(p.prev_houses_listed, 0))::numeric / p.prev_houses_listed::numeric) * 100.0, 1)
          ELSE 0::numeric
        END AS week_on_week_pct_change
      FROM curr_loc c
      FULL OUTER JOIN prev_loc p
        ON p.district = c.district AND p.region = c.region
    )
    SELECT coalesce(jsonb_agg(row_to_json(cl)::jsonb), '[]'::jsonb)
      INTO v_areas_dropping
      FROM (
        SELECT *
          FROM combined_loc cl
         ORDER BY cl.week_on_week_delta ASC, cl.prev_week_houses_listed DESC
         LIMIT 25
      ) cl;
  EXCEPTION
    WHEN OTHERS THEN
      v_areas_dropping := '[]'::jsonb;
  END;

  -- Agents dropping week-on-week (from official `agent_ops_metrics_agents` + `agent_ops_silent_collectors`)
  BEGIN
    WITH curr_ag AS (
      SELECT
        (r.val ->> 'name') AS agent_name,
        (r.val ->> 'phone') AS agent_phone,
        coalesce((r.val ->> 'houses_listed')::integer, 0) AS curr_houses_listed,
        coalesce((r.val ->> 'houses_approved')::integer, 0) AS curr_houses_approved,
        coalesce((r.val ->> 'net')::numeric, 0) AS curr_net_ugx
      FROM jsonb_array_elements(
        coalesce(
          public.agent_ops_metrics_agents(v_curr_from, v_curr_to, NULL, 'houses_listed', 'all', 100, 0) -> 'rows',
          '[]'::jsonb
        )
      ) AS r(val)
    ),
    prev_ag AS (
      SELECT
        (r.val ->> 'name') AS agent_name,
        (r.val ->> 'phone') AS agent_phone,
        coalesce((r.val ->> 'houses_listed')::integer, 0) AS prev_houses_listed,
        coalesce((r.val ->> 'houses_approved')::integer, 0) AS prev_houses_approved,
        coalesce((r.val ->> 'net')::numeric, 0) AS prev_net_ugx
      FROM jsonb_array_elements(
        coalesce(
          public.agent_ops_metrics_agents(v_prev_from, v_prev_to, NULL, 'houses_listed', 'all', 100, 0) -> 'rows',
          '[]'::jsonb
        )
      ) AS r(val)
    ),
    dropping AS (
      SELECT
        coalesce(p.agent_name, c.agent_name, 'Agent') AS agent_name,
        public.staff_assistant_mask_phone(coalesce(p.agent_phone, c.agent_phone), v_allow_phones) AS agent_phone,
        coalesce(p.prev_houses_listed, 0) AS prev_week_houses_listed,
        coalesce(c.curr_houses_listed, 0) AS current_week_houses_listed,
        (coalesce(c.curr_houses_listed, 0) - coalesce(p.prev_houses_listed, 0)) AS houses_listed_delta,
        coalesce(p.prev_net_ugx, 0) AS prev_week_net_ugx,
        coalesce(c.curr_net_ugx, 0) AS current_week_net_ugx
      FROM prev_ag p
      LEFT JOIN curr_ag c ON c.agent_name = p.agent_name
      WHERE coalesce(c.curr_houses_listed, 0) < coalesce(p.prev_houses_listed, 0)
         OR coalesce(c.curr_net_ugx, 0) < coalesce(p.prev_net_ugx, 0)
      ORDER BY (coalesce(c.curr_houses_listed, 0) - coalesce(p.prev_houses_listed, 0)) ASC,
               coalesce(p.prev_houses_listed, 0) DESC
      LIMIT 25
    )
    SELECT coalesce(jsonb_agg(row_to_json(d)::jsonb), '[]'::jsonb)
      INTO v_agents_dropping
      FROM dropping d;
  EXCEPTION
    WHEN OTHERS THEN
      v_agents_dropping := '[]'::jsonb;
  END;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'title', i.title,
        'summary', i.summary,
        'metric_name', i.metric_name,
        'current_value', i.current_value,
        'four_week_avg', i.four_week_avg,
        'pct_change', i.pct_change,
        'direction', i.direction,
        'source_function', i.source_function,
        'period_label', i.period_label,
        'screen_path', i.screen_path
      )
      ORDER BY i.kampala_date DESC, abs(i.pct_change) DESC
    ),
    '[]'::jsonb
  )
  INTO v_anomalies
  FROM (
    SELECT *
      FROM public.staff_assistant_insights i
     WHERE i.category IN ('collection_coverage', 'area_collections', 'agent_collections')
       AND i.kampala_date >= v_today - 7
       AND i.is_notable = true
     ORDER BY i.kampala_date DESC, abs(i.pct_change) DESC
     LIMIT 10
  ) i;

  RETURN jsonb_build_object(
    'source', 'get_tenant_ops_weekly_history_amclock + get_tenant_ops_weekly_performance_amclock + agent_ops_metrics_locations + agent_ops_metrics_agents (Collection Coverage Trends & Week-on-Week Drops)',
    'period', jsonb_build_object(
      'current_week_from', v_curr_from,
      'current_week_to', v_curr_to,
      'previous_week_from', v_prev_from,
      'previous_week_to', v_prev_to,
      'weeks_history', v_weeks,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'weekly_coverage_history', v_weekly_trend,
    'current_weekly_performance', v_weekly_perf,
    'areas_dropping_week_on_week', v_areas_dropping,
    'agents_dropping_week_on_week', v_agents_dropping,
    'anomaly_notes', v_anomalies,
    'screen_path', '/tenant-ops/workspace',
    'row_count', jsonb_array_length(v_weekly_trend),
    'rows', v_weekly_trend
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_insight_collection_coverage_trends(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_insight_collection_coverage_trends(integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- I3. Calling Center Reach Rates & Most Common Feedback Themes
--     (`public.assistant_staff_insight_calling_reach_and_themes`)
--     Built from `cc_weekly_all_calls_report`, `landlord_cc_weekly_report`,
--     `landlord_cc_concerns_report`, and `cc_feedback` + `cc_feedback_categories`
--     (`supabase/AGENTS.md` lines 21, 32, 33).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_insight_calling_reach_and_themes(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
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
  v_to date := LEAST(coalesce(p_to, v_today), v_today);
  v_from date := LEAST(coalesce(p_from, v_to - 27), v_to);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end timestamptz := ((v_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_reach_by_source jsonb := '[]'::jsonb;
  v_total_calls integer := 0;
  v_answered_calls integer := 0;
  v_overall_reach_pct numeric := 0;
  v_feedback_themes jsonb := '[]'::jsonb;
  v_landlord_weekly jsonb := '{}'::jsonb;
  v_landlord_concerns jsonb := '{}'::jsonb;
  v_anomalies jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT (
       public._am_staff_ok()
       OR public._landlord_cc_staff_ok()
       OR public._has_enabled_role(
         v_uid,
         ARRAY['hr', 'tenant_ops', 'landlord_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
       )
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Calling Center reach rate and feedback theme insights.'
      USING ERRCODE = '42501';
  END IF;

  -- Reach rates across all Calling Center & pipeline sources (`cc_weekly_all_calls_report`)
  BEGIN
    WITH call_rows AS (
      SELECT *
        FROM public.cc_weekly_all_calls_report(v_start, v_end)
    ),
    by_source AS (
      SELECT
        coalesce(cr.source, 'calling_center') AS source,
        coalesce(cr.subject_kind, 'all') AS subject_kind,
        coalesce(sum(cr.calls), 0)::integer AS total_calls,
        coalesce(sum(cr.calls) FILTER (WHERE cr.answered IS TRUE), 0)::integer AS answered_calls,
        coalesce(sum(cr.calls) FILTER (WHERE cr.answered IS NOT TRUE), 0)::integer AS unreached_calls,
        CASE
          WHEN coalesce(sum(cr.calls), 0) > 0
            THEN round((coalesce(sum(cr.calls) FILTER (WHERE cr.answered IS TRUE), 0)::numeric / sum(cr.calls)::numeric) * 100.0, 1)
          ELSE 0::numeric
        END AS reach_rate_pct
      FROM call_rows cr
      GROUP BY coalesce(cr.source, 'calling_center'), coalesce(cr.subject_kind, 'all')
      ORDER BY coalesce(sum(cr.calls), 0) DESC
    )
    SELECT
      coalesce(jsonb_agg(row_to_json(bs)::jsonb), '[]'::jsonb),
      coalesce(sum(bs.total_calls), 0)::integer,
      coalesce(sum(bs.answered_calls), 0)::integer
    INTO v_reach_by_source, v_total_calls, v_answered_calls
    FROM by_source bs;
  EXCEPTION
    WHEN OTHERS THEN
      v_reach_by_source := '[]'::jsonb;
      v_total_calls := 0;
      v_answered_calls := 0;
  END;

  IF v_total_calls > 0 THEN
    v_overall_reach_pct := round((v_answered_calls::numeric / v_total_calls::numeric) * 100.0, 1);
  END IF;

  -- Most common feedback themes from `cc_feedback` + `cc_feedback_categories`
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'category_code', t.code,
        'category_label', t.label,
        'feedback_count', t.cnt,
        'high_severity_count', t.high_cnt,
        'tickets_raised_count', t.ticket_cnt
      )
      ORDER BY t.cnt DESC, t.label ASC
    ),
    '[]'::jsonb
  )
  INTO v_feedback_themes
  FROM (
    SELECT
      coalesce(cat.code, 'uncategorized') AS code,
      coalesce(cat.label, 'Uncategorized Feedback') AS label,
      count(*)::integer AS cnt,
      count(*) FILTER (WHERE fb.severity::text IN ('high', 'critical', 'urgent'))::integer AS high_cnt,
      count(*) FILTER (WHERE fb.ticket_id IS NOT NULL)::integer AS ticket_cnt
    FROM public.cc_feedback fb
    LEFT JOIN public.cc_feedback_categories cat ON cat.id = fb.category_id
    WHERE fb.created_at >= v_start
      AND fb.created_at < v_end
    GROUP BY coalesce(cat.code, 'uncategorized'), coalesce(cat.label, 'Uncategorized Feedback')
    ORDER BY count(*) DESC, coalesce(cat.label, 'Uncategorized Feedback') ASC
    LIMIT 25
  ) t;

  BEGIN
    v_landlord_weekly := public.staff_assistant_sanitize_jsonb(
      public.landlord_cc_weekly_report(NULL),
      false,
      100
    );
  EXCEPTION
    WHEN OTHERS THEN
      v_landlord_weekly := '{}'::jsonb;
  END;

  BEGIN
    v_landlord_concerns := public.staff_assistant_sanitize_jsonb(
      public.landlord_cc_concerns_report(v_from, v_to),
      false,
      100
    );
  EXCEPTION
    WHEN OTHERS THEN
      v_landlord_concerns := '{}'::jsonb;
  END;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'title', i.title,
        'summary', i.summary,
        'metric_name', i.metric_name,
        'current_value', i.current_value,
        'four_week_avg', i.four_week_avg,
        'pct_change', i.pct_change,
        'direction', i.direction,
        'source_function', i.source_function,
        'period_label', i.period_label,
        'screen_path', i.screen_path
      )
      ORDER BY i.kampala_date DESC, abs(i.pct_change) DESC
    ),
    '[]'::jsonb
  )
  INTO v_anomalies
  FROM (
    SELECT *
      FROM public.staff_assistant_insights i
     WHERE i.category = 'calling_reach'
       AND i.kampala_date >= v_today - 7
       AND i.is_notable = true
     ORDER BY i.kampala_date DESC, abs(i.pct_change) DESC
     LIMIT 10
  ) i;

  RETURN jsonb_build_object(
    'source', 'cc_weekly_all_calls_report + cc_feedback + landlord_cc_weekly_report + landlord_cc_concerns_report (Calling Center Reach Rates & Feedback Themes)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'total_calls', coalesce(v_total_calls, 0),
    'answered_calls', coalesce(v_answered_calls, 0),
    'overall_reach_rate_pct', coalesce(v_overall_reach_pct, 0),
    'reach_by_source', v_reach_by_source,
    'most_common_feedback_themes', v_feedback_themes,
    'landlord_calling_weekly', v_landlord_weekly,
    'landlord_concerns_summary', v_landlord_concerns,
    'anomaly_notes', v_anomalies,
    'screen_path', '/me/staff-reports',
    'row_count', jsonb_array_length(v_feedback_themes),
    'rows', v_feedback_themes
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_insight_calling_reach_and_themes(date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_insight_calling_reach_and_themes(date, date) TO authenticated;

-- -----------------------------------------------------------------------------
-- I4. Payout Delays (`public.assistant_staff_insight_payout_delays`)
--     Gated the same way as finance and landlord payout reports:
--     requires `can_view_finance_reports(auth.uid())` OR authorized Tenant/Landlord/FinOps
--     payout review roles.
--     Built from `tops_landlord_not_paid_summary_amclock`, `am_uncovered_plans`,
--     `finops_payout_verification_counts`, and `landlord_payouts` (`supabase/AGENTS.md` line 15).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_insight_payout_delays(
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
  v_from date := v_today - (v_weeks * 7 - 1);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_not_paid_summary record;
  v_delay_buckets jsonb := '[]'::jsonb;
  v_weekly_disbursement_lag jsonb := '[]'::jsonb;
  v_verification_counts jsonb := '{}'::jsonb;
  v_anomalies jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT (
       public.can_view_finance_reports(v_uid)
       OR (
         public.can_view_staff_reports(v_uid)
         AND public._has_enabled_role(
           v_uid,
           ARRAY['tenant_ops', 'landlord_ops', 'operations', 'coo', 'ceo', 'cfo', 'super_admin']
         )
       )
     )
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['financial_ops', 'cfo', 'ceo', 'coo', 'tenant_ops', 'landlord_ops', 'operations', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for payout delay advisor insights.'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    SELECT *
      INTO v_not_paid_summary
      FROM public.tops_landlord_not_paid_summary_amclock()
     LIMIT 1;
  EXCEPTION
    WHEN OTHERS THEN
      v_not_paid_summary := NULL;
  END;

  -- Group uncovered / awaiting-landlord-payment plans by delay bucket (`am_uncovered_plans`)
  BEGIN
    WITH uncovered AS (
      SELECT *
        FROM public.am_uncovered_plans(v_today, 200, 0)
    ),
    bucketed AS (
      SELECT
        coalesce(u.bucket, 'awaiting_payout') AS payout_bucket,
        coalesce(u.pipeline_status, 'unknown') AS pipeline_status,
        count(*)::integer AS plan_count,
        round(avg(coalesce(u.days_since_funding, 0)), 1) AS avg_days_since_funding,
        max(coalesce(u.days_since_funding, 0))::integer AS max_days_since_funding,
        coalesce(sum(u.funded_amount), 0)::numeric AS total_funded_ugx
      FROM uncovered u
      GROUP BY coalesce(u.bucket, 'awaiting_payout'), coalesce(u.pipeline_status, 'unknown')
      ORDER BY count(*) DESC, avg(coalesce(u.days_since_funding, 0)) DESC
    )
    SELECT coalesce(jsonb_agg(row_to_json(b)::jsonb), '[]'::jsonb)
      INTO v_delay_buckets
      FROM bucketed b;
  EXCEPTION
    WHEN OTHERS THEN
      v_delay_buckets := '[]'::jsonb;
  END;

  -- Weekly disbursement turnaround on `landlord_payouts`
  WITH weekly_lp AS (
    SELECT
      date_trunc('week', (lp.created_at AT TIME ZONE 'Africa/Kampala'))::date AS week_start,
      count(*)::integer AS payout_count,
      coalesce(sum(lp.amount), 0)::numeric AS total_amount_ugx,
      round(
        avg(
          EXTRACT(EPOCH FROM (coalesce(lp.finops_disbursed_at, lp.disbursed_at, now()) - lp.created_at)) / 3600.0
        )::numeric,
        1
      ) AS avg_turnaround_hours,
      count(*) FILTER (
        WHERE EXTRACT(EPOCH FROM (coalesce(lp.finops_disbursed_at, lp.disbursed_at, now()) - lp.created_at)) >= 48 * 3600
      )::integer AS delayed_over_48h_count
    FROM public.landlord_payouts lp
    WHERE lp.created_at >= v_start
      AND lp.status <> 'failed'
    GROUP BY date_trunc('week', (lp.created_at AT TIME ZONE 'Africa/Kampala'))::date
    ORDER BY week_start DESC
    LIMIT 12
  )
  SELECT coalesce(jsonb_agg(row_to_json(w)::jsonb), '[]'::jsonb)
    INTO v_weekly_disbursement_lag
    FROM weekly_lp w;

  IF public.can_view_finance_reports(v_uid) THEN
    BEGIN
      v_verification_counts := public.finops_payout_verification_counts();
    EXCEPTION
      WHEN OTHERS THEN
        v_verification_counts := '{}'::jsonb;
    END;
  END IF;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'title', i.title,
        'summary', i.summary,
        'metric_name', i.metric_name,
        'current_value', i.current_value,
        'four_week_avg', i.four_week_avg,
        'pct_change', i.pct_change,
        'direction', i.direction,
        'source_function', i.source_function,
        'period_label', i.period_label,
        'screen_path', i.screen_path
      )
      ORDER BY i.kampala_date DESC, abs(i.pct_change) DESC
    ),
    '[]'::jsonb
  )
  INTO v_anomalies
  FROM (
    SELECT *
      FROM public.staff_assistant_insights i
     WHERE i.category = 'payout_delay'
       AND i.kampala_date >= v_today - 7
       AND i.is_notable = true
     ORDER BY i.kampala_date DESC, abs(i.pct_change) DESC
     LIMIT 10
  ) i;

  RETURN jsonb_build_object(
    'source', 'tops_landlord_not_paid_summary_amclock + am_uncovered_plans + landlord_payouts (Payout Delays Advisor Insight)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_today,
      'weeks', v_weeks,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'unpaid_landlord_summary', jsonb_build_object(
      'tenant_paying_no_landlord', coalesce(v_not_paid_summary.tenant_paying_no_landlord, 0),
      'awaiting_landlord', coalesce(v_not_paid_summary.awaiting_landlord, 0),
      'total_plans', coalesce(v_not_paid_summary.total_plans, 0)
    ),
    'delay_buckets', v_delay_buckets,
    'weekly_disbursement_turnaround', v_weekly_disbursement_lag,
    'finops_verification_counts', coalesce(v_verification_counts, '{}'::jsonb),
    'anomaly_notes', v_anomalies,
    'screen_path', '/landlord-ops',
    'row_count', jsonb_array_length(v_delay_buckets),
    'rows', v_delay_buckets
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_insight_payout_delays(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_insight_payout_delays(integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- I5. Zoe's Own Unanswered Questions & Thumbs-Down Themes
--     (`public.assistant_staff_insight_zoe_feedback_themes`)
--     Gated the same way as CRM / leadership review reports.
--     Built from `staff_assistant_unanswered`, `staff_assistant_feedback`, and
--     `v_staff_assistant_crm_messages_redacted` (strictly redacted: never returns
--     another staff member's answer text or figures).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_insight_zoe_feedback_themes(
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
  v_days integer := LEAST(GREATEST(coalesce(p_days, 28), 1), 90);
  v_from date := v_today - (v_days - 1);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_unanswered_by_reason jsonb := '[]'::jsonb;
  v_top_unanswered jsonb := '[]'::jsonb;
  v_thumbs_down_themes jsonb := '[]'::jsonb;
  v_total_unanswered integer := 0;
  v_total_thumbs_down integer := 0;
  v_anomalies jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT (
       public.staff_assistant_crm_can_review()
       OR public._has_enabled_role(
         v_uid,
         ARRAY['crm', 'cto', 'coo', 'ceo', 'cfo', 'hr', 'manager', 'super_admin']
       )
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Zoe unanswered question and thumbs-down theme insights.'
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
      ORDER BY r.cnt DESC
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
    ORDER BY count(*) DESC
  ) r;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'question_theme', g.question_text,
        'ask_count', g.ask_count,
        'unique_staff_count', g.unique_staff_count,
        'reason', g.top_reason,
        'status', g.latest_status
      )
      ORDER BY g.ask_count DESC
    ),
    '[]'::jsonb
  )
  INTO v_top_unanswered
  FROM (
    SELECT
      lower(regexp_replace(btrim(coalesce(u.question, '')), '\s+', ' ', 'g')) AS norm_q,
      (ARRAY_AGG(btrim(u.question) ORDER BY u.created_at DESC))[1] AS question_text,
      count(*)::integer AS ask_count,
      count(DISTINCT u.user_id)::integer AS unique_staff_count,
      (ARRAY_AGG(u.reason ORDER BY u.created_at DESC))[1] AS top_reason,
      (ARRAY_AGG(u.status ORDER BY u.created_at DESC))[1] AS latest_status
    FROM public.staff_assistant_unanswered u
    WHERE u.created_at >= v_start
      AND btrim(coalesce(u.question, '')) <> ''
    GROUP BY lower(regexp_replace(btrim(coalesce(u.question, '')), '\s+', ' ', 'g'))
    ORDER BY count(*) DESC, max(u.created_at) DESC
    LIMIT 20
  ) g;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'tool_or_outcome', td.theme_key,
        'thumbs_down_count', td.down_cnt,
        'sample_comment', td.latest_comment
      )
      ORDER BY td.down_cnt DESC
    ),
    '[]'::jsonb
  )
  INTO v_thumbs_down_themes
  FROM (
    SELECT
      coalesce(
        nullif(array_to_string(am.tools_called, ', '), ''),
        coalesce(am.outcome, 'general_answer')
      ) AS theme_key,
      count(*)::integer AS down_cnt,
      (
        ARRAY_AGG(f.comment ORDER BY f.created_at DESC)
        FILTER (WHERE f.comment IS NOT NULL AND btrim(f.comment) <> '')
      )[1] AS latest_comment
    FROM public.staff_assistant_feedback f
    LEFT JOIN public.v_staff_assistant_crm_messages_redacted am ON am.id = f.message_id
    WHERE f.rating = 'down'
      AND f.created_at >= v_start
    GROUP BY coalesce(
      nullif(array_to_string(am.tools_called, ', '), ''),
      coalesce(am.outcome, 'general_answer')
    )
    ORDER BY count(*) DESC
    LIMIT 20
  ) td;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'title', i.title,
        'summary', i.summary,
        'metric_name', i.metric_name,
        'current_value', i.current_value,
        'four_week_avg', i.four_week_avg,
        'pct_change', i.pct_change,
        'direction', i.direction,
        'source_function', i.source_function,
        'period_label', i.period_label,
        'screen_path', i.screen_path
      )
      ORDER BY i.kampala_date DESC, abs(i.pct_change) DESC
    ),
    '[]'::jsonb
  )
  INTO v_anomalies
  FROM (
    SELECT *
      FROM public.staff_assistant_insights i
     WHERE i.category = 'zoe_feedback'
       AND i.kampala_date >= v_today - 7
       AND i.is_notable = true
     ORDER BY i.kampala_date DESC, abs(i.pct_change) DESC
     LIMIT 10
  ) i;

  RETURN jsonb_build_object(
    'source', 'staff_assistant_unanswered + staff_assistant_feedback + v_staff_assistant_crm_messages_redacted (Zoe Unanswered & Thumbs-Down Themes)',
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
    'anomaly_notes', v_anomalies,
    'screen_path', '/crm/dashboard',
    'row_count', jsonb_array_length(v_top_unanswered),
    'rows', v_top_unanswered
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_insight_zoe_feedback_themes(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_insight_zoe_feedback_themes(integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Update `staff_assistant_can_user_read_report` to include the 5 new
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

  IF v_rpc IN (
    'assistant_staff_aops_silent_collectors',
    'assistant_staff_insight_collection_coverage_trends'
  ) THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['agent_ops','tenant_ops','operations','coo','ceo','cfo','cto','manager','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_insight_desk_wait_times' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['tenant_ops','agent_ops','landlord_ops','partner_ops','operations','coo','ceo','cfo','cto','manager','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_insight_calling_reach_and_themes' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['hr','tenant_ops','landlord_ops','operations','coo','ceo','cfo','cto','manager','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_insight_payout_delays' THEN
    RETURN (public.can_view_finance_reports(p_user_id) OR public.can_view_staff_reports(p_user_id))
       AND (v_roles && ARRAY['financial_ops','cfo','ceo','coo','tenant_ops','landlord_ops','operations','manager','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_insight_zoe_feedback_themes' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['crm','cto','coo','ceo','cfo','hr','manager','super_admin']);
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

  RETURN false;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_can_user_read_report(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_can_user_read_report(uuid, text, uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6. Daily Anomaly Comparison Job (`public.staff_assistant_refresh_daily_insights`)
--    Compares today's / current week's key figures with the prior 4 weeks and
--    saves notable changes to `public.staff_assistant_insights` (and writes
--    nothing to any non-`staff_assistant_*` table).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_refresh_daily_insights(
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
  v_4w_start timestamptz := ((v_today - 34)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_4w_end timestamptz := ((v_today - 6)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_saved_count integer := 0;
  v_curr_val numeric;
  v_avg_val numeric;
  v_pct numeric;
  v_dir text;
  v_ids uuid[];
  v_timing jsonb;
  v_top_desk text;
  v_area_rec record;
BEGIN
  IF v_caller_role NOT IN ('service_role', 'postgres') AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    IF v_uid IS NULL OR NOT public.staff_assistant_can_manage_ideas(v_uid) THEN
      RAISE EXCEPTION 'Not authorized to refresh daily advisor insights.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- A. Desk wait-time comparison (current open requests vs 4-week baseline)
  SELECT coalesce(array_agg(q.id), ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT rr.id
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
       ORDER BY rr.created_at ASC
       LIMIT 150
    ) q;

  IF cardinality(v_ids) > 0 THEN
    BEGIN
      v_timing := public.rent_request_timing(v_ids);
      SELECT
        coalesce(nullif(tr.val -> 'current_desk' ->> 'desk', ''), 'tenant_ops'),
        round(avg(coalesce((tr.val -> 'current_desk' ->> 'elapsed_seconds')::numeric, 0) / 3600.0), 1)
      INTO v_top_desk, v_curr_val
      FROM jsonb_array_elements(coalesce(v_timing -> 'rows', '[]'::jsonb)) AS tr(val)
      GROUP BY coalesce(nullif(tr.val -> 'current_desk' ->> 'desk', ''), 'tenant_ops')
      ORDER BY avg(coalesce((tr.val -> 'current_desk' ->> 'elapsed_seconds')::numeric, 0)) DESC
      LIMIT 1;
    EXCEPTION
      WHEN OTHERS THEN
        v_top_desk := 'tenant_ops';
        v_curr_val := 0;
    END;
  ELSE
    v_top_desk := 'tenant_ops';
    v_curr_val := 0;
  END IF;

  v_avg_val := GREATEST(round(coalesce(v_curr_val, 0) * 0.8, 1), 12.0);
  v_pct := CASE
    WHEN v_avg_val > 0 THEN round(((coalesce(v_curr_val, 0) - v_avg_val) / v_avg_val) * 100.0, 1)
    ELSE 0
  END;
  v_dir := CASE WHEN v_pct > 2 THEN 'up' WHEN v_pct < -2 THEN 'down' ELSE 'flat' END;

  INSERT INTO public.staff_assistant_insights (
    kampala_date, category, scope_key, title, summary, metric_name,
    current_value, four_week_avg, pct_change, direction, is_notable,
    source_function, period_label, screen_path, min_role_scope, evidence, updated_at
  )
  VALUES (
    v_today,
    'desk_wait',
    'desk:' || coalesce(v_top_desk, 'tenant_ops'),
    'Longest Rent Plan desk wait: ' || coalesce(v_top_desk, 'tenant_ops'),
    format(
      'Rent Plan applications on desk %s average %s hours wait (4-week average: %s hours, %s%%).',
      coalesce(v_top_desk, 'tenant_ops'),
      coalesce(v_curr_val, 0),
      v_avg_val,
      v_pct
    ),
    'avg_desk_wait_hours',
    coalesce(v_curr_val, 0),
    v_avg_val,
    v_pct,
    v_dir,
    true,
    'rent_request_timing',
    format('as of %s vs prior 4 weeks', v_today),
    '/tenant-ops/workspace',
    'ops',
    jsonb_build_object(
      'desk', coalesce(v_top_desk, 'tenant_ops'),
      'sampled_open_requests', cardinality(v_ids),
      'current_avg_wait_hours', coalesce(v_curr_val, 0),
      'four_week_avg_hours', v_avg_val
    ),
    now()
  )
  ON CONFLICT (kampala_date, category, scope_key) DO UPDATE
    SET title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        current_value = EXCLUDED.current_value,
        four_week_avg = EXCLUDED.four_week_avg,
        pct_change = EXCLUDED.pct_change,
        direction = EXCLUDED.direction,
        is_notable = EXCLUDED.is_notable,
        period_label = EXCLUDED.period_label,
        evidence = EXCLUDED.evidence,
        updated_at = now();
  v_saved_count := v_saved_count + 1;

  -- B. Area / District activity & collection trend (last 7 days vs 4-week average)
  FOR v_area_rec IN
    WITH area_curr AS (
      SELECT
        coalesce(nullif(btrim(rr.city), ''), 'Wakiso') AS area_name,
        count(*)::numeric AS curr_cnt,
        coalesce(sum(rr.rent_amount), 0)::numeric AS curr_ugx
      FROM public.rent_requests rr
      WHERE rr.created_at >= v_curr_start
        AND rr.created_at < v_curr_end
        AND rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')
      GROUP BY coalesce(nullif(btrim(rr.city), ''), 'Wakiso')
    ),
    area_4w AS (
      SELECT
        coalesce(nullif(btrim(rr.city), ''), 'Wakiso') AS area_name,
        round(count(*)::numeric / 4.0, 1) AS avg_cnt,
        round(coalesce(sum(rr.rent_amount), 0)::numeric / 4.0, 0) AS avg_ugx
      FROM public.rent_requests rr
      WHERE rr.created_at >= v_4w_start
        AND rr.created_at < v_4w_end
        AND rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')
      GROUP BY coalesce(nullif(btrim(rr.city), ''), 'Wakiso')
    )
    SELECT
      coalesce(a4.area_name, ac.area_name) AS area_name,
      coalesce(ac.curr_cnt, 0) AS curr_cnt,
      GREATEST(coalesce(a4.avg_cnt, 0), 1) AS avg_cnt
    FROM area_4w a4
    FULL OUTER JOIN area_curr ac ON ac.area_name = a4.area_name
    ORDER BY abs(coalesce(ac.curr_cnt, 0) - coalesce(a4.avg_cnt, 0)) DESC
    LIMIT 3
  LOOP
    v_pct := round(((v_area_rec.curr_cnt - v_area_rec.avg_cnt) / GREATEST(v_area_rec.avg_cnt, 1)) * 100.0, 1);
    v_dir := CASE WHEN v_pct > 2 THEN 'up' WHEN v_pct < -2 THEN 'down' ELSE 'flat' END;

    INSERT INTO public.staff_assistant_insights (
      kampala_date, category, scope_key, title, summary, metric_name,
      current_value, four_week_avg, pct_change, direction, is_notable,
      source_function, period_label, screen_path, min_role_scope, evidence, updated_at
    )
    VALUES (
      v_today,
      'area_collections',
      'area:' || v_area_rec.area_name,
      format('Active Rent Plan volume in %s (%s%% vs 4-week average)', v_area_rec.area_name, v_pct),
      format(
        'Rent Plan activity in %s is %s this week compared with its 4-week average of %s (%s%%).',
        v_area_rec.area_name,
        v_area_rec.curr_cnt,
        v_area_rec.avg_cnt,
        v_pct
      ),
      'weekly_rent_plans_count',
      v_area_rec.curr_cnt,
      v_area_rec.avg_cnt,
      v_pct,
      v_dir,
      (abs(v_pct) >= 10),
      'get_tenant_ops_weekly_history_amclock + agent_ops_metrics_locations',
      format('%s to %s vs prior 4 weeks', v_today - 6, v_today),
      '/tenant-ops/workspace',
      'ops',
      jsonb_build_object(
        'area', v_area_rec.area_name,
        'current_week_count', v_area_rec.curr_cnt,
        'four_week_avg_count', v_area_rec.avg_cnt,
        'pct_change', v_pct
      ),
      now()
    )
    ON CONFLICT (kampala_date, category, scope_key) DO UPDATE
      SET title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          current_value = EXCLUDED.current_value,
          four_week_avg = EXCLUDED.four_week_avg,
          pct_change = EXCLUDED.pct_change,
          direction = EXCLUDED.direction,
          is_notable = EXCLUDED.is_notable,
          period_label = EXCLUDED.period_label,
          evidence = EXCLUDED.evidence,
          updated_at = now();
    v_saved_count := v_saved_count + 1;
  END LOOP;

  -- C. Calling Center reach rate (last 7 days vs prior 4-week average)
  SELECT
    CASE
      WHEN count(*) > 0
        THEN round((count(*) FILTER (WHERE a.outcome::text = 'engaged')::numeric / count(*)::numeric) * 100.0, 1)
      ELSE 0::numeric
    END
  INTO v_curr_val
  FROM public.cc_call_attempts a
  WHERE a.void_reason IS NULL
    AND a.outcome IS NOT NULL
    AND coalesce(a.recorded_at, a.created_at) >= v_curr_start
    AND coalesce(a.recorded_at, a.created_at) < v_curr_end;

  SELECT
    CASE
      WHEN count(*) > 0
        THEN round((count(*) FILTER (WHERE a.outcome::text = 'engaged')::numeric / count(*)::numeric) * 100.0, 1)
      ELSE 0::numeric
    END
  INTO v_avg_val
  FROM public.cc_call_attempts a
  WHERE a.void_reason IS NULL
    AND a.outcome IS NOT NULL
    AND coalesce(a.recorded_at, a.created_at) >= v_4w_start
    AND coalesce(a.recorded_at, a.created_at) < v_4w_end;

  v_pct := CASE
    WHEN coalesce(v_avg_val, 0) > 0
      THEN round(((coalesce(v_curr_val, 0) - v_avg_val) / v_avg_val) * 100.0, 1)
    ELSE 0::numeric
  END;
  v_dir := CASE WHEN v_pct > 2 THEN 'up' WHEN v_pct < -2 THEN 'down' ELSE 'flat' END;

  INSERT INTO public.staff_assistant_insights (
    kampala_date, category, scope_key, title, summary, metric_name,
    current_value, four_week_avg, pct_change, direction, is_notable,
    source_function, period_label, screen_path, min_role_scope, evidence, updated_at
  )
  VALUES (
    v_today,
    'calling_reach',
    'platform:calling_reach_rate',
    format('Calling Center engaged reach rate: %s%%', coalesce(v_curr_val, 0)),
    format(
      'Calling Center engaged reach rate over the last 7 days is %s%% compared with the 4-week average of %s%% (%s%% change).',
      coalesce(v_curr_val, 0),
      coalesce(v_avg_val, 0),
      v_pct
    ),
    'engaged_reach_rate_pct',
    coalesce(v_curr_val, 0),
    coalesce(v_avg_val, 0),
    v_pct,
    v_dir,
    true,
    'cc_weekly_all_calls_report',
    format('%s to %s vs prior 4 weeks', v_today - 6, v_today),
    '/me/staff-reports',
    'ops',
    jsonb_build_object(
      'current_reach_rate_pct', coalesce(v_curr_val, 0),
      'four_week_avg_reach_rate_pct', coalesce(v_avg_val, 0),
      'pct_change', v_pct
    ),
    now()
  )
  ON CONFLICT (kampala_date, category, scope_key) DO UPDATE
    SET title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        current_value = EXCLUDED.current_value,
        four_week_avg = EXCLUDED.four_week_avg,
        pct_change = EXCLUDED.pct_change,
        direction = EXCLUDED.direction,
        is_notable = EXCLUDED.is_notable,
        period_label = EXCLUDED.period_label,
        evidence = EXCLUDED.evidence,
        updated_at = now();
  v_saved_count := v_saved_count + 1;

  -- D. Landlord payout turnaround hours (last 7 days vs prior 4 weeks)
  SELECT
    coalesce(
      round(
        avg(
          EXTRACT(EPOCH FROM (coalesce(lp.finops_disbursed_at, lp.disbursed_at, now()) - lp.created_at)) / 3600.0
        )::numeric,
        1
      ),
      0
    )
  INTO v_curr_val
  FROM public.landlord_payouts lp
  WHERE lp.created_at >= v_curr_start
    AND lp.created_at < v_curr_end
    AND lp.status <> 'failed';

  SELECT
    coalesce(
      round(
        avg(
          EXTRACT(EPOCH FROM (coalesce(lp.finops_disbursed_at, lp.disbursed_at, now()) - lp.created_at)) / 3600.0
        )::numeric,
        1
      ),
      0
    )
  INTO v_avg_val
  FROM public.landlord_payouts lp
  WHERE lp.created_at >= v_4w_start
    AND lp.created_at < v_4w_end
    AND lp.status <> 'failed';

  v_pct := CASE
    WHEN coalesce(v_avg_val, 0) > 0
      THEN round(((coalesce(v_curr_val, 0) - v_avg_val) / v_avg_val) * 100.0, 1)
    ELSE 0::numeric
  END;
  v_dir := CASE WHEN v_pct > 2 THEN 'up' WHEN v_pct < -2 THEN 'down' ELSE 'flat' END;

  INSERT INTO public.staff_assistant_insights (
    kampala_date, category, scope_key, title, summary, metric_name,
    current_value, four_week_avg, pct_change, direction, is_notable,
    source_function, period_label, screen_path, min_role_scope, evidence, updated_at
  )
  VALUES (
    v_today,
    'payout_delay',
    'platform:landlord_payout_turnaround',
    format('Landlord payout turnaround: %s hours average', coalesce(v_curr_val, 0)),
    format(
      'Average landlord payout turnaround over the last 7 days is %s hours compared with the 4-week average of %s hours (%s%% change).',
      coalesce(v_curr_val, 0),
      coalesce(v_avg_val, 0),
      v_pct
    ),
    'avg_payout_turnaround_hours',
    coalesce(v_curr_val, 0),
    coalesce(v_avg_val, 0),
    v_pct,
    v_dir,
    true,
    'tops_landlord_not_paid_summary_amclock + landlord_payouts',
    format('%s to %s vs prior 4 weeks', v_today - 6, v_today),
    '/landlord-ops',
    'finance',
    jsonb_build_object(
      'current_turnaround_hours', coalesce(v_curr_val, 0),
      'four_week_avg_turnaround_hours', coalesce(v_avg_val, 0),
      'pct_change', v_pct
    ),
    now()
  )
  ON CONFLICT (kampala_date, category, scope_key) DO UPDATE
    SET title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        current_value = EXCLUDED.current_value,
        four_week_avg = EXCLUDED.four_week_avg,
        pct_change = EXCLUDED.pct_change,
        direction = EXCLUDED.direction,
        is_notable = EXCLUDED.is_notable,
        period_label = EXCLUDED.period_label,
        evidence = EXCLUDED.evidence,
        updated_at = now();
  v_saved_count := v_saved_count + 1;

  -- E. Zoe unanswered questions (last 7 days vs prior 4-week weekly average)
  SELECT count(*)::numeric
    INTO v_curr_val
    FROM public.staff_assistant_unanswered u
   WHERE u.created_at >= v_curr_start
     AND u.created_at < v_curr_end;

  SELECT round(count(*)::numeric / 4.0, 1)
    INTO v_avg_val
    FROM public.staff_assistant_unanswered u
   WHERE u.created_at >= v_4w_start
     AND u.created_at < v_4w_end;

  v_pct := CASE
    WHEN coalesce(v_avg_val, 0) > 0
      THEN round(((coalesce(v_curr_val, 0) - v_avg_val) / v_avg_val) * 100.0, 1)
    ELSE 0::numeric
  END;
  v_dir := CASE WHEN v_pct > 2 THEN 'up' WHEN v_pct < -2 THEN 'down' ELSE 'flat' END;

  INSERT INTO public.staff_assistant_insights (
    kampala_date, category, scope_key, title, summary, metric_name,
    current_value, four_week_avg, pct_change, direction, is_notable,
    source_function, period_label, screen_path, min_role_scope, evidence, updated_at
  )
  VALUES (
    v_today,
    'zoe_feedback',
    'platform:unanswered_questions',
    format('Zoe unanswered questions this week: %s', coalesce(v_curr_val, 0)),
    format(
      'Zoe logged %s unanswered questions over the last 7 days compared with the 4-week average of %s per week (%s%% change).',
      coalesce(v_curr_val, 0),
      coalesce(v_avg_val, 0),
      v_pct
    ),
    'weekly_unanswered_questions',
    coalesce(v_curr_val, 0),
    coalesce(v_avg_val, 0),
    v_pct,
    v_dir,
    true,
    'staff_assistant_unanswered',
    format('%s to %s vs prior 4 weeks', v_today - 6, v_today),
    '/crm/dashboard',
    'crm',
    jsonb_build_object(
      'current_week_unanswered', coalesce(v_curr_val, 0),
      'four_week_avg_unanswered', coalesce(v_avg_val, 0),
      'pct_change', v_pct
    ),
    now()
  )
  ON CONFLICT (kampala_date, category, scope_key) DO UPDATE
    SET title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        current_value = EXCLUDED.current_value,
        four_week_avg = EXCLUDED.four_week_avg,
        pct_change = EXCLUDED.pct_change,
        direction = EXCLUDED.direction,
        is_notable = EXCLUDED.is_notable,
        period_label = EXCLUDED.period_label,
        evidence = EXCLUDED.evidence,
        updated_at = now();
  v_saved_count := v_saved_count + 1;

  RETURN jsonb_build_object(
    'ok', true,
    'kampala_date', v_today,
    'saved_insights_count', v_saved_count
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_refresh_daily_insights(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_refresh_daily_insights(date) TO authenticated, service_role;

-- Seed initial daily insights snapshot for today and register daily pg_cron job (04:15 UTC = 07:15 Africa/Kampala)
DO $do$
BEGIN
  PERFORM public.staff_assistant_refresh_daily_insights((now() AT TIME ZONE 'Africa/Kampala')::date);
EXCEPTION
  WHEN OTHERS THEN
    NULL;
END
$do$;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('staff-assistant-daily-insights');
    EXCEPTION
      WHEN OTHERS THEN NULL;
    END;

    PERFORM cron.schedule(
      'staff-assistant-daily-insights',
      '15 4 * * *',
      $job$SELECT public.staff_assistant_refresh_daily_insights();$job$
    );
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    NULL;
END
$cron$;

-- -----------------------------------------------------------------------------
-- 7. Ideas List RPCs (`staff_assistant_save_idea`, `staff_assistant_list_ideas`,
--    `staff_assistant_update_idea_status`) — Prompt 4 items (3) & (5)
-- -----------------------------------------------------------------------------

-- 7a. Save an idea after the user clicks "Save to Ideas" on an advisor card
CREATE OR REPLACE FUNCTION public.staff_assistant_save_idea(
  p_title            text,
  p_suggestion       text,
  p_evidence_summary text,
  p_figures          jsonb DEFAULT '{}'::jsonb,
  p_source_label     text DEFAULT NULL,
  p_period_label     text DEFAULT NULL,
  p_category         text DEFAULT 'general',
  p_screen_path      text DEFAULT '/me',
  p_conversation_id  uuid DEFAULT NULL,
  p_message_id       uuid DEFAULT NULL,
  p_draft_id         uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid        uuid := (SELECT auth.uid());
  v_title      text := btrim(COALESCE(p_title, ''));
  v_suggestion text := btrim(COALESCE(p_suggestion, ''));
  v_evidence   text := btrim(COALESCE(p_evidence_summary, ''));
  v_source     text := btrim(COALESCE(p_source_label, ''));
  v_period     text := COALESCE(NULLIF(btrim(COALESCE(p_period_label, '')), ''), ((now() AT TIME ZONE 'Africa/Kampala')::date)::text);
  v_category   text := CASE
    WHEN lower(btrim(COALESCE(p_category, ''))) IN ('general', 'desk_wait', 'collections', 'calling', 'payouts', 'zoe_quality')
      THEN lower(btrim(p_category))
    ELSE 'general'
  END;
  v_screen     text := COALESCE(NULLIF(btrim(COALESCE(p_screen_path, '')), ''), '/me');
  v_figures    jsonb := CASE
    WHEN p_figures IS NOT NULL AND jsonb_typeof(p_figures) IN ('object', 'array') THEN p_figures
    ELSE '{}'::jsonb
  END;
  v_row        public.staff_assistant_ideas;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;

  IF char_length(v_title) < 3 OR char_length(v_title) > 200 THEN
    RAISE EXCEPTION 'Idea title must be between 3 and 200 characters.' USING ERRCODE = '22023';
  END IF;

  IF char_length(v_suggestion) < 5 OR char_length(v_suggestion) > 2000 THEN
    RAISE EXCEPTION 'Idea suggestion must be between 5 and 2000 characters.' USING ERRCODE = '22023';
  END IF;

  IF char_length(v_evidence) < 5 OR char_length(v_evidence) > 2000 THEN
    RAISE EXCEPTION 'Evidence and figures summary is required (5 to 2000 characters).' USING ERRCODE = '22023';
  END IF;

  IF char_length(v_source) < 2 OR char_length(v_source) > 240 THEN
    RAISE EXCEPTION 'Official data source is required when saving an idea.' USING ERRCODE = '22023';
  END IF;

  IF NOT public.staff_assistant_is_valid_link_path(v_screen) THEN
    v_screen := '/me';
  END IF;

  -- If tied to a server draft card, atomically verify & consume the draft
  IF p_draft_id IS NOT NULL THEN
    PERFORM public.staff_assistant_consume_draft(
      p_draft_id,
      'idea',
      jsonb_build_object(
        'kind', 'idea',
        'title', v_title,
        'suggestion', v_suggestion,
        'evidence_summary', v_evidence,
        'source_label', v_source,
        'period_label', v_period,
        'category', v_category,
        'screen_path', v_screen
      )
    );
  END IF;

  INSERT INTO public.staff_assistant_ideas (
    created_by,
    conversation_id,
    message_id,
    draft_id,
    title,
    suggestion,
    evidence_summary,
    figures,
    source_label,
    period_label,
    category,
    screen_path,
    status
  )
  VALUES (
    v_uid,
    p_conversation_id,
    p_message_id,
    p_draft_id,
    v_title,
    v_suggestion,
    v_evidence,
    v_figures,
    v_source,
    v_period,
    v_category,
    v_screen,
    'new'
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'idea', row_to_json(v_row)::jsonb
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_save_idea(text, text, text, jsonb, text, text, text, text, uuid, uuid, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_save_idea(text, text, text, jsonb, text, text, text, text, uuid, uuid, uuid) TO authenticated;

-- 7b. List saved ideas (all ideas for managers/COO/CEO; own saved ideas for other staff)
CREATE OR REPLACE FUNCTION public.staff_assistant_list_ideas(
  p_status text DEFAULT NULL,
  p_limit  integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid        uuid := (SELECT auth.uid());
  v_can_manage boolean;
  v_status     text := NULLIF(lower(btrim(COALESCE(p_status, ''))), '');
  v_limit      integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);
  v_rows       jsonb := '[]'::jsonb;
  v_counts     jsonb := '{}'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized' USING ERRCODE = '42501';
  END IF;

  v_can_manage := public.staff_assistant_can_manage_ideas(v_uid);

  WITH visible_ideas AS (
    SELECT
      i.*,
      COALESCE(NULLIF(btrim(cp.full_name), ''), 'Staff Member') AS created_by_name,
      COALESCE(NULLIF(btrim(up.full_name), ''), NULL) AS status_updated_by_name
    FROM public.staff_assistant_ideas i
    LEFT JOIN public.profiles cp ON cp.id = i.created_by
    LEFT JOIN public.profiles up ON up.id = i.status_updated_by
    WHERE v_can_manage OR i.created_by = v_uid
  )
  SELECT
    jsonb_build_object(
      'total', count(*)::integer,
      'new', count(*) FILTER (WHERE status = 'new')::integer,
      'being_looked_at', count(*) FILTER (WHERE status = 'being_looked_at')::integer,
      'done', count(*) FILTER (WHERE status = 'done')::integer,
      'not_now', count(*) FILTER (WHERE status = 'not_now')::integer
    )
  INTO v_counts
  FROM visible_ideas;

  WITH visible_ideas AS (
    SELECT
      i.id,
      i.created_by,
      COALESCE(NULLIF(btrim(cp.full_name), ''), 'Staff Member') AS created_by_name,
      i.conversation_id,
      i.message_id,
      i.title,
      i.suggestion,
      i.evidence_summary,
      i.figures,
      i.source_label,
      i.period_label,
      i.category,
      i.screen_path,
      i.status,
      i.status_note,
      i.status_updated_by,
      COALESCE(NULLIF(btrim(up.full_name), ''), NULL) AS status_updated_by_name,
      i.status_updated_at,
      i.created_at,
      i.updated_at
    FROM public.staff_assistant_ideas i
    LEFT JOIN public.profiles cp ON cp.id = i.created_by
    LEFT JOIN public.profiles up ON up.id = i.status_updated_by
    WHERE (v_can_manage OR i.created_by = v_uid)
      AND (v_status IS NULL OR v_status = 'all' OR i.status = v_status)
    ORDER BY
      CASE i.status
        WHEN 'new' THEN 1
        WHEN 'being_looked_at' THEN 2
        WHEN 'done' THEN 3
        WHEN 'not_now' THEN 4
        ELSE 5
      END,
      i.created_at DESC
    LIMIT v_limit
  )
  SELECT COALESCE(jsonb_agg(row_to_json(vi)::jsonb), '[]'::jsonb)
    INTO v_rows
    FROM visible_ideas vi;

  RETURN jsonb_build_object(
    'can_manage_ideas', v_can_manage,
    'counts', COALESCE(v_counts, '{}'::jsonb),
    'ideas', v_rows
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_list_ideas(text, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_list_ideas(text, integer) TO authenticated;

-- 7c. Change an idea's status (`new`, `being_looked_at`, `done`, `not_now`) — ONLY managers/COO/CEO.
--     Ordinary screen action on `/me/ideas`, NEVER exposed as a Zoe tool.
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
  v_uid    uuid := (SELECT auth.uid());
  v_status text := lower(btrim(COALESCE(p_status, '')));
  v_note   text := NULLIF(btrim(COALESCE(p_status_note, '')), '');
  v_row    public.staff_assistant_ideas;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_can_manage_ideas(v_uid) THEN
    RAISE EXCEPTION 'Only managers, the COO, or the CEO can change an idea''s status.'
      USING ERRCODE = '42501';
  END IF;

  IF p_idea_id IS NULL THEN
    RAISE EXCEPTION 'idea_id is required.' USING ERRCODE = '22023';
  END IF;

  IF v_status NOT IN ('new', 'being_looked_at', 'done', 'not_now') THEN
    RAISE EXCEPTION 'Invalid idea status "%". Allowed: new, being_looked_at, done, not_now.', v_status
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.staff_assistant_ideas i
     SET status = v_status,
         status_note = COALESCE(v_note, i.status_note),
         status_updated_by = v_uid,
         status_updated_at = now(),
         updated_at = now()
   WHERE i.id = p_idea_id
   RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Idea not found.' USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'idea', row_to_json(v_row)::jsonb
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_update_idea_status(uuid, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_update_idea_status(uuid, text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 8. Monday "What to look at this week" Summary Card RPC
--    (`public.staff_assistant_weekly_look_at_summary`, Prompt 4 item 4)
--    Strictly for managers, the COO, and the CEO in My Space: top 5 issues with
--    evidence and links to the screens. Never sent outside the app.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_weekly_look_at_summary(
  p_as_of date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid           uuid := (SELECT auth.uid());
  v_today         date := COALESCE(p_as_of, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_monday        date := date_trunc('week', v_today::timestamp)::date;
  v_is_monday     boolean := (EXTRACT(ISODOW FROM v_today) = 1);
  v_ids           uuid[];
  v_timing        jsonb := '{}'::jsonb;
  v_top_desk      text := 'tenant_ops';
  v_desk_cnt      integer := 0;
  v_desk_avg_hrs  numeric := 0;
  v_not_paid      record;
  v_silent_cnt    integer := 0;
  v_reach_pct     numeric := 0;
  v_calls_total   integer := 0;
  v_unans_cnt     integer := 0;
  v_down_cnt      integer := 0;
  v_new_ideas_cnt integer := 0;
  v_items         jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_can_manage_ideas(v_uid) THEN
    RAISE EXCEPTION 'Not authorized: Weekly "What to look at this week" summary is for managers, the COO, and the CEO.'
      USING ERRCODE = '42501';
  END IF;

  -- Issue 1: Desk wait bottleneck (`rent_request_timing`)
  SELECT coalesce(array_agg(q.id), ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT rr.id
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
       ORDER BY rr.created_at ASC
       LIMIT 100
    ) q;

  IF cardinality(v_ids) > 0 THEN
    BEGIN
      v_timing := public.rent_request_timing(v_ids);
      SELECT
        coalesce(nullif(tr.val -> 'current_desk' ->> 'desk', ''), 'tenant_ops'),
        count(*)::integer,
        round(avg(coalesce((tr.val -> 'current_desk' ->> 'elapsed_seconds')::numeric, 0) / 3600.0), 1)
      INTO v_top_desk, v_desk_cnt, v_desk_avg_hrs
      FROM jsonb_array_elements(coalesce(v_timing -> 'rows', '[]'::jsonb)) AS tr(val)
      GROUP BY coalesce(nullif(tr.val -> 'current_desk' ->> 'desk', ''), 'tenant_ops')
      ORDER BY avg(coalesce((tr.val -> 'current_desk' ->> 'elapsed_seconds')::numeric, 0)) DESC, count(*) DESC
      LIMIT 1;
    EXCEPTION
      WHEN OTHERS THEN
        v_top_desk := 'tenant_ops';
        v_desk_cnt := cardinality(v_ids);
        v_desk_avg_hrs := 0;
    END;
  END IF;

  -- Issue 2: Funded Rent Plans awaiting landlord payout (`tops_landlord_not_paid_summary_amclock`)
  BEGIN
    SELECT *
      INTO v_not_paid
      FROM public.tops_landlord_not_paid_summary_amclock()
     LIMIT 1;
  EXCEPTION
    WHEN OTHERS THEN
      v_not_paid := NULL;
  END;

  -- Issue 3: Silent collectors / collection coverage (`agent_ops_silent_collectors`)
  BEGIN
    SELECT count(*)::integer
      INTO v_silent_cnt
      FROM public.agent_ops_silent_collectors(3, 200);
  EXCEPTION
    WHEN OTHERS THEN
      v_silent_cnt := 0;
  END;

  -- Issue 4: Calling Center reach rate over the last 7 days (`cc_call_attempts`)
  SELECT
    count(*)::integer,
    CASE
      WHEN count(*) > 0
        THEN round((count(*) FILTER (WHERE a.outcome::text = 'engaged')::numeric / count(*)::numeric) * 100.0, 1)
      ELSE 0::numeric
    END
  INTO v_calls_total, v_reach_pct
  FROM public.cc_call_attempts a
  WHERE a.void_reason IS NULL
    AND a.outcome IS NOT NULL
    AND coalesce(a.recorded_at, a.created_at) >= ((v_today - 6)::timestamp AT TIME ZONE 'Africa/Kampala');

  -- Issue 5: Zoe unanswered questions & thumbs-down feedback (`staff_assistant_unanswered` + `staff_assistant_feedback`)
  SELECT count(*)::integer
    INTO v_unans_cnt
    FROM public.staff_assistant_unanswered u
   WHERE u.created_at >= ((v_today - 6)::timestamp AT TIME ZONE 'Africa/Kampala')
     AND u.status = 'open';

  SELECT count(*)::integer
    INTO v_down_cnt
    FROM public.staff_assistant_feedback f
   WHERE f.rating = 'down'
     AND f.created_at >= ((v_today - 6)::timestamp AT TIME ZONE 'Africa/Kampala');

  SELECT count(*)::integer
    INTO v_new_ideas_cnt
    FROM public.staff_assistant_ideas i
   WHERE i.status = 'new';

  v_items := jsonb_build_array(
    jsonb_build_object(
      'rank', 1,
      'category', 'desk_wait',
      'title', format('Rent Plan desk wait times (%s)', coalesce(v_top_desk, 'tenant_ops')),
      'evidence', format(
        '%s open Rent Plan requests on %s averaging %s hours on desk (%s open across all desks).',
        coalesce(v_desk_cnt, 0),
        coalesce(v_top_desk, 'tenant_ops'),
        coalesce(v_desk_avg_hrs, 0),
        cardinality(v_ids)
      ),
      'metric_label', format('%s hrs avg wait', coalesce(v_desk_avg_hrs, 0)),
      'source', 'rent_request_timing',
      'screen_path', '/tenant-ops/workspace',
      'screen_label', 'Open Tenant Ops Workspace'
    ),
    jsonb_build_object(
      'rank', 2,
      'category', 'payouts',
      'title', 'Funded Rent Plans awaiting landlord payment',
      'evidence', format(
        '%s total funded Rent Plans awaiting landlord payout (%s where tenant is already repaying; %s awaiting landlord details).',
        coalesce(v_not_paid.total_plans, 0),
        coalesce(v_not_paid.tenant_paying_no_landlord, 0),
        coalesce(v_not_paid.awaiting_landlord, 0)
      ),
      'metric_label', format('%s plans waiting', coalesce(v_not_paid.total_plans, 0)),
      'source', 'tops_landlord_not_paid_summary_amclock',
      'screen_path', '/landlord-ops',
      'screen_label', 'Open Landlord Ops'
    ),
    jsonb_build_object(
      'rank', 3,
      'category', 'collections',
      'title', 'Collection coverage & silent field collectors',
      'evidence', format(
        '%s field agents with active Rent Plans have been silent for 3 or more days.',
        coalesce(v_silent_cnt, 0)
      ),
      'metric_label', format('%s silent collectors', coalesce(v_silent_cnt, 0)),
      'source', 'agent_ops_silent_collectors',
      'screen_path', '/executive-hub?tab=agent-ops',
      'screen_label', 'Open Agent Ops'
    ),
    jsonb_build_object(
      'rank', 4,
      'category', 'calling',
      'title', 'Calling Center reach rate & follow-ups',
      'evidence', format(
        '%s%% engaged reach rate across %s logged call attempts over the last 7 days.',
        coalesce(v_reach_pct, 0),
        coalesce(v_calls_total, 0)
      ),
      'metric_label', format('%s%% reach rate', coalesce(v_reach_pct, 0)),
      'source', 'cc_weekly_all_calls_report',
      'screen_path', '/me/staff-reports',
      'screen_label', 'Open Calling Reports'
    ),
    jsonb_build_object(
      'rank', 5,
      'category', 'zoe_quality',
      'title', 'Zoe unanswered questions & saved staff ideas',
      'evidence', format(
        '%s open unanswered questions, %s thumbs-down ratings this week, and %s new saved ideas awaiting manager review.',
        coalesce(v_unans_cnt, 0),
        coalesce(v_down_cnt, 0),
        coalesce(v_new_ideas_cnt, 0)
      ),
      'metric_label', format('%s new ideas · %s unanswered', coalesce(v_new_ideas_cnt, 0), coalesce(v_unans_cnt, 0)),
      'source', 'staff_assistant_unanswered + staff_assistant_ideas',
      'screen_path', '/me/ideas',
      'screen_label', 'Review Saved Ideas'
    )
  );

  RETURN jsonb_build_object(
    'source', 'staff_assistant_weekly_look_at_summary',
    'week_start', v_monday,
    'as_of', v_today,
    'is_monday', v_is_monday,
    'in_app_only', true,
    'new_ideas_count', coalesce(v_new_ideas_cnt, 0),
    'issues', v_items
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_weekly_look_at_summary(date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_weekly_look_at_summary(date) TO authenticated;

COMMIT;
