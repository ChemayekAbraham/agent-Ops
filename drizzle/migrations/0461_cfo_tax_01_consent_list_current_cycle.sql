DO $$
DECLARE d text; v_old text := 'VALUES (NEW.run_id, NEW.created_at, ''cfa56623-e6cb-4023-b601-3dbd4fdbc027'')  -- BAYO MERCY (CFO account)';
BEGIN
  d := pg_get_functiondef('public.trg_cfo_statutory_consent_notice()'::regprocedure);
  IF position(v_old in d) = 0 THEN RAISE EXCEPTION 'CFO-TAX-01: expected recipient line not found'; END IF;
  EXECUTE replace(d, v_old,
    'SELECT NEW.run_id, NEW.created_at, u.uid FROM public.hr_pay_authority_user_ids(''release'') AS u(uid) LIMIT 1');
END $$;

CREATE OR REPLACE FUNCTION public.cfo_statutory_consent_list(p_run_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(run_id uuid, paid_at timestamp with time zone, user_id uuid, full_name text, phone text, tin text, nssf_number text, responded_at timestamp with time zone)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_run uuid; v_paid timestamptz; v_prev timestamptz; v_last timestamptz;
BEGIN
  IF NOT (public.has_role(auth.uid(),'cfo'::app_role) OR public.has_role(auth.uid(),'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorised';
  END IF;

  SELECT n.run_id, n.paid_at INTO v_run, v_paid FROM cfo_statutory_consent_notices n
   WHERE p_run_id IS NULL OR n.run_id = p_run_id ORDER BY n.paid_at DESC LIMIT 1;

  IF v_run IS NOT NULL THEN
    SELECT max(e.created_at) INTO v_prev FROM hr_pay_run_events e
     WHERE e.event_type = 'paid' AND e.created_at < v_paid;
    RETURN QUERY
    SELECT DISTINCT ON (r.user_id) v_run, v_paid, r.user_id, p.full_name, p.phone,
           NULLIF(trim(r.tin),''), NULLIF(trim(r.nssf_number),''), r.responded_at
      FROM staff_survey_responses r
      JOIN staff_surveys s ON s.id = r.survey_id AND s.kind = 'statutory_consent'
      LEFT JOIN profiles p ON p.id = r.user_id
     WHERE r.response = 'accept' AND r.responded_at <= v_paid
       AND (v_prev IS NULL OR r.responded_at > v_prev)
     ORDER BY r.user_id, r.responded_at DESC;
  END IF;

  IF p_run_id IS NULL THEN
    SELECT max(e.created_at) INTO v_last FROM hr_pay_run_events e WHERE e.event_type = 'paid';
    RETURN QUERY
    SELECT DISTINCT ON (r.user_id) NULL::uuid, NULL::timestamptz, r.user_id, p.full_name, p.phone,
           NULLIF(trim(r.tin),''), NULLIF(trim(r.nssf_number),''), r.responded_at
      FROM staff_survey_responses r
      JOIN staff_surveys s ON s.id = r.survey_id AND s.kind = 'statutory_consent'
      LEFT JOIN profiles p ON p.id = r.user_id
     WHERE r.response = 'accept'
       AND (v_last IS NULL OR r.responded_at > v_last)
     ORDER BY r.user_id, r.responded_at DESC;
  END IF;
END $function$;