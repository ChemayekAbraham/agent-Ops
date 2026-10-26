CREATE TABLE IF NOT EXISTS public.welile_school_gate_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_ref text UNIQUE,
  school_id uuid NOT NULL REFERENCES public.welile_schools(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES public.welile_school_profiles(id) ON DELETE SET NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  person_name text NOT NULL CHECK (length(trim(person_name)) >= 1),
  role_type text NOT NULL,
  phone text,
  class_or_department text,
  gate_name text NOT NULL DEFAULT 'Main Gate',
  purpose_or_note text,
  pickup_guardian_name text,
  pickup_guardian_phone text,
  agent_id uuid NOT NULL DEFAULT auth.uid(),
  agent_name text,
  agent_phone text,
  gps_lat double precision,
  gps_lng double precision,
  gps_accuracy_m double precision,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS welile_school_gate_logs_school_recorded_idx ON public.welile_school_gate_logs(school_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS welile_school_gate_logs_recorded_idx ON public.welile_school_gate_logs(recorded_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.welile_school_gate_logs TO authenticated;
GRANT ALL ON public.welile_school_gate_logs TO service_role;
ALTER TABLE public.welile_school_gate_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY wsgl_select ON public.welile_school_gate_logs FOR SELECT TO authenticated
  USING (agent_id = auth.uid() OR (select public.welile_schools_agent_ok()));

CREATE POLICY wsgl_insert ON public.welile_school_gate_logs FOR INSERT TO authenticated
  WITH CHECK (agent_id = auth.uid() AND (select public.welile_schools_agent_ok()));

CREATE POLICY wsgl_update ON public.welile_school_gate_logs FOR UPDATE TO authenticated
  USING (agent_id = auth.uid() OR (select public.welile_schools_ops_ok()))
  WITH CHECK (agent_id = auth.uid() OR (select public.welile_schools_ops_ok()));

CREATE POLICY mfa_required_for_staff ON public.welile_school_gate_logs AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok()))
  WITH CHECK ((select public.staff_mfa_ok()));