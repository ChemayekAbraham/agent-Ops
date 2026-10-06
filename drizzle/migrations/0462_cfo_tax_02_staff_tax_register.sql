CREATE OR REPLACE FUNCTION public.cfo_staff_tax_register(p_run_id uuid DEFAULT NULL)
RETURNS TABLE(run_id uuid, period_code text, staff_id uuid, staff_ref text, full_name text, phone text,
  source text, tin text, nssf_number text, ids_updated_at timestamptz, ids_updated_by text,
  paye_on boolean, nssf_on boolean, accepted_at timestamptz, starts_next_run boolean,
  gross numeric, chargeable_income numeric, paye numeric, nssf_employee numeric, nssf_employer numeric,
  nssf_total numeric, lst numeric, total_remittance numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE v_run uuid; v_code text;
BEGIN
  IF NOT (public.has_role(auth.uid(),'cfo'::app_role) OR public.has_role(auth.uid(),'super_admin'::app_role)
          OR public.hr_pay_is_releaser()) THEN
    RAISE EXCEPTION 'not authorised';
  END IF;

  IF p_run_id IS NOT NULL THEN
    v_run := p_run_id;
  ELSE
    SELECT r.id INTO v_run FROM hr_pay_runs r JOIN hr_pay_periods pe ON pe.id = r.period_id
     WHERE EXISTS (SELECT 1 FROM hr_pay_payslips x WHERE x.run_id = r.id AND x.is_current)
     ORDER BY pe.period_month DESC, r.created_at DESC LIMIT 1;
  END IF;
  IF v_run IS NULL THEN RETURN; END IF;
  SELECT pe.code INTO v_code FROM hr_pay_runs r JOIN hr_pay_periods pe ON pe.id = r.period_id WHERE r.id = v_run;

  RETURN QUERY
  WITH prof AS (
    SELECT DISTINCT ON (sp.staff_id) sp.staff_id, sp.paye_applicable, sp.nssf_applicable
      FROM hr_pay_statutory_profiles sp
     WHERE sp.effective_to IS NULL OR sp.effective_to > now()
     ORDER BY sp.staff_id, sp.created_at DESC
  ), acc AS (
    SELECT DISTINCT ON (r.user_id) r.user_id, r.responded_at
      FROM staff_survey_responses r
      JOIN staff_surveys sv ON sv.id = r.survey_id AND sv.kind = 'statutory_consent'
     WHERE r.response = 'accept'
     ORDER BY r.user_id, r.responded_at DESC
  )
  SELECT v_run, v_code, s.id, s.staff_ref, p.full_name, p.phone,
         CASE WHEN a.user_id IS NOT NULL THEN 'survey'
              WHEN coalesce(pf.paye_applicable,false) OR coalesce(pf.nssf_applicable,false) THEN 'payroll'
              ELSE 'cfo_added' END,
         i.tin, i.nssf_number, i.updated_at, up.full_name,
         coalesce(pf.paye_applicable,false), coalesce(pf.nssf_applicable,false),
         a.responded_at, (a.responded_at IS NOT NULL AND a.responded_at > ps.computed_at),
         ps.gross, ps.chargeable_income, ps.paye, ps.nssf_employee, ps.nssf_employer,
         ps.nssf_employee + ps.nssf_employer, ps.lst,
         ps.paye + ps.nssf_employee + ps.nssf_employer + ps.lst
    FROM hr_pay_payslips ps
    JOIN hr_staff s ON s.id = ps.staff_id
    LEFT JOIN profiles p ON p.id = s.user_id
    LEFT JOIN prof pf ON pf.staff_id = s.id
    LEFT JOIN acc a ON a.user_id = s.user_id
    LEFT JOIN hr_pay_statutory_ids i ON i.staff_id = s.id
    LEFT JOIN profiles up ON up.id = i.updated_by
   WHERE ps.run_id = v_run AND ps.is_current
     AND (ps.paye > 0 OR ps.nssf_employee > 0 OR ps.lst > 0
          OR coalesce(pf.paye_applicable,false) OR coalesce(pf.nssf_applicable,false)
          OR a.user_id IS NOT NULL OR i.id IS NOT NULL)
   ORDER BY p.full_name;
END $function$;

CREATE OR REPLACE FUNCTION public.cfo_set_staff_tax_ids(_staff_id uuid, _tin text, _nssf text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_tin text := nullif(btrim(_tin),''); v_nssf text := nullif(btrim(_nssf),'');
        o record; v_on boolean;
BEGIN
  IF NOT (public.has_role(auth.uid(),'cfo'::app_role) OR public.has_role(auth.uid(),'super_admin'::app_role)
          OR public.hr_pay_is_releaser()) THEN
    RAISE EXCEPTION 'not authorised';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hr_staff WHERE id = _staff_id AND active) THEN
    RAISE EXCEPTION 'STAFF_NOT_FOUND_OR_INACTIVE';
  END IF;
  IF v_tin IS NOT NULL AND v_tin !~ '^[0-9]{10}$' THEN RAISE EXCEPTION 'TIN must be 10 digits'; END IF;
  IF v_nssf IS NOT NULL AND length(v_nssf) > 30 THEN RAISE EXCEPTION 'NSSF number too long'; END IF;
  IF v_tin IS NULL AND v_nssf IS NULL THEN RAISE EXCEPTION 'Enter a TIN or an NSSF number'; END IF;

  SELECT tin, nssf_number INTO o FROM hr_pay_statutory_ids WHERE staff_id = _staff_id;

  INSERT INTO hr_pay_statutory_ids (staff_id, tin, nssf_number, updated_by, updated_at)
  VALUES (_staff_id, v_tin, v_nssf, auth.uid(), now())
  ON CONFLICT (staff_id) DO UPDATE
    SET tin = coalesce(EXCLUDED.tin, hr_pay_statutory_ids.tin),
        nssf_number = coalesce(EXCLUDED.nssf_number, hr_pay_statutory_ids.nssf_number),
        updated_by = auth.uid(), updated_at = now();

  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  VALUES (auth.uid(), 'cfo_staff_tax_ids_set', 'hr_pay_statutory_ids', _staff_id::text,
          'CFO recorded staff TIN/NSSF number',
          jsonb_build_object('old_tin', o.tin, 'new_tin', coalesce(v_tin, o.tin),
                             'old_nssf', o.nssf_number, 'new_nssf', coalesce(v_nssf, o.nssf_number)));

  SELECT coalesce(sp.paye_applicable,false) OR coalesce(sp.nssf_applicable,false) INTO v_on
    FROM hr_pay_statutory_profiles sp
   WHERE sp.staff_id = _staff_id AND (sp.effective_to IS NULL OR sp.effective_to > now())
   ORDER BY sp.created_at DESC LIMIT 1;

  RETURN jsonb_build_object('status','ok','staff_id',_staff_id,'tax_on_in_payroll',coalesce(v_on,false));
END $function$;

CREATE OR REPLACE FUNCTION public.cfo_staff_tax_staff_options()
RETURNS TABLE(staff_id uuid, staff_ref text, full_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_role(auth.uid(),'cfo'::app_role) OR public.has_role(auth.uid(),'super_admin'::app_role)
          OR public.hr_pay_is_releaser()) THEN
    RAISE EXCEPTION 'not authorised';
  END IF;
  RETURN QUERY
  SELECT s.id, s.staff_ref, p.full_name FROM hr_staff s LEFT JOIN profiles p ON p.id = s.user_id
   WHERE s.active ORDER BY p.full_name;
END $function$;

REVOKE ALL ON FUNCTION public.cfo_staff_tax_register(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.cfo_set_staff_tax_ids(uuid, text, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.cfo_staff_tax_staff_options() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.cfo_staff_tax_register(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_set_staff_tax_ids(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_staff_tax_staff_options() TO authenticated;