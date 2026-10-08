CREATE OR REPLACE FUNCTION public.update_bike_lease_asset(p_lease_id uuid, p_details jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_old public.agent_bike_leases; v_new public.agent_bike_leases; v_log text;
  v_is_supplier boolean; v_touches_ids boolean;
BEGIN
  SELECT * INTO v_old FROM public.agent_bike_leases WHERE id = p_lease_id FOR UPDATE;
  IF v_old.id IS NULL THEN RAISE EXCEPTION 'Bike lease not found'; END IF;
  SELECT EXISTS (SELECT 1 FROM public.merchandise_sales s WHERE s.id = v_old.sale_id AND s.supplier_id = v_uid) INTO v_is_supplier;
  IF NOT (public.can_review_bike_leases(v_uid) OR (v_is_supplier AND v_old.cfo_disbursed_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'Not authorized to edit bike lease details';
  END IF;
  v_touches_ids := (p_details ? 'plate_number' AND COALESCE(btrim(p_details->>'plate_number'),'') <> COALESCE(v_old.plate_number,''))
    OR (p_details ? 'chassis_number' AND COALESCE(btrim(p_details->>'chassis_number'),'') <> COALESCE(v_old.chassis_number,''))
    OR (p_details ? 'battery_serial' AND COALESCE(btrim(p_details->>'battery_serial'),'') <> COALESCE(v_old.battery_serial,''));
  IF v_touches_ids AND v_old.cfo_disbursed_at IS NULL THEN
    RAISE EXCEPTION 'Plate, chassis and battery serial can only be recorded after the CFO has disbursed funds for this bike';
  END IF;
  -- Suppliers may only record the three asset identifiers, not logbook custody or GPS
  IF NOT public.can_review_bike_leases(v_uid) THEN
    p_details := p_details - 'logbook_status' - 'gps_tracker_id';
  END IF;
  v_log := NULLIF(btrim(p_details->>'logbook_status'),'');
  UPDATE public.agent_bike_leases SET
    battery_serial = CASE WHEN p_details ? 'battery_serial' THEN NULLIF(btrim(p_details->>'battery_serial'),'') ELSE battery_serial END,
    chassis_number = CASE WHEN p_details ? 'chassis_number' THEN NULLIF(btrim(p_details->>'chassis_number'),'') ELSE chassis_number END,
    gps_tracker_id = CASE WHEN p_details ? 'gps_tracker_id' THEN NULLIF(btrim(p_details->>'gps_tracker_id'),'') ELSE gps_tracker_id END,
    plate_number = CASE WHEN p_details ? 'plate_number' THEN NULLIF(upper(btrim(p_details->>'plate_number')),'') ELSE plate_number END,
    logbook_status = COALESCE(v_log, logbook_status),
    logbook_updated_at = CASE WHEN v_log IS NOT NULL AND v_log <> logbook_status THEN now() ELSE logbook_updated_at END,
    logbook_updated_by = CASE WHEN v_log IS NOT NULL AND v_log <> logbook_status THEN v_uid ELSE logbook_updated_by END,
    updated_at = now()
  WHERE id = p_lease_id RETURNING * INTO v_new;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
  VALUES (v_uid, 'bike_lease_asset_updated', 'agent_bike_leases', p_lease_id,
    CASE WHEN v_is_supplier AND NOT public.can_review_bike_leases(v_uid) THEN 'Bike asset details recorded by assigned supplier' ELSE 'Bike lease asset details or logbook custody updated' END,
    jsonb_build_object('battery_serial',v_old.battery_serial,'chassis_number',v_old.chassis_number,'gps_tracker_id',v_old.gps_tracker_id,'plate_number',v_old.plate_number,'logbook_status',v_old.logbook_status),
    jsonb_build_object('battery_serial',v_new.battery_serial,'chassis_number',v_new.chassis_number,'gps_tracker_id',v_new.gps_tracker_id,'plate_number',v_new.plate_number,'logbook_status',v_new.logbook_status));
  RETURN to_jsonb(v_new);
END $function$;

CREATE OR REPLACE FUNCTION public.get_my_overdue_bike_asset_details()
 RETURNS TABLE(lease_id uuid, agent_name text, brand text, model text, tracking_reference text,
   cfo_disbursed_at timestamptz, plate_number text, chassis_number text, battery_serial text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT l.id, l.agent_name, l.brand, l.model, l.tracking_reference, l.cfo_disbursed_at,
         l.plate_number, l.chassis_number, l.battery_serial
  FROM public.agent_bike_leases l
  JOIN public.merchandise_sales s ON s.id = l.sale_id
  WHERE s.supplier_id = auth.uid()
    AND l.cfo_disbursed_at IS NOT NULL
    AND l.cfo_disbursed_at <= now() - interval '72 hours'
    AND (l.plate_number IS NULL OR l.chassis_number IS NULL OR l.battery_serial IS NULL)
  ORDER BY l.cfo_disbursed_at;
$$;
REVOKE ALL ON FUNCTION public.get_my_overdue_bike_asset_details() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_my_overdue_bike_asset_details() TO authenticated;