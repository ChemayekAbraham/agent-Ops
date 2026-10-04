
-- =====================================================================
-- TENANT OPS BACKBONE (Inbox + Segments + Behavior drawer)
-- =====================================================================

-- ---------- Helper: who can use ops tools? ---------------------------
CREATE OR REPLACE FUNCTION public.is_tenant_ops_staff(_uid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _uid
      AND role IN ('manager','operations','coo','super_admin')
  );
$$;

-- ---------- ops_inbox_state -----------------------------------------
CREATE TABLE IF NOT EXISTS public.ops_inbox_state (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ops_user_id     uuid NOT NULL,
  tenant_id       uuid NOT NULL,
  snoozed_until   timestamptz,
  escalated_at    timestamptz,
  last_acted_at   timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ops_user_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS ops_inbox_state_tenant_idx     ON public.ops_inbox_state (tenant_id);
CREATE INDEX IF NOT EXISTS ops_inbox_state_snoozed_idx    ON public.ops_inbox_state (ops_user_id, snoozed_until);
ALTER TABLE public.ops_inbox_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_inbox_state_self_select" ON public.ops_inbox_state
  FOR SELECT TO authenticated
  USING (ops_user_id = auth.uid() AND public.is_tenant_ops_staff(auth.uid()));
CREATE POLICY "ops_inbox_state_self_insert" ON public.ops_inbox_state
  FOR INSERT TO authenticated
  WITH CHECK (ops_user_id = auth.uid() AND public.is_tenant_ops_staff(auth.uid()));
CREATE POLICY "ops_inbox_state_self_update" ON public.ops_inbox_state
  FOR UPDATE TO authenticated
  USING (ops_user_id = auth.uid() AND public.is_tenant_ops_staff(auth.uid()));
CREATE POLICY "ops_inbox_state_self_delete" ON public.ops_inbox_state
  FOR DELETE TO authenticated
  USING (ops_user_id = auth.uid() AND public.is_tenant_ops_staff(auth.uid()));

-- ---------- ops_saved_segments --------------------------------------
CREATE TABLE IF NOT EXISTS public.ops_saved_segments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid,                        -- NULL for starter segments
  name         text NOT NULL,
  description  text,
  scope        text NOT NULL DEFAULT 'tenant',  -- 'tenant' | 'agent' | 'landlord'
  filter       jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_starter   boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ops_saved_segments_scope_idx ON public.ops_saved_segments (scope, is_starter);
CREATE INDEX IF NOT EXISTS ops_saved_segments_owner_idx ON public.ops_saved_segments (owner_id);
ALTER TABLE public.ops_saved_segments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_segments_read" ON public.ops_saved_segments
  FOR SELECT TO authenticated
  USING (
    public.is_tenant_ops_staff(auth.uid())
    AND (is_starter OR owner_id = auth.uid())
  );
CREATE POLICY "ops_segments_own_insert" ON public.ops_saved_segments
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid() AND public.is_tenant_ops_staff(auth.uid()));
CREATE POLICY "ops_segments_own_update" ON public.ops_saved_segments
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() AND public.is_tenant_ops_staff(auth.uid()));
CREATE POLICY "ops_segments_own_delete" ON public.ops_saved_segments
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid() AND public.is_tenant_ops_staff(auth.uid()));

-- ---------- ops_inbox_events (realtime stream) ----------------------
CREATE TABLE IF NOT EXISTS public.ops_inbox_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         text NOT NULL DEFAULT 'tenant',
  bucket        text NOT NULL,        -- 'critical','at_risk','watch','new','snoozed'
  delta         integer NOT NULL DEFAULT 1,  -- +1 when an entry joins, -1 when it leaves
  reason        text,
  related_id    uuid,                 -- tenant_id
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ops_inbox_events_recent_idx ON public.ops_inbox_events (created_at DESC);
ALTER TABLE public.ops_inbox_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_inbox_events_staff_read" ON public.ops_inbox_events
  FOR SELECT TO authenticated
  USING (public.is_tenant_ops_staff(auth.uid()));
-- no INSERT/UPDATE/DELETE policies → only SECURITY DEFINER functions can write

ALTER PUBLICATION supabase_realtime ADD TABLE public.ops_inbox_events;

