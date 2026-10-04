
-- Create leave_type enum
DO $$ BEGIN CREATE TYPE public.leave_type AS ENUM ('annual', 'sick', 'personal', 'maternity', 'paternity'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Create disciplinary_action_type enum
DO $$ BEGIN CREATE TYPE public.disciplinary_action_type AS ENUM ('verbal_warning', 'written_warning', 'suspension', 'termination', 'probation'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- leave_requests table
CREATE TABLE IF NOT EXISTS public.leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  leave_type public.leave_type NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days_count INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by UUID REFERENCES public.profiles(id),
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- leave_balances table
CREATE TABLE IF NOT EXISTS public.leave_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  leave_type public.leave_type NOT NULL,
  year INTEGER NOT NULL,
  total_days INTEGER NOT NULL DEFAULT 21,
  used_days INTEGER NOT NULL DEFAULT 0,
  remaining_days INTEGER NOT NULL DEFAULT 21,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, leave_type, year)
);

-- disciplinary_records table
CREATE TABLE IF NOT EXISTS public.disciplinary_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  action_type public.disciplinary_action_type NOT NULL,
  severity TEXT NOT NULL DEFAULT 'low',
  description TEXT NOT NULL,
  issued_by UUID NOT NULL REFERENCES public.profiles(id),
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expiry_date DATE,
  status TEXT NOT NULL DEFAULT 'active',
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add missing columns to existing payroll_batches
ALTER TABLE public.payroll_batches ADD COLUMN IF NOT EXISTS period_start DATE;
ALTER TABLE public.payroll_batches ADD COLUMN IF NOT EXISTS period_end DATE;
ALTER TABLE public.payroll_batches ADD COLUMN IF NOT EXISTS prepared_by UUID REFERENCES public.profiles(id);
ALTER TABLE public.payroll_batches ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES public.profiles(id);
ALTER TABLE public.payroll_batches ADD COLUMN IF NOT EXISTS employee_count INTEGER DEFAULT 0;
ALTER TABLE public.payroll_batches ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE public.payroll_batches ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE public.payroll_batches ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

-- Add missing columns to existing payroll_items
ALTER TABLE public.payroll_items ADD COLUMN IF NOT EXISTS deductions JSONB NOT NULL DEFAULT '{}';
ALTER TABLE public.payroll_items ADD COLUMN IF NOT EXISTS bonuses JSONB NOT NULL DEFAULT '{}';

-- Enable RLS
ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disciplinary_records ENABLE ROW LEVEL SECURITY;

-- RLS: admin roles manage all HR tables
CREATE POLICY "admin_manage_leave_requests" ON public.leave_requests
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'cto'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'cto'));

CREATE POLICY "employees_view_own_leave" ON public.leave_requests
  FOR SELECT TO authenticated USING (employee_id = auth.uid());

CREATE POLICY "admin_manage_leave_balances" ON public.leave_balances
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'cto'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'cto'));

CREATE POLICY "employees_view_own_balances" ON public.leave_balances
  FOR SELECT TO authenticated USING (employee_id = auth.uid());

CREATE POLICY "admin_manage_disciplinary" ON public.disciplinary_records
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'cto'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'cto'));

CREATE POLICY "employees_view_own_disciplinary" ON public.disciplinary_records
  FOR SELECT TO authenticated USING (employee_id = auth.uid());

-- Payroll RLS for admin
CREATE POLICY "admin_manage_payroll_batches" ON public.payroll_batches
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'cto'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'cto'));

CREATE POLICY "cfo_view_payroll_batches" ON public.payroll_batches
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'cfo'));

CREATE POLICY "admin_manage_payroll_items" ON public.payroll_items
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'cto'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'cto'));

CREATE POLICY "cfo_view_payroll_items" ON public.payroll_items
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'cfo'));

