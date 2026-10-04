
-- ============ requisition_links ============
CREATE TABLE public.requisition_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text,
  department text,
  expires_at timestamptz,
  max_submissions integer,
  submission_count integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.requisition_links TO authenticated;
GRANT ALL ON public.requisition_links TO service_role;

ALTER TABLE public.requisition_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance leaders manage requisition links"
  ON public.requisition_links
  FOR ALL
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  );

CREATE INDEX idx_requisition_links_token ON public.requisition_links(token);
CREATE INDEX idx_requisition_links_active ON public.requisition_links(is_active) WHERE is_active;

-- ============ employee_requisitions ============
CREATE TABLE public.employee_requisitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid REFERENCES public.requisition_links(id) ON DELETE SET NULL,
  employee_name text NOT NULL,
  employee_id text,
  department text,
  employee_phone text,
  employee_email text NOT NULL,
  purpose text NOT NULL,
  category text NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'UGX',
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  required_by date,
  description text,
  attachment_urls text[] NOT NULL DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','paid','cancelled')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  submitter_ip text,
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, UPDATE ON public.employee_requisitions TO authenticated;
GRANT ALL ON public.employee_requisitions TO service_role;

ALTER TABLE public.employee_requisitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance leaders view requisitions"
  ON public.employee_requisitions
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  );

CREATE POLICY "Finance leaders decide requisitions"
  ON public.employee_requisitions
  FOR UPDATE
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  );

CREATE INDEX idx_employee_requisitions_status ON public.employee_requisitions(status, submitted_at DESC);
CREATE INDEX idx_employee_requisitions_link ON public.employee_requisitions(link_id);

-- updated_at trigger (reuse public.update_updated_at_column if it exists, else create)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.update_updated_at_column() RETURNS TRIGGER AS $body$
    BEGIN NEW.updated_at = now(); RETURN NEW; END;
    $body$ LANGUAGE plpgsql SET search_path = public;
  END IF;
END $$;

CREATE TRIGGER trg_requisition_links_updated
  BEFORE UPDATE ON public.requisition_links
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_employee_requisitions_updated
  BEFORE UPDATE ON public.employee_requisitions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
