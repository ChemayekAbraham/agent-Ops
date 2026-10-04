-- ============================================================
-- CRM: Customer Issues + Tenant Support records
-- ============================================================

-- 1) Customer issues / complaints log
CREATE TABLE public.crm_customer_issues (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_name text NOT NULL,
  contact text,
  issue text NOT NULL,
  experience text NOT NULL DEFAULT 'fair',
  solution text,
  status text NOT NULL DEFAULT 'open',
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_customer_issues_experience_chk CHECK (experience IN ('excellent','good','fair','bad')),
  CONSTRAINT crm_customer_issues_status_chk CHECK (status IN ('open','resolved'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_customer_issues TO authenticated;
GRANT ALL ON public.crm_customer_issues TO service_role;

ALTER TABLE public.crm_customer_issues ENABLE ROW LEVEL SECURITY;

CREATE POLICY "CRM team can view customer issues"
ON public.crm_customer_issues FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'crm') OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "CRM team can add customer issues"
ON public.crm_customer_issues FOR INSERT TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'crm') OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "CRM team can update customer issues"
ON public.crm_customer_issues FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'crm') OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "CRM team can delete customer issues"
ON public.crm_customer_issues FOR DELETE TO authenticated
USING (
  public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
);

-- 2) Tenant support: partner investment records
CREATE TABLE public.crm_tenant_support (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  partner_name text NOT NULL,
  invested_on date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  amount numeric NOT NULL DEFAULT 0,
  notes text,
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_tenant_support_amount_chk CHECK (amount >= 0)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_tenant_support TO authenticated;
GRANT ALL ON public.crm_tenant_support TO service_role;

ALTER TABLE public.crm_tenant_support ENABLE ROW LEVEL SECURITY;

CREATE POLICY "CRM team can view tenant support"
ON public.crm_tenant_support FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'crm') OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "CRM team can add tenant support"
ON public.crm_tenant_support FOR INSERT TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'crm') OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "CRM team can update tenant support"
ON public.crm_tenant_support FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'crm') OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "CRM team can delete tenant support"
ON public.crm_tenant_support FOR DELETE TO authenticated
USING (
  public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
);

-- 3) updated_at triggers
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_crm_customer_issues_updated_at
BEFORE UPDATE ON public.crm_customer_issues
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_crm_tenant_support_updated_at
BEFORE UPDATE ON public.crm_tenant_support
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();