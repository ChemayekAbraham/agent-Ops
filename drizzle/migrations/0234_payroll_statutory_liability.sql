-- Statutory payroll obligations (PAYE / NSSF / LST) as a reportable liability.
-- No general_ledger account exists for taxes, so this is a payroll-derived
-- disclosure computed from payslip lines on payroll that has actually been paid,
-- net of remittances recorded here.

CREATE TABLE IF NOT EXISTS public.hr_pay_statutory_remittances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authority text NOT NULL,
  component_code text NOT NULL,
  period_id uuid REFERENCES public.hr_pay_periods(id),
  amount numeric(14,2) NOT NULL,
  paid_on date NOT NULL DEFAULT current_date,
  reference text,
  basis text,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_pay_stat_rem_authority_ck CHECK (authority IN ('URA','NSSF')),
  CONSTRAINT hr_pay_stat_rem_component_ck CHECK (component_code IN ('PAYE','LST','NSSF_EE','NSSF_ER')),
  CONSTRAINT hr_pay_stat_rem_amount_ck CHECK (amount > 0),
  CONSTRAINT hr_pay_stat_rem_basis_ck CHECK (basis IS NULL OR char_length(btrim(basis)) >= 10)
);

CREATE INDEX IF NOT EXISTS hr_pay_stat_rem_component_idx
  ON public.hr_pay_statutory_remittances (component_code, paid_on);

GRANT SELECT, INSERT, UPDATE ON public.hr_pay_statutory_remittances TO authenticated;
GRANT ALL ON public.hr_pay_statutory_remittances TO service_role;

ALTER TABLE public.hr_pay_statutory_remittances ENABLE ROW LEVEL SECURITY;

-- Deliberately no DELETE policy, consistent with every other hr_pay_ table.
CREATE POLICY hr_pay_stat_rem_read ON public.hr_pay_statutory_remittances
  FOR SELECT TO authenticated
  USING (
    public.hr_pay_is_rule_reader()
    OR public.hr_pay_is_preparer()
    OR public.hr_pay_is_approver()
    OR public.hr_pay_is_releaser()
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.enabled = true
        AND ur.role::text IN ('cfo','ceo','coo','manager','super_admin','financial_ops')
    )
  );

CREATE POLICY hr_pay_stat_rem_insert ON public.hr_pay_statutory_remittances
  FOR INSERT TO authenticated
  WITH CHECK (
    public.hr_pay_is_releaser()
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.enabled = true
        AND ur.role::text IN ('cfo','super_admin','financial_ops')
    )
  );

CREATE POLICY hr_pay_stat_rem_update ON public.hr_pay_statutory_remittances
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.enabled = true
        AND ur.role::text IN ('cfo','super_admin')
    )
  );

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

REVOKE ALL ON FUNCTION public.hr_pay_statutory_liability() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_pay_statutory_liability() TO authenticated;