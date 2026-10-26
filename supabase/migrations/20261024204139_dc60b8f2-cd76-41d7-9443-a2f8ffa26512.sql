CREATE TABLE IF NOT EXISTS public.welile_medical_facilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_name text NOT NULL,
  facility_type text NOT NULL DEFAULT 'clinic' CHECK (facility_type IN ('clinic','pharmacy','hospital','medical_center','health_centre_ii_iii_iv','diagnostic_lab','maternity_home')),
  ownership text NOT NULL DEFAULT 'private' CHECK (ownership IN ('government','private','faith_based_ngo')),
  country text NOT NULL DEFAULT 'Uganda', region text, district text, sub_county_or_town text, parish_or_ward text, cell_or_village text,
  gps_lat double precision, gps_lng double precision, gps_accuracy_m double precision, gps_source text,
  entry_point_name text NOT NULL DEFAULT 'Main Entrance / Reception',
  in_charge_name text, in_charge_phone text, approx_daily_patients integer,
  registered_by_agent_id uuid NOT NULL DEFAULT auth.uid(), registered_by_agent_name text, registered_by_agent_phone text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.welile_medical_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_ref text UNIQUE,
  facility_id uuid NOT NULL REFERENCES public.welile_medical_facilities(id) ON DELETE CASCADE,
  role_type text NOT NULL CHECK (role_type IN ('patient','caregiver_attendant','doctor_clinician','pharmacist_dispenser','nurse_midwife','lab_cashier_staff','medical_supplier','facility_asset')),
  full_name text NOT NULL, phone text, department_or_ward text, next_of_kin_name text, next_of_kin_phone text,
  has_smartphone boolean, signup_link_sent boolean NOT NULL DEFAULT false,
  signup_channel text CHECK (signup_channel IS NULL OR signup_channel IN ('whatsapp','sms','qr','none')),
  smartphone_queue_status text NOT NULL DEFAULT 'not_needed' CHECK (smartphone_queue_status IN ('not_needed','queued','approved','dispatched','delivered')),
  asset_category text, asset_quantity integer, notes text,
  registered_by_agent_id uuid NOT NULL DEFAULT auth.uid(), registered_by_agent_name text, registered_by_agent_phone text,
  gps_lat double precision, gps_lng double precision, gps_accuracy_m double precision,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.welile_medical_gate_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_ref text UNIQUE,
  facility_id uuid NOT NULL REFERENCES public.welile_medical_facilities(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES public.welile_medical_profiles(id) ON DELETE SET NULL,
  direction text NOT NULL CHECK (direction IN ('in','out')),
  person_name text NOT NULL, role_type text NOT NULL, phone text, department_or_ward text, entry_point_name text,
  visit_purpose_or_note text, attendant_or_kin_name text, attendant_or_kin_phone text,
  agent_id uuid NOT NULL DEFAULT auth.uid(), agent_name text, agent_phone text,
  gps_lat double precision, gps_lng double precision, gps_accuracy_m double precision,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.welile_medical_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_ref text UNIQUE,
  facility_id uuid NOT NULL REFERENCES public.welile_medical_facilities(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES public.welile_medical_profiles(id) ON DELETE SET NULL,
  gate_log_id uuid REFERENCES public.welile_medical_gate_logs(id) ON DELETE SET NULL,
  tx_direction text NOT NULL CHECK (tx_direction IN ('in','out')),
  receipt_number text NOT NULL,
  category text NOT NULL CHECK (category IN ('pharmacy_medicine','consultation_opd','lab_diagnostics','maternity_inpatient','insurance_welile_health','other_in','drug_stock_supplier','medical_equipment','staff_allowance','facility_utility_rent','patient_refund','other_out')),
  amount_ugx numeric NOT NULL DEFAULT 0 CHECK (amount_ugx >= 0),
  payment_method text NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash','mobile_money','welile_wallet','insurance_credit')),
  payer_or_payee_name text NOT NULL, payer_or_payee_phone text, items_or_description text,
  agent_id uuid NOT NULL DEFAULT auth.uid(), agent_name text, agent_phone text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wmf_region_district_idx ON public.welile_medical_facilities(region, district);
CREATE INDEX IF NOT EXISTS wmf_agent_idx ON public.welile_medical_facilities(registered_by_agent_id);
CREATE INDEX IF NOT EXISTS wmp_facility_idx ON public.welile_medical_profiles(facility_id);
CREATE INDEX IF NOT EXISTS wmp_queue_idx ON public.welile_medical_profiles(smartphone_queue_status);
CREATE INDEX IF NOT EXISTS wmgl_facility_recorded_idx ON public.welile_medical_gate_logs(facility_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS wmgl_recorded_idx ON public.welile_medical_gate_logs(recorded_at DESC);
CREATE INDEX IF NOT EXISTS wmt_facility_recorded_idx ON public.welile_medical_transactions(facility_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS wmt_recorded_idx ON public.welile_medical_transactions(recorded_at DESC);

CREATE OR REPLACE FUNCTION public.welile_medical_touch_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
CREATE TRIGGER wmf_touch BEFORE UPDATE ON public.welile_medical_facilities FOR EACH ROW EXECUTE FUNCTION public.welile_medical_touch_updated_at();

GRANT SELECT, INSERT, UPDATE ON public.welile_medical_facilities, public.welile_medical_profiles, public.welile_medical_gate_logs, public.welile_medical_transactions TO authenticated;
GRANT ALL ON public.welile_medical_facilities, public.welile_medical_profiles, public.welile_medical_gate_logs, public.welile_medical_transactions TO service_role;

ALTER TABLE public.welile_medical_facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.welile_medical_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.welile_medical_gate_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.welile_medical_transactions ENABLE ROW LEVEL SECURITY;

-- Facilities: field agents see the directory so they can lock onto a facility
CREATE POLICY wmf_select ON public.welile_medical_facilities FOR SELECT TO authenticated
  USING (registered_by_agent_id = auth.uid() OR (select public.welile_schools_agent_ok()) OR (select public.welile_schools_ops_ok()));
CREATE POLICY wmf_insert ON public.welile_medical_facilities FOR INSERT TO authenticated
  WITH CHECK (registered_by_agent_id = auth.uid() AND (select public.welile_schools_agent_ok()));
CREATE POLICY wmf_update ON public.welile_medical_facilities FOR UPDATE TO authenticated
  USING (registered_by_agent_id = auth.uid() OR (select public.welile_schools_ops_ok()))
  WITH CHECK (registered_by_agent_id = auth.uid() OR (select public.welile_schools_ops_ok()));

CREATE POLICY wmp_select ON public.welile_medical_profiles FOR SELECT TO authenticated
  USING (registered_by_agent_id = auth.uid() OR (select public.welile_schools_agent_ok()) OR (select public.welile_schools_ops_ok()));
CREATE POLICY wmp_insert ON public.welile_medical_profiles FOR INSERT TO authenticated
  WITH CHECK (registered_by_agent_id = auth.uid() AND (select public.welile_schools_agent_ok()));
CREATE POLICY wmp_update ON public.welile_medical_profiles FOR UPDATE TO authenticated
  USING (registered_by_agent_id = auth.uid() OR (select public.welile_schools_ops_ok()))
  WITH CHECK (registered_by_agent_id = auth.uid() OR (select public.welile_schools_ops_ok()));

CREATE POLICY wmgl_select ON public.welile_medical_gate_logs FOR SELECT TO authenticated
  USING (agent_id = auth.uid() OR (select public.welile_schools_agent_ok()) OR (select public.welile_schools_ops_ok()));
CREATE POLICY wmgl_insert ON public.welile_medical_gate_logs FOR INSERT TO authenticated
  WITH CHECK (agent_id = auth.uid() AND (select public.welile_schools_agent_ok()));
CREATE POLICY wmgl_update ON public.welile_medical_gate_logs FOR UPDATE TO authenticated
  USING (agent_id = auth.uid() OR (select public.welile_schools_ops_ok()))
  WITH CHECK (agent_id = auth.uid() OR (select public.welile_schools_ops_ok()));

CREATE POLICY wmt_select ON public.welile_medical_transactions FOR SELECT TO authenticated
  USING (agent_id = auth.uid() OR (select public.welile_schools_ops_ok()));
CREATE POLICY wmt_insert ON public.welile_medical_transactions FOR INSERT TO authenticated
  WITH CHECK (agent_id = auth.uid() AND (select public.welile_schools_agent_ok()));
CREATE POLICY wmt_update ON public.welile_medical_transactions FOR UPDATE TO authenticated
  USING (agent_id = auth.uid() OR (select public.welile_schools_ops_ok()))
  WITH CHECK (agent_id = auth.uid() OR (select public.welile_schools_ops_ok()));

CREATE POLICY mfa_required_for_staff ON public.welile_medical_facilities AS RESTRICTIVE FOR ALL TO authenticated USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE POLICY mfa_required_for_staff ON public.welile_medical_profiles AS RESTRICTIVE FOR ALL TO authenticated USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE POLICY mfa_required_for_staff ON public.welile_medical_gate_logs AS RESTRICTIVE FOR ALL TO authenticated USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE POLICY mfa_required_for_staff ON public.welile_medical_transactions AS RESTRICTIVE FOR ALL TO authenticated USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));