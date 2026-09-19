-- Correction: hr_pay_payslips keeps superseded recalculations (calc_seq / is_current).
-- The statutory liability must count only the current payslip per staff member per
-- run, otherwise every recalculation inflates the obligation.
CREATE OR REPLACE FUNCTION public.hr_pay_statutory_liability()
RETURNS TABLE (
  authority text,
  component_code text,
  label text,
  withheld numeric,
  remitted numeric,
  outstanding numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.hr_pay_is_rule_reader()
    OR public.hr_pay_is_preparer()
    OR public.hr_pay_is_approver()
    OR public.hr_pay_is_releaser()
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.enabled = true
        AND ur.role::text IN ('cfo','ceo','coo','cto','manager','super_admin','financial_ops')
    )
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  RETURN QUERY
  WITH defs(component_code, authority, label) AS (
    VALUES
      ('PAYE',    'URA',  'PAYE withheld from staff (URA)'),
      ('LST',     'URA',  'Local Service Tax withheld (URA)'),
      ('NSSF_EE', 'NSSF', 'NSSF employee 5% withheld'),
      ('NSSF_ER', 'NSSF', 'NSSF employer 10% contribution')
  ),
  withheld AS (
    SELECT l.component_code, COALESCE(SUM(l.amount), 0)::numeric AS amt
    FROM public.hr_pay_payslip_lines l
    JOIN public.hr_pay_payslips p ON p.id = l.payslip_id
    JOIN public.hr_pay_runs r ON r.id = p.run_id
    WHERE r.status IN ('paid','locked')
      AND p.is_current = true
      AND l.component_code IN ('PAYE','LST','NSSF_EE','NSSF_ER')
    GROUP BY l.component_code
  ),
  remitted AS (
    SELECT rm.component_code, COALESCE(SUM(rm.amount), 0)::numeric AS amt
    FROM public.hr_pay_statutory_remittances rm
    GROUP BY rm.component_code
  )
  SELECT
    d.authority,
    d.component_code,
    d.label,
    COALESCE(w.amt, 0)::numeric,
    COALESCE(rr.amt, 0)::numeric,
    GREATEST(COALESCE(w.amt, 0) - COALESCE(rr.amt, 0), 0)::numeric
  FROM defs d
  LEFT JOIN withheld w ON w.component_code = d.component_code
  LEFT JOIN remitted rr ON rr.component_code = d.component_code
  ORDER BY d.authority, d.component_code;
END;
$$;