CREATE OR REPLACE FUNCTION public.am_new_tenant_first7(p_paid_on date DEFAULT NULL)
RETURNS TABLE(rent_request_id uuid, tenant_name text, tenant_phone text, agent_name text,
  landlord_paid_on date, clock_start date, daily_due numeric, total_repayment numeric,
  day_paid numeric[], paid_7d numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_paid_on date := COALESCE(p_paid_on, (now() AT TIME ZONE 'Africa/Kampala')::date - 1);
  v_ids uuid[];
BEGIN
  IF auth.uid() IS NULL OR NOT public._am_staff_ok() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT array_agg(id) INTO v_ids FROM public.rent_requests
   WHERE status IN ('funded','repaying','completed');
  IF v_ids IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH clk AS (
    SELECT * FROM public._am_plan_clock_core(v_ids) k
     WHERE k.last_landlord_paid_on = v_paid_on
       AND k.bucket IN ('counting','outstanding_balance')
  ),
  days AS (
    SELECT k.rent_request_id AS rid, d AS dn
      FROM clk k CROSS JOIN generate_series(1,7) d
  ),
  coll AS (
    SELECT ac.rent_request_id AS rid,
           ((ac.created_at AT TIME ZONE 'Africa/Kampala')::date - v_paid_on) AS dn,
           sum(ac.amount) AS amt
      FROM public.agent_collections ac
     WHERE ac.rent_request_id IN (SELECT k.rent_request_id FROM clk k)
       AND ac.reversed_at IS NULL
       AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_paid_on + 1 AND v_paid_on + 7
     GROUP BY 1,2
  ),
  agg AS (
    SELECT d.rid, array_agg(COALESCE(c.amt,0) ORDER BY d.dn) AS arr, COALESCE(sum(c.amt),0) AS tot
      FROM days d LEFT JOIN coll c ON c.rid = d.rid AND c.dn = d.dn
     GROUP BY d.rid
  )
  SELECT k.rent_request_id, tp.full_name, tp.phone, ap.full_name,
         k.last_landlord_paid_on, k.clock_start,
         COALESCE(rr.daily_repayment,0), COALESCE(rr.total_repayment,0),
         a.arr, a.tot
    FROM clk k
    JOIN public.rent_requests rr ON rr.id = k.rent_request_id
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = rr.agent_id
    JOIN agg a ON a.rid = k.rent_request_id
   ORDER BY ap.full_name NULLS LAST, tp.full_name;
END $$;
REVOKE ALL ON FUNCTION public.am_new_tenant_first7(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.am_new_tenant_first7(date) TO authenticated;