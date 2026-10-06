-- tops_shortfall_followups: an append-only log of the follow-ups Tenant Ops staff make on
-- short Rent Plans from the Collection Shortfall page. Additive only: one new table, three
-- new functions, nothing existing is altered. No money moves and no existing table is written.
--
--   public.tops_shortfall_followups               the log (insert + select only)
--   public.tops_record_shortfall_followup(...)    the only write path (SECURITY DEFINER,
--                                                 also emits a system_events row)
--   public.tops_shortfall_followups_latest(uuid[]) latest follow-up per Rent Plan (read-only)
--
-- Who may use it: exactly the roles that may call the shortfall functions (is_ops_role =
-- manager / super_admin / coo / operations via user_roles, plus manager, super_admin, cto,
-- ceo, coo through has_role). The same check guards the table's RLS policies.
--
-- rent_request_id deliberately has no foreign key: a foreign key would put referential
-- triggers on rent_requests, an existing table. The record function checks the plan exists.

CREATE TABLE IF NOT EXISTS public.tops_shortfall_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  outcome text NOT NULL
    CONSTRAINT tops_shortfall_followups_outcome_check
    CHECK (outcome IN ('reached_will_pay', 'reached_refused', 'no_answer', 'wrong_number', 'agent_informed')),
  note text NOT NULL
    CONSTRAINT tops_shortfall_followups_note_check CHECK (length(btrim(note)) >= 10),
  promised_date date,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tops_shortfall_followups_plan_idx
  ON public.tops_shortfall_followups (rent_request_id, created_at DESC);

-- Append-only, even for the table owner and service_role: no row can be changed or removed.
CREATE OR REPLACE FUNCTION public.tops_shortfall_followups_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  RAISE EXCEPTION 'tops_shortfall_followups is append-only: % is not allowed', TG_OP;
END;
$function$;

DROP TRIGGER IF EXISTS tops_shortfall_followups_no_change ON public.tops_shortfall_followups;
CREATE TRIGGER tops_shortfall_followups_no_change
  BEFORE UPDATE OR DELETE ON public.tops_shortfall_followups
  FOR EACH ROW EXECUTE FUNCTION public.tops_shortfall_followups_append_only();

REVOKE ALL ON FUNCTION public.tops_shortfall_followups_append_only() FROM PUBLIC, anon;

-- This schema's default privileges auto-grant new objects (all privileges, to anon and
-- authenticated); strip every one, then grant back only what an append-only log needs.
REVOKE ALL ON TABLE public.tops_shortfall_followups FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.tops_shortfall_followups TO authenticated;
GRANT SELECT, INSERT ON TABLE public.tops_shortfall_followups TO service_role;

ALTER TABLE public.tops_shortfall_followups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tops_shortfall_followups_select ON public.tops_shortfall_followups;
CREATE POLICY tops_shortfall_followups_select ON public.tops_shortfall_followups
  FOR SELECT TO authenticated
  USING (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  );

-- A direct insert must be the caller's own row. There is deliberately no UPDATE or DELETE policy.
DROP POLICY IF EXISTS tops_shortfall_followups_insert ON public.tops_shortfall_followups;
CREATE POLICY tops_shortfall_followups_insert ON public.tops_shortfall_followups
  FOR INSERT TO authenticated
  WITH CHECK (
    actor_id = auth.uid()
    AND (
      public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
      OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
    )
  );

