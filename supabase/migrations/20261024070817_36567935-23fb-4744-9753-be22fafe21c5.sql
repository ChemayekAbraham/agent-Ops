CREATE TABLE public.welile_schools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL DEFAULT auth.uid(),
  name text NOT NULL CHECK (length(trim(name)) >= 2),
  school_level text NOT NULL,
  ownership text,
  head_name text,
  head_phone text,
  estimated_enrollment integer CHECK (estimated_enrollment IS NULL OR estimated_enrollment >= 0),
  country text NOT NULL DEFAULT 'Uganda',
  region text, district text, sub_county text, town text, parish text, village text, gate_name text,
  latitude double precision, longitude double precision, gps_accuracy_m double precision,
  gps_source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.welile_schools TO authenticated;
GRANT ALL ON public.welile_schools TO service_role;
ALTER TABLE public.welile_schools ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.welile_school_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES public.welile_schools(id),
  registered_by uuid NOT NULL DEFAULT auth.uid(),
  client_ref text UNIQUE,
  role text NOT NULL,
  full_name text,
  gender text, date_of_birth date, age integer,
  phone text, whatsapp text, email text, id_number text,
  class_grade text, stream text, boarding_status text,
  guardian_name text, guardian_phone text, guardian_whatsapp text, guardian_occupation text,
  residence_village text, fee_support_need boolean,
  subject_department text, staff_id text, years_at_school integer, next_of_kin text,
  facility_type text, facility_condition text, facility_capacity integer,
  has_smartphone boolean,
  signup_link_sent boolean NOT NULL DEFAULT false,
  signup_link_sent_at timestamptz,
  signup_link_channel text,
  needs_free_smartphone boolean NOT NULL DEFAULT false,
  smartphone_contact_phone text,
  smartphone_handover_point text,
  smartphone_verification_status text,
  smartphone_status text CHECK (smartphone_status IS NULL OR smartphone_status IN ('Requested','Approved','Delivered','Cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX welile_school_profiles_school_idx ON public.welile_school_profiles(school_id);
CREATE INDEX welile_school_profiles_registered_by_idx ON public.welile_school_profiles(registered_by);
GRANT SELECT, INSERT, UPDATE ON public.welile_school_profiles TO authenticated;
GRANT ALL ON public.welile_school_profiles TO service_role;
ALTER TABLE public.welile_school_profiles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.welile_schools_ops_ok()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public._has_enabled_role(auth.uid(), ARRAY['agent_ops','manager','super_admin','coo','ceo','cto','operations']);
$$;
GRANT EXECUTE ON FUNCTION public.welile_schools_ops_ok() TO authenticated;

CREATE OR REPLACE FUNCTION public.welile_schools_agent_ok()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public._has_enabled_role(auth.uid(), ARRAY['agent','sub_agent','senior_agent']) OR public.welile_schools_ops_ok();
$$;
GRANT EXECUTE ON FUNCTION public.welile_schools_agent_ok() TO authenticated;

CREATE POLICY ws_select ON public.welile_schools FOR SELECT TO authenticated USING ((select public.welile_schools_agent_ok()));
CREATE POLICY ws_insert ON public.welile_schools FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid() AND (select public.welile_schools_agent_ok()));
CREATE POLICY ws_update ON public.welile_schools FOR UPDATE TO authenticated USING (created_by = auth.uid() OR (select public.welile_schools_ops_ok())) WITH CHECK (created_by = auth.uid() OR (select public.welile_schools_ops_ok()));
CREATE POLICY mfa_required_for_staff ON public.welile_schools AS RESTRICTIVE FOR ALL TO authenticated USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));

CREATE POLICY wsp_select ON public.welile_school_profiles FOR SELECT TO authenticated USING (registered_by = auth.uid() OR (select public.welile_schools_ops_ok()));
CREATE POLICY wsp_insert ON public.welile_school_profiles FOR INSERT TO authenticated WITH CHECK (registered_by = auth.uid() AND (select public.welile_schools_agent_ok()));
CREATE POLICY wsp_update ON public.welile_school_profiles FOR UPDATE TO authenticated USING (registered_by = auth.uid() OR (select public.welile_schools_ops_ok())) WITH CHECK (registered_by = auth.uid() OR (select public.welile_schools_ops_ok()));
CREATE POLICY mfa_required_for_staff ON public.welile_school_profiles AS RESTRICTIVE FOR ALL TO authenticated USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));

CREATE TRIGGER welile_schools_updated_at BEFORE UPDATE ON public.welile_schools FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER welile_school_profiles_updated_at BEFORE UPDATE ON public.welile_school_profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();