CREATE TABLE public.special_advance_name_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id uuid NOT NULL REFERENCES public.special_advances(id),
  old_name text,
  new_name text NOT NULL,
  reason text NOT NULL,
  edited_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX special_advance_name_edits_advance_idx ON public.special_advance_name_edits(advance_id, created_at DESC);
GRANT SELECT ON public.special_advance_name_edits TO authenticated;
GRANT ALL ON public.special_advance_name_edits TO service_role;
ALTER TABLE public.special_advance_name_edits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "CFO can read special advance name edits" ON public.special_advance_name_edits FOR SELECT TO authenticated
  USING ((select public._has_enabled_role((select auth.uid()), ARRAY['cfo'])));
CREATE POLICY mfa_required_for_staff ON public.special_advance_name_edits AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE TRIGGER special_advance_name_edits_append_only BEFORE UPDATE OR DELETE ON public.special_advance_name_edits
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_block_mutation();

ALTER TABLE public.special_advance_events DROP CONSTRAINT special_advance_events_event_type_check;
ALTER TABLE public.special_advance_events ADD CONSTRAINT special_advance_events_event_type_check CHECK (event_type = ANY (ARRAY['created','approved','rejected','cancelled','disbursed','settled','reopened','reversed','correction_posted','written_off','write_off_posted','provision_posted','recovery_recorded','topup_posted','note_added','principal_edited','name_edited']::text[]));

-- the advance shows the latest corrected name first
DO $do$
DECLARE f text; d text;
  v_old text := 'COALESCE(eb.full_name, NULLIF(btrim(pr.full_name), ''''))';
  v_new text := 'COALESCE((SELECT ne.new_name FROM public.special_advance_name_edits ne WHERE ne.advance_id = a.id ORDER BY ne.created_at DESC LIMIT 1), eb.full_name, NULLIF(btrim(pr.full_name), ''''))';
BEGIN
  FOREACH f IN ARRAY ARRAY['_special_advance_json','special_advance_list'] LOOP
    SELECT pg_get_functiondef(oid) INTO d FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=f;
    IF position(v_old in d) = 0 THEN RAISE EXCEPTION '% changed', f; END IF;
    EXECUTE replace(d, v_old, v_new);
  END LOOP;
END $do$;

CREATE OR REPLACE FUNCTION public.special_advance_edit_name(p_id uuid, p_expected_updated_at timestamptz, p_name text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_reason text := public._special_advance_reason(p_reason, true);
  a public.special_advances%ROWTYPE := public._special_advance_lock(p_id, p_expected_updated_at);
  v_name text := regexp_replace(btrim(COALESCE(p_name, '')), '\s+', ' ', 'g');
  v_old text;
BEGIN
  IF a.decision_reason IS DISTINCT FROM 'Recorded already-issued outside-Welile advance; no new payment' THEN
    RAISE EXCEPTION 'PRINCIPAL_EDIT_ONLY_RECORDED' USING ERRCODE = '22023';
  END IF;
  IF length(v_name) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'NAME_INVALID' USING ERRCODE = '22023';
  END IF;
  v_old := (public._special_advance_json(a.id)) ->> 'borrower_name';
  IF v_old IS NOT DISTINCT FROM v_name THEN RAISE EXCEPTION 'NAME_UNCHANGED' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.special_advance_name_edits (advance_id, old_name, new_name, reason, edited_by)
  VALUES (a.id, v_old, v_name, v_reason, v_actor);
  INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
  VALUES (a.id, 'name_edited', a.status, a.status, v_actor, v_reason, jsonb_build_object('old_name', v_old, 'new_name', v_name));
  PERFORM set_config('special_advance.principal_edit', a.id::text, true);
  UPDATE public.special_advances SET updated_at = clock_timestamp() WHERE id = a.id;
  PERFORM set_config('special_advance.principal_edit', '', true);
  RETURN public.special_advance_statement(a.id);
END $function$;
REVOKE ALL ON FUNCTION public.special_advance_edit_name(uuid, timestamptz, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.special_advance_edit_name(uuid, timestamptz, text, text) TO authenticated, service_role;