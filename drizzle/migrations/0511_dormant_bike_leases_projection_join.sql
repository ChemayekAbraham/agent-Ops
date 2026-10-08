-- agent_ops_dormant_bike_leases: read agent wallet buckets from the indexed
-- stored projection (unique index on user_id) instead of v_user_wallet_strict,
-- which rescans general_ledger on every request.
CREATE OR REPLACE FUNCTION public.agent_ops_dormant_bike_leases()
 RETURNS TABLE(lease_id uuid, agent_id uuid, agent_name text, agent_phone text, bike_model text, last_repayment_at timestamp with time zone, days_since_last_repayment integer, amount_outstanding numeric, withdrawable numeric, float_balance numeric, wallet_zero boolean, service_centre text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._has_enabled_role(auth.uid(), ARRAY['agent_ops','manager','coo','ceo','cfo','super_admin']) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  RETURN QUERY
  SELECT d.lease_id, d.agent_id, d.agent_name, d.agent_phone, d.bike_model,
    d.last_deduction_at, d.days_since_last_deduction, d.amount_outstanding,
    COALESCE(w.withdrawable,0), COALESCE(w.float_balance,0),
    (COALESCE(w.withdrawable,0) + COALESCE(w.float_balance,0)) <= 0,
    (SELECT s.location_name FROM service_centre_agent_assignments a
       JOIN service_centre_setups s ON s.id = a.service_centre_id
      WHERE a.agent_id = d.agent_id AND a.status = 'active'
      ORDER BY a.assigned_at DESC LIMIT 1)
  FROM public._dormant_bike_leases(NULL) d
  LEFT JOIN wallet_balances_projection w ON w.user_id = d.agent_id
  WHERE d.days_since_last_deduction >= 7
     OR (COALESCE(w.withdrawable,0) + COALESCE(w.float_balance,0)) <= 0
  ORDER BY d.days_since_last_deduction DESC;
END $function$;

REVOKE ALL ON FUNCTION public.agent_ops_dormant_bike_leases() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_ops_dormant_bike_leases() TO authenticated;