-- Audit triggers
CREATE OR REPLACE FUNCTION public.trg_leave_request_audit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_event_type TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN v_event_type := 'hr_leave_requested';
  ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status = 'approved' THEN v_event_type := 'hr_leave_approved';
    ELSIF NEW.status = 'rejected' THEN v_event_type := 'hr_leave_rejected';
    ELSE RETURN NEW; END IF;
  ELSE RETURN NEW; END IF;
  INSERT INTO public.audit_logs (user_id, action_type, metadata)
  VALUES (COALESCE(NEW.reviewed_by, NEW.employee_id), v_event_type,
    jsonb_build_object('leave_request_id', NEW.id, 'employee_id', NEW.employee_id, 'status', NEW.status, 'leave_type', NEW.leave_type::TEXT, 'days', NEW.days_count));
  BEGIN
    INSERT INTO public.system_events (event_type, payload, triggered_by)
    VALUES (v_event_type, jsonb_build_object('leave_request_id', NEW.id, 'employee_id', NEW.employee_id, 'status', NEW.status), COALESCE(NEW.reviewed_by, NEW.employee_id));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_leave_request_audit ON public.leave_requests;
CREATE TRIGGER trg_leave_request_audit AFTER INSERT OR UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION public.trg_leave_request_audit();

CREATE OR REPLACE FUNCTION public.trg_disciplinary_audit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_logs (user_id, action_type, metadata)
  VALUES (NEW.issued_by, 'hr_disciplinary_issued',
    jsonb_build_object('record_id', NEW.id, 'employee_id', NEW.employee_id, 'action_type', NEW.action_type::TEXT, 'severity', NEW.severity));
  BEGIN
    INSERT INTO public.system_events (event_type, payload, triggered_by)
    VALUES ('hr_disciplinary_issued', jsonb_build_object('record_id', NEW.id, 'employee_id', NEW.employee_id, 'action_type', NEW.action_type::TEXT), NEW.issued_by);
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_disciplinary_audit ON public.disciplinary_records;
CREATE TRIGGER trg_disciplinary_audit AFTER INSERT ON public.disciplinary_records FOR EACH ROW EXECUTE FUNCTION public.trg_disciplinary_audit();

CREATE OR REPLACE FUNCTION public.trg_payroll_batch_audit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_event_type TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status = 'submitted' THEN v_event_type := 'hr_payroll_submitted';
    ELSIF NEW.status = 'approved' THEN v_event_type := 'hr_payroll_approved';
    ELSIF NEW.status = 'rejected' THEN v_event_type := 'hr_payroll_rejected';
    ELSE RETURN NEW; END IF;
  ELSE RETURN NEW; END IF;
  INSERT INTO public.audit_logs (user_id, action_type, metadata)
  VALUES (COALESCE(NEW.approved_by, NEW.prepared_by, NEW.created_by), v_event_type,
    jsonb_build_object('batch_id', NEW.id, 'status', NEW.status, 'total_amount', NEW.total_amount));
  BEGIN
    INSERT INTO public.system_events (event_type, payload, triggered_by)
    VALUES (v_event_type, jsonb_build_object('batch_id', NEW.id, 'status', NEW.status, 'total_amount', NEW.total_amount), COALESCE(NEW.approved_by, NEW.prepared_by, NEW.created_by));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_payroll_batch_audit ON public.payroll_batches;
CREATE TRIGGER trg_payroll_batch_audit AFTER UPDATE ON public.payroll_batches FOR EACH ROW EXECUTE FUNCTION public.trg_payroll_batch_audit();

-- Validation triggers
CREATE OR REPLACE FUNCTION public.trg_validate_leave_reason()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF LENGTH(COALESCE(NEW.reason, '')) < 10 THEN RAISE EXCEPTION 'Leave reason must be at least 10 characters'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_validate_leave_reason ON public.leave_requests;
CREATE TRIGGER trg_validate_leave_reason BEFORE INSERT OR UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION public.trg_validate_leave_reason();

CREATE OR REPLACE FUNCTION public.trg_validate_disciplinary_desc()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF LENGTH(COALESCE(NEW.description, '')) < 10 THEN RAISE EXCEPTION 'Disciplinary description must be at least 10 characters'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_validate_disciplinary_desc ON public.disciplinary_records;
CREATE TRIGGER trg_validate_disciplinary_desc BEFORE INSERT OR UPDATE ON public.disciplinary_records FOR EACH ROW EXECUTE FUNCTION public.trg_validate_disciplinary_desc();
