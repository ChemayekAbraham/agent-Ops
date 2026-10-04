-- ============================================================
-- CRM Call Centre: telephony record + roster (Africa's Talking, OUTBOUND ONLY)
-- ============================================================

CREATE TABLE public.crm_call_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  at_session_id text,
  staff_id uuid NOT NULL,
  staff_phone text,
  target_user_id uuid,
  target_role text NOT NULL DEFAULT 'tenant',
  target_name text NOT NULL DEFAULT '',
  target_phone text NOT NULL,
  target_location text,
  direction text NOT NULL DEFAULT 'Outbound',
  status text NOT NULL DEFAULT 'initiating',
  hangup_cause text,
  duration_seconds integer,
  recording_url text,
  cost_amount numeric,
  cost_currency text,
  failure_reason text,
  summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.crm_call_sessions TO authenticated;
GRANT ALL ON public.crm_call_sessions TO service_role;

ALTER TABLE public.crm_call_sessions ENABLE ROW LEVEL SECURITY;

CREATE INDEX crm_call_sessions_target_idx ON public.crm_call_sessions (target_user_id, created_at DESC);
CREATE INDEX crm_call_sessions_staff_idx ON public.crm_call_sessions (staff_id, created_at DESC);
CREATE UNIQUE INDEX crm_call_sessions_at_session_idx ON public.crm_call_sessions (at_session_id) WHERE at_session_id IS NOT NULL;

CREATE TRIGGER trg_crm_call_sessions_updated_at
  BEFORE UPDATE ON public.crm_call_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------- who may use the call centre ----------
CREATE OR REPLACE FUNCTION public.crm_call_centre_authorized(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND enabled = true
      AND role IN ('crm','manager','super_admin','coo','ceo','operations',
                   'tenant_ops','landlord_ops','agent_ops','partner_ops')
  );
$$;

-- Staff read their own + all call rows (an ops function); nobody writes directly.
CREATE POLICY "CRM staff read call sessions"
  ON public.crm_call_sessions FOR SELECT TO authenticated
  USING (public.crm_call_centre_authorized(auth.uid()));

CREATE POLICY "Service role manages call sessions"
  ON public.crm_call_sessions FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ---------- audience roster ----------
-- A person may qualify for several audiences. Deterministic precedence:
--   employee > partner > landlord > agent > tenant
-- Rationale: the narrowest, most operationally specific relationship wins, so
-- the doughnut can never double-count a person.
CREATE OR REPLACE VIEW public.v_crm_call_audience AS
WITH tenants AS (
  SELECT DISTINCT tenant_id AS person_id FROM public.rent_requests WHERE tenant_id IS NOT NULL
),
agents AS (
  SELECT DISTINCT person_id FROM (
    SELECT user_id AS person_id FROM public.user_roles WHERE enabled = true AND role IN ('agent','senior_agent','sub_agent')
    UNION SELECT agent_id FROM public.agent_collections WHERE agent_id IS NOT NULL
    UNION SELECT agent_id FROM public.rent_requests WHERE agent_id IS NOT NULL
  ) a WHERE person_id IS NOT NULL
),
partners AS (
  SELECT DISTINCT person_id FROM (
    SELECT investor_id AS person_id FROM public.investor_portfolios
    UNION SELECT funder_id FROM public.funder_pending_portfolios
  ) p WHERE person_id IS NOT NULL
),
landlords AS (
  SELECT DISTINCT person_id FROM (
    SELECT landlord_id AS person_id FROM public.agent_landlord_payouts
    UNION SELECT landlord_id FROM public.agent_landlord_float_allocations
    UNION SELECT landlord_id FROM public.landlord_float_receivables
    UNION SELECT landlord_id FROM public.landlord_account_ledger
  ) l WHERE person_id IS NOT NULL
),
employees AS (
  SELECT DISTINCT person_id FROM (
    SELECT user_id AS person_id FROM public.hr_staff WHERE active = true
    UNION SELECT user_id FROM public.staff_profiles
  ) e WHERE person_id IS NOT NULL
),
all_people AS (
  SELECT person_id FROM tenants
  UNION SELECT person_id FROM agents
  UNION SELECT person_id FROM partners
  UNION SELECT person_id FROM landlords
  UNION SELECT person_id FROM employees
)
SELECT
  ap.person_id,
  CASE
    WHEN em.person_id IS NOT NULL THEN 'employee'
    WHEN pa.person_id IS NOT NULL THEN 'partner'
    WHEN la.person_id IS NOT NULL THEN 'landlord'
    WHEN ag.person_id IS NOT NULL THEN 'agent'
    ELSE 'tenant'
  END AS primary_role
FROM all_people ap
LEFT JOIN employees em ON em.person_id = ap.person_id
LEFT JOIN partners  pa ON pa.person_id = ap.person_id
LEFT JOIN landlords la ON la.person_id = ap.person_id
LEFT JOIN agents    ag ON ag.person_id = ap.person_id;

REVOKE ALL ON public.v_crm_call_audience FROM anon, authenticated;

-- ---------- masked phone helper ----------
CREATE OR REPLACE FUNCTION public.crm_mask_phone(raw text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public
AS $$
  SELECT CASE
    WHEN raw IS NULL OR length(regexp_replace(raw, '\D', '', 'g')) < 6 THEN '—'
    ELSE '+' || left(regexp_replace(raw, '\D', '', 'g'), 6) || ' ••• ' ||
         right(regexp_replace(raw, '\D', '', 'g'), 3)
  END;
$$;

-- ---------- paged roster with call aggregates ----------
CREATE OR REPLACE FUNCTION public.crm_call_roster_page(
  p_search text DEFAULT NULL,
  p_role text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  person_id uuid,
  name text,
  phone_masked text,
  has_phone boolean,
  primary_role text,
  location text,
  avatar_url text,
  total_calls integer,
  summaries integer,
  first_called_at timestamptz,
  last_called_at timestamptz,
  last_status text,
  last_hangup_cause text,
  last_duration_seconds integer,
  last_call_id uuid,
  total_rows bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
BEGIN
  IF NOT public.crm_call_centre_authorized(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT a.person_id, a.primary_role, p.full_name, p.phone, p.avatar_url,
           COALESCE(NULLIF(p.district, ''), NULLIF(p.city, ''), NULLIF(p.region, '')) AS loc
    FROM public.v_crm_call_audience a
    JOIN public.profiles p ON p.id = a.person_id
    WHERE (p_role IS NULL OR a.primary_role = p_role)
      AND (v_search IS NULL
           OR p.full_name ILIKE '%' || v_search || '%'
           OR regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g')
              LIKE '%' || regexp_replace(v_search, '\D', '', 'g') || '%')
  ),
  agg AS (
    SELECT s.target_user_id,
           COUNT(*)::int AS calls,
           COUNT(*) FILTER (WHERE btrim(COALESCE(s.summary, '')) <> '')::int AS notes,
           MIN(s.created_at) AS first_at,
           MAX(s.created_at) AS last_at
    FROM public.crm_call_sessions s
    WHERE s.target_user_id IS NOT NULL
    GROUP BY s.target_user_id
  ),
  counted AS (SELECT COUNT(*) AS n FROM base)
  SELECT b.person_id,
         COALESCE(NULLIF(btrim(b.full_name), ''), 'Unnamed user'),
         public.crm_mask_phone(b.phone),
         public.normalize_ug_phone(b.phone) IS NOT NULL,
         b.primary_role,
         b.loc,
         b.avatar_url,
         COALESCE(g.calls, 0),
         COALESCE(g.notes, 0),
         g.first_at,
         g.last_at,
         last.status,
         last.hangup_cause,
         last.duration_seconds,
         last.id,
         (SELECT n FROM counted)
  FROM base b
  LEFT JOIN agg g ON g.target_user_id = b.person_id
  LEFT JOIN LATERAL (
    SELECT s.id, s.status, s.hangup_cause, s.duration_seconds
    FROM public.crm_call_sessions s
    WHERE s.target_user_id = b.person_id
    ORDER BY s.created_at DESC
    LIMIT 1
  ) last ON true
  ORDER BY COALESCE(g.last_at, '-infinity'::timestamptz) DESC, b.full_name ASC
  LIMIT v_limit OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

REVOKE ALL ON FUNCTION public.crm_call_roster_page(text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_call_roster_page(text, text, integer, integer) TO authenticated;

-- ---------- recent calls (KPIs, charts, history) ----------
CREATE OR REPLACE FUNCTION public.crm_call_sessions_feed(
  p_days integer DEFAULT 30,
  p_limit integer DEFAULT 1000,
  p_target_user_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  target_user_id uuid,
  target_name text,
  target_phone_masked text,
  target_role text,
  target_location text,
  status text,
  hangup_cause text,
  duration_seconds integer,
  created_at timestamptz,
  staff_id uuid,
  staff_name text,
  summary text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.crm_call_centre_authorized(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  RETURN QUERY
  SELECT s.id, s.target_user_id, s.target_name, public.crm_mask_phone(s.target_phone),
         s.target_role, s.target_location, s.status, s.hangup_cause, s.duration_seconds,
         s.created_at, s.staff_id,
         COALESCE(NULLIF(btrim(sp.full_name), ''), 'Staff'),
         s.summary
  FROM public.crm_call_sessions s
  LEFT JOIN public.profiles sp ON sp.id = s.staff_id
  WHERE s.direction = 'Outbound'
    AND s.created_at >= now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 30), 1), 365))
    AND (p_target_user_id IS NULL OR s.target_user_id = p_target_user_id)
  ORDER BY s.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 5000);
END;
$$;

REVOKE ALL ON FUNCTION public.crm_call_sessions_feed(integer, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_call_sessions_feed(integer, integer, uuid) TO authenticated;

-- ---------- staff may write ONLY the summary ----------
CREATE OR REPLACE FUNCTION public.crm_save_call_summary(p_session_id uuid, p_summary text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.crm_call_centre_authorized(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  UPDATE public.crm_call_sessions
     SET summary = NULLIF(btrim(COALESCE(p_summary, '')), '')
   WHERE id = p_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'call_session_not_found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_save_call_summary(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_save_call_summary(uuid, text) TO authenticated;

-- ---------- reveal one phone number, on demand only ----------
CREATE OR REPLACE FUNCTION public.crm_reveal_target_phone(p_person_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_phone text;
BEGIN
  IF NOT public.crm_call_centre_authorized(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT public.normalize_ug_phone(p.phone) INTO v_phone
  FROM public.profiles p WHERE p.id = p_person_id;

  IF v_phone IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN '+' || v_phone;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_reveal_target_phone(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_reveal_target_phone(uuid) TO authenticated;