
-- Create departments table
CREATE TABLE public.departments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  head_user_id UUID REFERENCES public.profiles(id),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

-- HR, manager, super_admin, cto can manage departments
CREATE POLICY "hr_manage_departments" ON public.departments
  TO authenticated
  USING (has_role(auth.uid(), 'hr'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role) OR has_role(auth.uid(), 'cto'::app_role))
  WITH CHECK (has_role(auth.uid(), 'hr'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role) OR has_role(auth.uid(), 'cto'::app_role));

-- All authenticated can read departments
CREATE POLICY "authenticated_read_departments" ON public.departments
  FOR SELECT TO authenticated USING (true);

-- Allow HR to update profiles (for editing employee info and freezing)
CREATE POLICY "hr_update_profiles" ON public.profiles
  FOR UPDATE TO authenticated
  USING (has_role(auth.uid(), 'hr'::app_role))
  WITH CHECK (has_role(auth.uid(), 'hr'::app_role));

-- Allow HR to manage staff_profiles
CREATE POLICY "hr_manage_staff_profiles" ON public.staff_profiles
  TO authenticated
  USING (has_role(auth.uid(), 'hr'::app_role))
  WITH CHECK (has_role(auth.uid(), 'hr'::app_role));

-- Add payroll_batches status values: submitted, approved, rejected
ALTER TABLE public.payroll_batches DROP CONSTRAINT IF EXISTS payroll_batches_status_check;
ALTER TABLE public.payroll_batches ADD CONSTRAINT payroll_batches_status_check CHECK (status = ANY (ARRAY['draft','processing','completed','failed','submitted','approved','rejected']));