-- =====================================================================
-- RPC: ops_tenant_inbox
-- =====================================================================
CREATE OR REPLACE FUNCTION public.ops_tenant_inbox(
  p_bucket text,
  p_limit  integer DEFAULT 50,
  p_cursor timestamptz DEFAULT NULL
)
RETURNS TABLE(
  tenant_id      uuid,
  full_name      text,
  phone          text,
  city           text,
  severity       text,
  reason         text,
  days_no_progress integer,
  outstanding_ugx  numeric,
  trust_score    integer,
  trust_tier     text,
  last_visit_at  timestamptz,
  snoozed_until  timestamptz,
  rank_at        timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public.is_tenant_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  RETURN QUERY
  WITH active AS (
    SELECT
      rr.tenant_id,
      MAX(GREATEST(rr.updated_at, COALESCE(rr.disbursed_at, rr.created_at))) AS last_progress,
      SUM(GREATEST(rr.total_repayment - COALESCE(rr.amount_repaid,0), 0))     AS outstanding
    FROM public.rent_requests rr
    WHERE rr.status IN ('active','disbursed','funded','overdue')
      AND COALESCE(rr.amount_repaid,0) < COALESCE(rr.total_repayment,0)
    GROUP BY rr.tenant_id
  ),
  visits AS (
    SELECT tenant_id, MAX(checked_in_at) AS last_visit_at
    FROM public.agent_visits
    WHERE tenant_id IS NOT NULL
    GROUP BY tenant_id
  ),
  base AS (
    SELECT
      p.id            AS tenant_id,
      p.full_name,
      p.phone,
      p.city,
      a.last_progress,
      a.outstanding,
      v.last_visit_at,
      EXTRACT(DAY FROM (now() - COALESCE(a.last_progress, p.created_at)))::int AS days_no_progress,
      ts.score        AS trust_score,
      ts.tier         AS trust_tier,
      st.snoozed_until
    FROM public.profiles p
    LEFT JOIN active a              ON a.tenant_id = p.id
    LEFT JOIN visits v              ON v.tenant_id = p.id
    LEFT JOIN public.welile_trust_score_cache ts ON ts.user_id = p.id
    LEFT JOIN public.ops_inbox_state st
           ON st.tenant_id = p.id AND st.ops_user_id = v_uid
    WHERE p.id IN (SELECT tenant_id FROM active)
       OR (p.created_at > now() - interval '7 days' AND COALESCE(p.verified,false) = false)
  ),
  classified AS (
    SELECT
      b.*,
      CASE
        WHEN b.snoozed_until IS NOT NULL AND b.snoozed_until > now() THEN 'snoozed'
        WHEN b.outstanding > 0 AND b.days_no_progress >= 7 THEN 'critical'
        WHEN b.outstanding > 0 AND b.days_no_progress >= 3 THEN 'at_risk'
        WHEN COALESCE(b.trust_score, 500) < 400 THEN 'watch'
        WHEN b.outstanding IS NULL THEN 'new'
        ELSE 'watch'
      END AS severity
    FROM base b
  )
  SELECT
    c.tenant_id,
    c.full_name,
    c.phone,
    c.city,
    c.severity,
    CASE c.severity
      WHEN 'critical' THEN format('%s days no payment · UGX %s outstanding%s',
                                  c.days_no_progress, to_char(c.outstanding,'FM999,999,999'),
                                  CASE WHEN c.last_visit_at IS NULL OR c.last_visit_at < now() - interval '7 days'
                                       THEN ' · no agent visit in 7d' ELSE '' END)
      WHEN 'at_risk'  THEN format('%s days no payment · UGX %s outstanding',
                                  c.days_no_progress, to_char(c.outstanding,'FM999,999,999'))
      WHEN 'watch'    THEN format('Trust score %s — needs attention', COALESCE(c.trust_score,0))
      WHEN 'new'      THEN 'New tenant, not yet verified'
      WHEN 'snoozed'  THEN format('Snoozed until %s', to_char(c.snoozed_until,'Mon DD HH24:MI'))
    END AS reason,
    c.days_no_progress,
    COALESCE(c.outstanding,0) AS outstanding_ugx,
    COALESCE(c.trust_score,0)::int AS trust_score,
    c.trust_tier,
    c.last_visit_at,
    c.snoozed_until,
    COALESCE(c.last_progress, c.snoozed_until, now()) AS rank_at
  FROM classified c
  WHERE c.severity = p_bucket
    AND (p_cursor IS NULL OR COALESCE(c.last_progress, c.snoozed_until, now()) < p_cursor)
  ORDER BY
    CASE c.severity WHEN 'critical' THEN c.outstanding ELSE 0 END DESC NULLS LAST,
    c.days_no_progress DESC NULLS LAST,
    c.tenant_id
  LIMIT GREATEST(1, LEAST(p_limit, 200));
END;
$$;

-- =====================================================================
-- RPC: ops_query_tenants (segment-driven keyset paged list)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.ops_query_tenants(
  p_segment_id uuid,
  p_cursor     uuid DEFAULT NULL,
  p_limit      integer DEFAULT 50
)
RETURNS TABLE(
  tenant_id   uuid,
  full_name   text,
  phone       text,
  city        text,
  trust_score integer,
  trust_tier  text,
  outstanding_ugx numeric,
  matched_at  timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_filter jsonb;
  v_overdue_days integer;
  v_min_trust int;
  v_max_trust int;
  v_city text;
  v_new_within_days int;
  v_require_no_visit_days int;
  v_only_unverified boolean;
BEGIN
  IF NOT public.is_tenant_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  SELECT filter INTO v_filter FROM public.ops_saved_segments
   WHERE id = p_segment_id AND (is_starter OR owner_id = v_uid);
  IF v_filter IS NULL THEN
    RAISE EXCEPTION 'segment_not_found';
  END IF;

  v_overdue_days           := NULLIF(v_filter->>'overdue_days','')::int;
  v_min_trust              := NULLIF(v_filter->>'min_trust','')::int;
  v_max_trust              := NULLIF(v_filter->>'max_trust','')::int;
  v_city                   := v_filter->>'city';
  v_new_within_days        := NULLIF(v_filter->>'new_within_days','')::int;
  v_require_no_visit_days  := NULLIF(v_filter->>'no_visit_days','')::int;
  v_only_unverified        := COALESCE((v_filter->>'only_unverified')::boolean, false);

  RETURN QUERY
  WITH active AS (
    SELECT rr.tenant_id,
           MAX(GREATEST(rr.updated_at, COALESCE(rr.disbursed_at, rr.created_at))) AS last_progress,
           SUM(GREATEST(rr.total_repayment - COALESCE(rr.amount_repaid,0),0)) AS outstanding
    FROM public.rent_requests rr
    WHERE rr.status IN ('active','disbursed','funded','overdue')
      AND COALESCE(rr.amount_repaid,0) < COALESCE(rr.total_repayment,0)
    GROUP BY rr.tenant_id
  ),
  visits AS (
    SELECT tenant_id, MAX(checked_in_at) AS last_visit_at
    FROM public.agent_visits WHERE tenant_id IS NOT NULL GROUP BY tenant_id
  )
  SELECT
    p.id,
    p.full_name,
    p.phone,
    p.city,
    COALESCE(ts.score,0)::int,
    ts.tier,
    COALESCE(a.outstanding,0),
    COALESCE(a.last_progress, p.created_at)
  FROM public.profiles p
  LEFT JOIN active a ON a.tenant_id = p.id
  LEFT JOIN visits v ON v.tenant_id = p.id
  LEFT JOIN public.welile_trust_score_cache ts ON ts.user_id = p.id
  WHERE (p_cursor IS NULL OR p.id > p_cursor)
    AND (v_city IS NULL OR p.city = v_city)
    AND (v_min_trust IS NULL OR COALESCE(ts.score,0) >= v_min_trust)
    AND (v_max_trust IS NULL OR COALESCE(ts.score,0) <= v_max_trust)
    AND (v_only_unverified IS FALSE OR COALESCE(p.verified,false) = false)
    AND (v_new_within_days IS NULL OR p.created_at > now() - (v_new_within_days || ' days')::interval)
    AND (v_overdue_days IS NULL
         OR (a.outstanding > 0 AND a.last_progress < now() - (v_overdue_days || ' days')::interval))
    AND (v_require_no_visit_days IS NULL
         OR v.last_visit_at IS NULL
         OR v.last_visit_at < now() - (v_require_no_visit_days || ' days')::interval)
  ORDER BY p.id
  LIMIT GREATEST(1, LEAST(p_limit, 200));
END;
$$;

-- =====================================================================
-- RPC: ops_tenant_behavior (drawer JSON payload)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.ops_tenant_behavior(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_header jsonb;
  v_trend  jsonb;
  v_cohort jsonb;
  v_trust  jsonb;
  v_events jsonb;
BEGIN
  IF NOT public.is_tenant_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  SELECT jsonb_build_object(
    'tenant_id', p.id,
    'full_name', p.full_name,
    'phone', p.phone,
    'city', p.city,
    'verified', COALESCE(p.verified,false),
    'trust_score', COALESCE(ts.score,0),
    'trust_tier', ts.tier,
    'borrowing_limit_ugx', COALESCE(ts.borrowing_limit_ugx,0)
  ) INTO v_header
  FROM public.profiles p
  LEFT JOIN public.welile_trust_score_cache ts ON ts.user_id = p.id
  WHERE p.id = p_tenant_id;

  -- 30-day repayment trend from general_ledger rent_repayment
  SELECT COALESCE(jsonb_agg(jsonb_build_object('d', d, 'paid', paid) ORDER BY d), '[]'::jsonb)
    INTO v_trend
  FROM (
    SELECT date_trunc('day', gl.created_at)::date AS d,
           SUM(gl.amount) AS paid
      FROM public.general_ledger gl
     WHERE gl.user_id = p_tenant_id
       AND gl.category IN ('rent_repayment','rent_payment_for_tenant','agent_float_allocation')
       AND gl.created_at > now() - interval '30 days'
     GROUP BY 1
  ) s;

  -- Cohort vs city median (paid % over 30d)
  SELECT jsonb_build_object(
    'city', p.city,
    'tenant_paid_30d', COALESCE((SELECT SUM(amount) FROM public.general_ledger
                                  WHERE user_id = p_tenant_id
                                    AND category IN ('rent_repayment','rent_payment_for_tenant','agent_float_allocation')
                                    AND created_at > now() - interval '30 days'),0)
  ) INTO v_cohort
  FROM public.profiles p WHERE p.id = p_tenant_id;

  -- Trust factor breakdown
  SELECT COALESCE(ts.breakdown, '{}'::jsonb) INTO v_trust
    FROM public.welile_trust_score_cache ts WHERE ts.user_id = p_tenant_id;

  -- Last 5 events
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', se.id,
           'event_type', se.event_type,
           'created_at', se.created_at,
           'metadata', se.metadata
         ) ORDER BY se.created_at DESC), '[]'::jsonb)
    INTO v_events
  FROM (
    SELECT id, event_type, created_at, metadata
      FROM public.system_events
     WHERE user_id = p_tenant_id
     ORDER BY created_at DESC
     LIMIT 5
  ) se;

  RETURN jsonb_build_object(
    'header', v_header,
    'trend_30d', v_trend,
    'cohort', v_cohort,
    'trust_breakdown', v_trust,
    'recent_events', v_events
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.ops_tenant_inbox(text,integer,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_query_tenants(uuid,uuid,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_tenant_behavior(uuid) TO authenticated;

-- =====================================================================
-- Seed 6 starter segments
-- =====================================================================
INSERT INTO public.ops_saved_segments (owner_id, name, description, scope, filter, is_starter, sort_order)
VALUES
  (NULL, 'Overdue 3+ days',           'Active rent plans with 3+ days no payment progress',  'tenant', '{"overdue_days":3}'::jsonb,                                              true, 10),
  (NULL, 'Overdue 7+ days, no visit', 'Critical: overdue 7+ days and no agent visit in 7d',   'tenant', '{"overdue_days":7,"no_visit_days":7}'::jsonb,                            true, 20),
  (NULL, 'New (7d), unverified',      'New tenants in last 7 days awaiting verification',     'tenant', '{"new_within_days":7,"only_unverified":true}'::jsonb,                    true, 30),
  (NULL, 'Trust score below 400',     'Tenants whose trust score signals risk',               'tenant', '{"max_trust":399}'::jsonb,                                               true, 40),
  (NULL, 'Overdue 14+ days',          'Overdue 14+ days with no payment progress',            'tenant', '{"overdue_days":14}'::jsonb,                                             true, 50),
  (NULL, 'Kampala — overdue 3+ days', 'City-scoped Kampala critical segment',                 'tenant', '{"overdue_days":3,"city":"Kampala"}'::jsonb,                             true, 60)
ON CONFLICT DO NOTHING;
