-- One notice per paid payroll run; the CFO list for that run shows staff who
-- accepted the gross-pay (PAYE/NSSF) survey with a TIN and/or NSSF number
-- before that run was paid and after the previous paid run.
CREATE TABLE IF NOT EXISTS public.cfo_statutory_consent_notices (
  run_id uuid PRIMARY KEY REFERENCES public.hr_pay_runs(id) ON DELETE RESTRICT,
  paid_at timestamptz NOT NULL,
  recipient_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  pushed_at timestamptz,
  push_attempts int NOT NULL DEFAULT 0
);
GRANT SELECT ON public.cfo_statutory_consent_notices TO authenticated;
GRANT ALL ON public.cfo_statutory_consent_notices TO service_role;
ALTER TABLE public.cfo_statutory_consent_notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cfo reads statutory consent notices" ON public.cfo_statutory_consent_notices
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'cfo'::app_role) OR public.has_role(auth.uid(),'super_admin'::app_role));

CREATE OR REPLACE FUNCTION public.trg_cfo_statutory_consent_notice()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.event_type = 'paid' THEN
    INSERT INTO public.cfo_statutory_consent_notices (run_id, paid_at, recipient_id)
    VALUES (NEW.run_id, NEW.created_at, 'cfa56623-e6cb-4023-b601-3dbd4fdbc027')  -- BAYO MERCY (CFO account)
    ON CONFLICT (run_id) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_cfo_statutory_consent_notice ON public.hr_pay_run_events;
CREATE TRIGGER trg_cfo_statutory_consent_notice AFTER INSERT ON public.hr_pay_run_events
  FOR EACH ROW EXECUTE FUNCTION public.trg_cfo_statutory_consent_notice();

CREATE OR REPLACE FUNCTION public.cfo_statutory_consent_list(p_run_id uuid DEFAULT NULL)
RETURNS TABLE(run_id uuid, paid_at timestamptz, user_id uuid, full_name text, phone text,
              tin text, nssf_number text, responded_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run uuid; v_paid timestamptz; v_prev timestamptz;
BEGIN
  IF NOT (public.has_role(auth.uid(),'cfo'::app_role) OR public.has_role(auth.uid(),'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorised';
  END IF;
  SELECT n.run_id, n.paid_at INTO v_run, v_paid FROM cfo_statutory_consent_notices n
   WHERE p_run_id IS NULL OR n.run_id = p_run_id ORDER BY n.paid_at DESC LIMIT 1;
  IF v_run IS NULL THEN RETURN; END IF;
  SELECT max(e.created_at) INTO v_prev FROM hr_pay_run_events e
   WHERE e.event_type = 'paid' AND e.created_at < v_paid;
  RETURN QUERY
  SELECT v_run, v_paid, r.user_id, p.full_name, p.phone, NULLIF(trim(r.tin),''), NULLIF(trim(r.nssf_number),''), r.responded_at
    FROM staff_survey_responses r
    JOIN staff_surveys s ON s.id = r.survey_id AND s.kind = 'statutory_consent'
    LEFT JOIN profiles p ON p.id = r.user_id
   WHERE r.response = 'accept'
     AND (COALESCE(trim(r.tin),'') <> '' OR COALESCE(trim(r.nssf_number),'') <> '')
     AND r.responded_at <= v_paid
     AND (v_prev IS NULL OR r.responded_at > v_prev)
   ORDER BY p.full_name;
END $$;
REVOKE ALL ON FUNCTION public.cfo_statutory_consent_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_statutory_consent_list(uuid) TO authenticated;