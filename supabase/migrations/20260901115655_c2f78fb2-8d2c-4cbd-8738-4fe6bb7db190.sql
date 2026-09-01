CREATE TABLE public.agent_fleet_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  asset_type text NOT NULL DEFAULT 'company_fleet_bike',
  item_name text NOT NULL DEFAULT 'Company Fleet Bike',
  plate_number text,
  serial_number text,
  service_centre_id uuid,
  assigned_on date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'assigned',
  notes text,
  assigned_by uuid,
  returned_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_fleet_assignments_status_check CHECK (status IN ('assigned','returned','lost','retired'))
);

GRANT SELECT, INSERT, UPDATE ON public.agent_fleet_assignments TO authenticated;
GRANT ALL ON public.agent_fleet_assignments TO service_role;

ALTER TABLE public.agent_fleet_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops staff manage fleet assignments"
ON public.agent_fleet_assignments FOR ALL TO authenticated
USING (public._agent_products_authorized())
WITH CHECK (public._agent_products_authorized());

CREATE POLICY "Agents view their own fleet assignments"
ON public.agent_fleet_assignments FOR SELECT TO authenticated
USING (agent_id = auth.uid());

CREATE INDEX idx_agent_fleet_assignments_agent ON public.agent_fleet_assignments(agent_id, status);

CREATE TRIGGER update_agent_fleet_assignments_updated_at
BEFORE UPDATE ON public.agent_fleet_assignments
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.agent_ops_assign_company_fleet_bike(
  p_agent_id uuid,
  p_item_name text DEFAULT 'Company Fleet Bike',
  p_plate_number text DEFAULT NULL,
  p_serial_number text DEFAULT NULL,
  p_service_centre_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_exists boolean;
BEGIN
  IF NOT public._agent_products_authorized() THEN
    RAISE EXCEPTION 'Not authorized to assign company fleet assets';
  END IF;
  IF p_agent_id IS NULL THEN
    RAISE EXCEPTION 'Agent is required';
  END IF;
  SELECT true INTO v_exists FROM public.profiles WHERE id = p_agent_id;
  IF NOT COALESCE(v_exists, false) THEN
    RAISE EXCEPTION 'Agent profile not found';
  END IF;

  INSERT INTO public.agent_fleet_assignments (
    agent_id, asset_type, item_name, plate_number, serial_number,
    service_centre_id, notes, assigned_by
  ) VALUES (
    p_agent_id, 'company_fleet_bike',
    COALESCE(NULLIF(TRIM(p_item_name), ''), 'Company Fleet Bike'),
    NULLIF(TRIM(p_plate_number), ''), NULLIF(TRIM(p_serial_number), ''),
    p_service_centre_id, NULLIF(TRIM(p_notes), ''), auth.uid()
  ) RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, new_values)
  VALUES (
    'company_fleet_bike_assigned', 'agent_fleet_assignments', v_id, auth.uid(),
    'Company fleet bike assigned to agent for operational tracking',
    jsonb_build_object('agent_id', p_agent_id, 'plate_number', p_plate_number, 'serial_number', p_serial_number)
  );

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.agent_ops_assign_company_fleet_bike(uuid, text, text, text, uuid, text) TO authenticated;