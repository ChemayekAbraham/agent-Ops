ALTER TABLE public.special_advance_events DROP CONSTRAINT special_advance_events_event_type_check;
ALTER TABLE public.special_advance_events ADD CONSTRAINT special_advance_events_event_type_check CHECK (event_type = ANY (ARRAY['created','approved','rejected','cancelled','disbursed','settled','reopened','reversed','correction_posted','written_off','write_off_posted','provision_posted','recovery_recorded','topup_posted','note_added']::text[]));

CREATE OR REPLACE FUNCTION public.special_advance_add_note(p_id uuid, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_note text := public._special_advance_reason(p_note, true);
  v_status text;
BEGIN
  SELECT status INTO v_status FROM public.special_advances WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
  VALUES (p_id, 'note_added', v_status, v_status, v_actor, v_note, '{}'::jsonb);
  RETURN public.special_advance_statement(p_id);
END $function$;
REVOKE ALL ON FUNCTION public.special_advance_add_note(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.special_advance_add_note(uuid, text) TO authenticated, service_role;