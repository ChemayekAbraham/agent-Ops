CREATE OR REPLACE FUNCTION public.get_tenant_ops_geo_metrics(p_level text, p_continent text DEFAULT NULL::text, p_country text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_district text DEFAULT NULL::text)
 RETURNS TABLE(key text, label text, agent_id uuid, tenants_total integer, tenants_active integer, tenants_inactive integer, tenants_new_month integer, tenants_prev_month integer, due_today integer, due_tomorrow integer, due_week integer, due_month integer, overdue_count integer, arrears_count integer, paid_early integer, paid_on_time integer, paid_late integer, paid_today numeric, paid_week numeric, paid_month numeric, rent_expected_monthly numeric, rent_collected_month numeric, expected_to_date numeric, collected_to_date numeric, outstanding_total numeric, overdue_amount numeric, advance_amount numeric, avg_rent numeric, expiring_leases integer, ended_leases integer, properties_total integer, occupied_units integer, vacant_units integer, landlords_total integer, landlords_new integer, agents_total integer, agents_active integer, regions_count integer, districts_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  RETURN QUERY
  WITH t AS (
    SELECT * FROM v_tenant_ops_tenant_base b
    WHERE (p_continent IS NULL OR b.continent = p_continent)
      AND (p_country IS NULL OR b.country = p_country)
      AND (p_region IS NULL OR b.region = p_region)
      AND (p_district IS NULL OR b.district = p_district)
  ),
  tk AS (
    SELECT CASE p_level
             WHEN 'continent' THEN t.continent
             WHEN 'country' THEN t.country
             WHEN 'region' THEN t.region
             WHEN 'district' THEN t.district
             ELSE COALESCE(t.agent_id::text, 'unassigned')
           END AS k,
           t.*
    FROM t
  ),
  tagg AS (
    SELECT tk.k,
      count(*)::int AS tenants_total,
      count(*) FILTER (WHERE tk.is_active)::int AS tenants_active,
      count(*) FILTER (WHERE NOT COALESCE(tk.is_active,false))::int AS tenants_inactive,
      count(*) FILTER (WHERE tk.tenant_created_at >= date_trunc('month', v_today))::int AS tenants_new_month,
      count(*) FILTER (WHERE tk.tenant_created_at >= date_trunc('month', v_today) - interval '1 month'
                         AND tk.tenant_created_at <  date_trunc('month', v_today))::int AS tenants_prev_month,
      count(*) FILTER (WHERE tk.next_due_date = v_today)::int AS due_today,
      count(*) FILTER (WHERE tk.next_due_date = v_today + 1)::int AS due_tomorrow,
      count(*) FILTER (WHERE tk.next_due_date BETWEEN v_today AND (date_trunc('week', v_today)::date + 6))::int AS due_week,
      count(*) FILTER (WHERE tk.next_due_date BETWEEN v_today AND (date_trunc('month', v_today)::date + interval '1 month - 1 day')::date)::int AS due_month,
      count(*) FILTER (WHERE tk.next_due_date < v_today AND tk.outstanding > 0)::int AS overdue_count,
      count(*) FILTER (WHERE tk.arrears_amount > 0)::int AS arrears_count,
      count(*) FILTER (WHERE tk.is_active AND tk.schedule_delta_days > 0)::int AS paid_early,
      count(*) FILTER (WHERE tk.is_active AND tk.schedule_delta_days = 0)::int AS paid_on_time,
      count(*) FILTER (WHERE tk.is_active AND tk.schedule_delta_days < 0)::int AS paid_late,
      COALESCE(sum(tk.paid_today),0) AS paid_today,
      COALESCE(sum(tk.paid_week),0) AS paid_week,
      COALESCE(sum(tk.paid_month),0) AS paid_month,
      COALESCE(sum(tk.daily_repayment) FILTER (WHERE tk.is_active),0) * 30 AS rent_expected_monthly,
      COALESCE(sum(tk.expected_to_date),0) AS expected_to_date,
      COALESCE(sum(tk.amount_repaid),0) AS collected_to_date,
      COALESCE(sum(tk.outstanding),0) AS outstanding_total,
      COALESCE(sum(tk.arrears_amount),0) AS overdue_amount,
      COALESCE(sum(tk.advance_amount),0) AS advance_amount,
      COALESCE(avg(NULLIF(tk.rent_amount,0)),0) AS avg_rent,
      count(*) FILTER (WHERE tk.lease_end_date BETWEEN v_today AND v_today + 30)::int AS expiring_leases,
      -- Ended tenancies: explicitly ended OR the rent plan has finished/closed.
      count(*) FILTER (WHERE tk.tenancy_status = 'ended'
                          OR tk.rr_status IN ('completed','closed','ended'))::int AS ended_leases,
      count(DISTINCT tk.region)::int AS regions_count,
      count(DISTINCT tk.district)::int AS districts_count,
      count(DISTINCT tk.agent_id)::int AS agents_total,
      count(DISTINCT tk.agent_id) FILTER (WHERE tk.is_active)::int AS agents_active
    FROM tk GROUP BY tk.k
  ),
  pk AS (
    SELECT CASE p_level
             WHEN 'continent' THEN pb.continent
             WHEN 'country' THEN pb.country
             WHEN 'region' THEN pb.region
             WHEN 'district' THEN pb.district
             ELSE COALESCE(pb.agent_id::text,'unassigned')
           END AS k, pb.*
    FROM v_tenant_ops_property_base pb
    WHERE (p_continent IS NULL OR pb.continent = p_continent)
      AND (p_country IS NULL OR pb.country = p_country)
      AND (p_region IS NULL OR pb.region = p_region)
      AND (p_district IS NULL OR pb.district = p_district)
  ),
  pagg AS (
    SELECT pk.k,
      count(*)::int AS properties_total,
      count(*) FILTER (WHERE pk.is_occupied)::int AS occupied_units,
      count(*) FILTER (WHERE NOT pk.is_occupied)::int AS vacant_units
    FROM pk GROUP BY pk.k
  ),
  lk AS (
    SELECT CASE p_level
             WHEN 'continent' THEN lb.continent
             WHEN 'country' THEN lb.country
             WHEN 'region' THEN lb.region
             WHEN 'district' THEN lb.district
             ELSE COALESCE(lb.agent_id::text,'unassigned')
           END AS k, lb.*
    FROM v_tenant_ops_landlord_base lb
    WHERE (p_continent IS NULL OR lb.continent = p_continent)
      AND (p_country IS NULL OR lb.country = p_country)
      AND (p_region IS NULL OR lb.region = p_region)
      AND (p_district IS NULL OR lb.district = p_district)
  ),
  lagg AS (
    SELECT lk.k,
      count(*)::int AS landlords_total,
      count(*) FILTER (WHERE lk.created_at >= date_trunc('month', v_today))::int AS landlords_new
    FROM lk GROUP BY lk.k
  ),
  keys AS (
    SELECT k FROM tagg UNION SELECT k FROM pagg UNION SELECT k FROM lagg
  ),
  keyed AS (
    SELECT keys.k,
           CASE WHEN p_level = 'agent'
                 AND keys.k ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN keys.k::uuid END AS agent_uuid
    FROM keys
    WHERE keys.k IS NOT NULL
  )
  SELECT
    keyed.k,
    CASE WHEN p_level = 'agent'
         THEN COALESCE(pr.full_name, CASE WHEN keyed.agent_uuid IS NULL THEN '— No agent on file' ELSE 'Unnamed agent' END)
         ELSE keyed.k END,
    keyed.agent_uuid,
    COALESCE(tagg.tenants_total,0), COALESCE(tagg.tenants_active,0), COALESCE(tagg.tenants_inactive,0),
    COALESCE(tagg.tenants_new_month,0), COALESCE(tagg.tenants_prev_month,0),
    COALESCE(tagg.due_today,0), COALESCE(tagg.due_tomorrow,0), COALESCE(tagg.due_week,0), COALESCE(tagg.due_month,0),
    COALESCE(tagg.overdue_count,0), COALESCE(tagg.arrears_count,0),
    COALESCE(tagg.paid_early,0), COALESCE(tagg.paid_on_time,0), COALESCE(tagg.paid_late,0),
    COALESCE(tagg.paid_today,0), COALESCE(tagg.paid_week,0), COALESCE(tagg.paid_month,0),
    COALESCE(tagg.rent_expected_monthly,0), COALESCE(tagg.paid_month,0),
    COALESCE(tagg.expected_to_date,0), COALESCE(tagg.collected_to_date,0),
    COALESCE(tagg.outstanding_total,0), COALESCE(tagg.overdue_amount,0), COALESCE(tagg.advance_amount,0), COALESCE(tagg.avg_rent,0),
    COALESCE(tagg.expiring_leases,0), COALESCE(tagg.ended_leases,0),
    COALESCE(pagg.properties_total,0), COALESCE(pagg.occupied_units,0), COALESCE(pagg.vacant_units,0),
    COALESCE(lagg.landlords_total,0), COALESCE(lagg.landlords_new,0),
    COALESCE(tagg.agents_total,0),
    COALESCE(tagg.agents_active,0),
    COALESCE(tagg.regions_count,0), COALESCE(tagg.districts_count,0)
  FROM keyed
  LEFT JOIN tagg ON tagg.k = keyed.k
  LEFT JOIN pagg ON pagg.k = keyed.k
  LEFT JOIN lagg ON lagg.k = keyed.k
  LEFT JOIN profiles pr ON pr.id = keyed.agent_uuid
  ORDER BY COALESCE(tagg.tenants_total,0) DESC, keyed.k;
END;
$function$;