-- ─── tops_record_shortfall_followup ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tops_record_shortfall_followup(
  p_rent_request_id uuid,
  p_outcome text,
  p_note text,
  p_promised_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_id uuid;
  v_created timestamptz;
  v_note text := btrim(COALESCE(p_note, ''));
BEGIN
  IF v_actor IS NULL OR NOT (
    public.is_ops_role(v_actor) OR public.has_role(v_actor, 'manager') OR public.has_role(v_actor, 'super_admin')
    OR public.has_role(v_actor, 'cto') OR public.has_role(v_actor, 'ceo') OR public.has_role(v_actor, 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  IF p_rent_request_id IS NULL THEN RAISE EXCEPTION 'p_rent_request_id is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rent_requests rr WHERE rr.id = p_rent_request_id) THEN
    RAISE EXCEPTION 'Rent Plan not found';
  END IF;

  IF p_outcome IS NULL OR p_outcome NOT IN ('reached_will_pay', 'reached_refused', 'no_answer', 'wrong_number', 'agent_informed') THEN
    RAISE EXCEPTION 'invalid outcome: %, expected reached_will_pay/reached_refused/no_answer/wrong_number/agent_informed', p_outcome;
  END IF;

  IF length(v_note) < 10 THEN
    RAISE EXCEPTION 'note must be at least 10 characters';
  END IF;

  IF p_promised_date IS NOT NULL AND p_outcome <> 'reached_will_pay' THEN
    RAISE EXCEPTION 'a promised date only applies to the outcome reached_will_pay';
  END IF;

  INSERT INTO public.tops_shortfall_followups (rent_request_id, actor_id, outcome, note, promised_date)
  VALUES (p_rent_request_id, v_actor, p_outcome, v_note, p_promised_date)
  RETURNING id, created_at INTO v_id, v_created;

  -- Event-based rule: record that it happened. Written in the same transaction as the log row.
  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'shortfall_followup_recorded',
    v_actor,
    'rent_request',
    p_rent_request_id,
    jsonb_build_object(
      'followup_id', v_id,
      'outcome', p_outcome,
      'promised_date', p_promised_date,
      'source', 'tops_shortfall'
    )
  );

  RETURN jsonb_build_object(
    'id', v_id,
    'rent_request_id', p_rent_request_id,
    'actor_id', v_actor,
    'outcome', p_outcome,
    'note', v_note,
    'promised_date', p_promised_date,
    'created_at', v_created
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_record_shortfall_followup(uuid, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_record_shortfall_followup(uuid, text, text, date) TO authenticated;

-- ─── tops_shortfall_followups_latest ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tops_shortfall_followups_latest(p_rent_request_ids uuid[])
RETURNS TABLE (
  rent_request_id uuid,
  followup_id uuid,
  outcome text,
  note text,
  promised_date date,
  created_at timestamptz,
  actor_id uuid,
  actor_name text,
  followup_count int
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  IF p_rent_request_ids IS NULL OR cardinality(p_rent_request_ids) = 0 THEN
    RETURN;
  END IF;
  IF cardinality(p_rent_request_ids) > 1000 THEN
    RAISE EXCEPTION 'too many Rent Plans: %, at most 1000 per call', cardinality(p_rent_request_ids);
  END IF;

  RETURN QUERY
  WITH ids AS (
    SELECT DISTINCT x AS rr_id FROM unnest(p_rent_request_ids) AS x
  ),
  counts AS (
    SELECT f.rent_request_id AS rr_id, count(*)::int AS n
    FROM public.tops_shortfall_followups f
    WHERE f.rent_request_id IN (SELECT i.rr_id FROM ids i)
    GROUP BY f.rent_request_id
  ),
  latest AS (
    SELECT DISTINCT ON (f.rent_request_id)
      f.rent_request_id AS rr_id, f.id AS f_id, f.outcome AS f_outcome, f.note AS f_note,
      f.promised_date AS f_promised, f.created_at AS f_created, f.actor_id AS f_actor
    FROM public.tops_shortfall_followups f
    WHERE f.rent_request_id IN (SELECT i.rr_id FROM ids i)
    ORDER BY f.rent_request_id, f.created_at DESC, f.id DESC
  )
  SELECT
    l.rr_id,
    l.f_id,
    l.f_outcome,
    l.f_note,
    l.f_promised,
    l.f_created,
    l.f_actor,
    NULLIF(btrim(p.full_name), ''),
    c.n
  FROM latest l
  JOIN counts c ON c.rr_id = l.rr_id
  LEFT JOIN public.profiles p ON p.id = l.f_actor;
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_shortfall_followups_latest(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_shortfall_followups_latest(uuid[]) TO authenticated;
