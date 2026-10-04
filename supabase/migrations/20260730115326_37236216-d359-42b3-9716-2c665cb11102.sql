-- 1. Country -> continent mapping helper
CREATE OR REPLACE FUNCTION public.continent_for_country(p_country text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_country IS NULL OR btrim(p_country) = '' THEN 'Africa'
    WHEN lower(btrim(p_country)) IN (
      'uganda','kenya','tanzania','rwanda','burundi','south sudan','ethiopia','eritrea','djibouti',
      'somalia','sudan','madagascar','mauritius','seychelles','comoros','malawi','zambia','zimbabwe',
      'mozambique','nigeria','ghana','senegal','ivory coast','cote d''ivoire','mali','burkina faso',
      'benin','togo','guinea','guinea-bissau','sierra leone','liberia','gambia','mauritania','niger',
      'cape verde','cabo verde','south africa','namibia','botswana','lesotho','eswatini','swaziland',
      'angola','egypt','libya','tunisia','algeria','morocco','western sahara','dr congo',
      'democratic republic of the congo','congo','republic of the congo','cameroon',
      'central african republic','chad','gabon','equatorial guinea','sao tome and principe'
    ) THEN 'Africa'
    WHEN lower(btrim(p_country)) IN (
      'united states','usa','united states of america','canada','mexico','panama','costa rica',
      'jamaica','cuba','haiti','dominican republic','guatemala','honduras','nicaragua','belize'
    ) THEN 'North America'
    WHEN lower(btrim(p_country)) IN (
      'brazil','argentina','chile','peru','colombia','venezuela','ecuador','bolivia','paraguay','uruguay','guyana','suriname'
    ) THEN 'South America'
    WHEN lower(btrim(p_country)) IN (
      'united kingdom','uk','england','scotland','wales','ireland','france','germany','spain','portugal',
      'italy','netherlands','belgium','sweden','norway','denmark','finland','poland','switzerland','austria',
      'greece','romania','ukraine','russia','czech republic','hungary'
    ) THEN 'Europe'
    WHEN lower(btrim(p_country)) IN (
      'china','india','japan','south korea','indonesia','philippines','vietnam','thailand','malaysia',
      'singapore','pakistan','bangladesh','sri lanka','nepal','united arab emirates','uae','saudi arabia',
      'qatar','kuwait','oman','israel','turkey','iran','iraq','jordan','lebanon'
    ) THEN 'Asia'
    WHEN lower(btrim(p_country)) IN ('australia','new zealand','fiji','papua new guinea','samoa','tonga') THEN 'Oceania'
    ELSE 'Africa'
  END;
$$;

-- 2. Tenant base view: one row per tenant with location, rent plan, payment and arrears facts
CREATE OR REPLACE VIEW public.v_tenant_ops_tenant_base AS
WITH latest_rr AS (
  SELECT DISTINCT ON (rr.tenant_id)
    rr.tenant_id, rr.id AS rent_request_id, rr.agent_id, rr.landlord_id, rr.status,
    rr.registration_type, rr.rent_amount, rr.total_repayment, rr.amount_repaid,
    rr.daily_repayment, rr.duration_days, rr.funded_at, rr.created_at AS rr_created_at,
    rr.tenancy_status, rr.agent_payment_status, rr.house_listing_id
  FROM rent_requests rr
  WHERE rr.tenant_id IS NOT NULL
    AND rr.status NOT IN ('rejected','deleted_by_agent')
  ORDER BY rr.tenant_id, rr.created_at DESC
),
pay AS (
  SELECT r.tenant_id,
    max(r.created_at) AS last_payment_at,
    sum(r.amount) AS lifetime_paid,
    sum(r.amount) FILTER (WHERE (r.created_at AT TIME ZONE 'Africa/Kampala')::date = (now() AT TIME ZONE 'Africa/Kampala')::date) AS paid_today,
    sum(r.amount) FILTER (WHERE (r.created_at AT TIME ZONE 'Africa/Kampala')::date >= date_trunc('week', (now() AT TIME ZONE 'Africa/Kampala')::date)::date) AS paid_week,
    sum(r.amount) FILTER (WHERE (r.created_at AT TIME ZONE 'Africa/Kampala')::date >= date_trunc('month', (now() AT TIME ZONE 'Africa/Kampala')::date)::date) AS paid_month,
    sum(r.amount) FILTER (WHERE (r.created_at AT TIME ZONE 'Africa/Kampala')::date >= date_trunc('quarter', (now() AT TIME ZONE 'Africa/Kampala')::date)::date) AS paid_quarter,
    sum(r.amount) FILTER (WHERE (r.created_at AT TIME ZONE 'Africa/Kampala')::date >= date_trunc('year', (now() AT TIME ZONE 'Africa/Kampala')::date)::date) AS paid_year
  FROM repayments r
  GROUP BY r.tenant_id
)
SELECT
  b.*,
  GREATEST(b.total_repayment - b.amount_repaid, 0) AS outstanding,
  GREATEST(b.expected_to_date - b.amount_repaid, 0) AS arrears_amount,
  GREATEST(b.amount_repaid - b.expected_to_date, 0) AS advance_amount,
  CASE WHEN b.daily_repayment > 0
       THEN floor(b.amount_repaid / b.daily_repayment)::int - b.days_since_funded
       ELSE NULL END AS schedule_delta_days,
  CASE WHEN b.daily_repayment > 0 AND b.funded_date IS NOT NULL AND (b.total_repayment - b.amount_repaid) > 0
       THEN b.funded_date + (floor(b.amount_repaid / b.daily_repayment)::int + 1)
       ELSE NULL END AS next_due_date,
  CASE WHEN b.funded_date IS NOT NULL AND b.duration_days IS NOT NULL
       THEN b.funded_date + b.duration_days
       ELSE NULL END AS lease_end_date
FROM (
  SELECT
    t.tenant_id, t.tenant_name, t.tenant_phone, t.tenant_avatar_url, t.tenant_created_at,
    public.continent_for_country(t.country) AS continent,
    t.country, t.region, t.district, t.ward,
    COALESCE(lr.agent_id, t.agent_id) AS agent_id,
    COALESCE(lr.landlord_id, t.landlord_id) AS landlord_id,
    lr.rent_request_id, lr.status AS rr_status, lr.registration_type,
    lr.tenancy_status, lr.agent_payment_status, lr.house_listing_id, lr.duration_days,
    COALESCE(lr.rent_amount, 0)::numeric AS rent_amount,
    COALESCE(lr.total_repayment, 0)::numeric AS total_repayment,
    COALESCE(lr.amount_repaid, 0)::numeric AS amount_repaid,
    COALESCE(lr.daily_repayment, 0)::numeric AS daily_repayment,
    lr.funded_at,
    (lr.funded_at AT TIME ZONE 'Africa/Kampala')::date AS funded_date,
    GREATEST(
      COALESCE((now() AT TIME ZONE 'Africa/Kampala')::date - (lr.funded_at AT TIME ZONE 'Africa/Kampala')::date, 0),
      0
    ) AS days_since_funded,
    CASE
      WHEN lr.funded_at IS NULL OR COALESCE(lr.daily_repayment,0) <= 0 THEN 0::numeric
      ELSE LEAST(
        COALESCE(lr.total_repayment,0),
        lr.daily_repayment * GREATEST((now() AT TIME ZONE 'Africa/Kampala')::date - (lr.funded_at AT TIME ZONE 'Africa/Kampala')::date, 0)
      )
    END AS expected_to_date,
    (lr.status IN ('funded','repaying') AND COALESCE(lr.agent_payment_status,'paying') <> 'not_paying') AS is_active,
    p.last_payment_at,
    COALESCE(p.lifetime_paid,0)::numeric AS lifetime_paid,
    COALESCE(p.paid_today,0)::numeric AS paid_today,
    COALESCE(p.paid_week,0)::numeric AS paid_week,
    COALESCE(p.paid_month,0)::numeric AS paid_month,
    COALESCE(p.paid_quarter,0)::numeric AS paid_quarter,
    COALESCE(p.paid_year,0)::numeric AS paid_year
  FROM v_tenant_location_pivot t
  LEFT JOIN latest_rr lr ON lr.tenant_id = t.tenant_id
  LEFT JOIN pay p ON p.tenant_id = t.tenant_id
) b;

-- 3. Property base view
CREATE OR REPLACE VIEW public.v_tenant_ops_property_base AS
SELECT
  h.id AS listing_id,
  h.agent_id,
  h.landlord_id,
  h.tenant_id,
  h.status,
  h.is_hidden,
  h.verified,
  COALESCE(h.monthly_rent,0)::numeric AS monthly_rent,
  h.created_at,
  public.continent_for_country(COALESCE(NULLIF(l.country,''),'Uganda')) AS continent,
  COALESCE(NULLIF(l.country,''),'Uganda') AS country,
  COALESCE(NULLIF(h.region,''), NULLIF(l.region,''), 'Central') AS region,
  COALESCE(NULLIF(h.district,''), NULLIF(l.district,''), 'Kampala') AS district,
  (h.tenant_id IS NOT NULL OR h.status = 'occupied') AS is_occupied
FROM house_listings h
LEFT JOIN landlords l ON l.id = h.landlord_id
WHERE h.status <> 'rejected';

-- 4. Landlord base view
CREATE OR REPLACE VIEW public.v_tenant_ops_landlord_base AS
SELECT
  l.id AS landlord_id,
  l.name AS landlord_name,
  l.phone,
  l.verified,
  l.created_at,
  l.managed_by_agent_id AS agent_id,
  COALESCE(l.monthly_rent,0)::numeric AS monthly_rent,
  public.continent_for_country(COALESCE(NULLIF(l.country,''),'Uganda')) AS continent,
  COALESCE(NULLIF(l.country,''),'Uganda') AS country,
  COALESCE(NULLIF(l.region,''),'Central') AS region,
  COALESCE(NULLIF(l.district,''),'Kampala') AS district
FROM landlords l;

REVOKE ALL ON public.v_tenant_ops_tenant_base FROM anon, authenticated;
REVOKE ALL ON public.v_tenant_ops_property_base FROM anon, authenticated;
REVOKE ALL ON public.v_tenant_ops_landlord_base FROM anon, authenticated;

-- 5. Geographic drill-down metrics
CREATE OR REPLACE FUNCTION public.get_tenant_ops_geo_metrics(
  p_level text,
  p_continent text DEFAULT NULL,
  p_country text DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL
)
RETURNS TABLE(
  key text, label text, agent_id uuid,
  tenants_total int, tenants_active int, tenants_inactive int,
  tenants_new_month int, tenants_prev_month int,
  due_today int, due_tomorrow int, due_week int, due_month int,
  overdue_count int, arrears_count int,
  paid_early int, paid_on_time int, paid_late int,
  paid_today numeric, paid_week numeric, paid_month numeric,
  rent_expected_monthly numeric, rent_collected_month numeric,
  expected_to_date numeric, collected_to_date numeric,
  outstanding_total numeric, overdue_amount numeric, advance_amount numeric, avg_rent numeric,
  expiring_leases int, ended_leases int,
  properties_total int, occupied_units int, vacant_units int,
  landlords_total int, landlords_new int,
  agents_total int, agents_active int,
  regions_count int, districts_count int
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
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
      count(*) FILTER (WHERE tk.tenancy_status = 'ended')::int AS ended_leases,
      count(DISTINCT tk.region)::int AS regions_count,
      count(DISTINCT tk.district)::int AS districts_count,
      count(DISTINCT tk.agent_id)::int AS agents_total
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
  )
  SELECT
    keys.k,
    CASE WHEN p_level = 'agent'
         THEN COALESCE(pr.full_name, CASE WHEN keys.k = 'unassigned' THEN '— No agent on file' ELSE 'Unnamed agent' END)
         ELSE keys.k END,
    CASE WHEN p_level = 'agent' AND keys.k <> 'unassigned' THEN keys.k::uuid ELSE NULL END,
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
    COALESCE(tagg.agents_total,0),
    COALESCE(tagg.regions_count,0), COALESCE(tagg.districts_count,0)
  FROM keys
  LEFT JOIN tagg ON tagg.k = keys.k
  LEFT JOIN pagg ON pagg.k = keys.k
  LEFT JOIN lagg ON lagg.k = keys.k
  LEFT JOIN profiles pr ON p_level = 'agent' AND keys.k <> 'unassigned' AND pr.id = keys.k::uuid
  WHERE keys.k IS NOT NULL
  ORDER BY COALESCE(tagg.tenants_total,0) DESC, keys.k;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_ops_geo_metrics(text,text,text,text,text) TO authenticated;

-- 6. Agent 360
CREATE OR REPLACE FUNCTION public.get_tenant_ops_agent_360(p_agent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  SELECT jsonb_build_object(
    'profile', (
      SELECT jsonb_build_object(
        'id', pr.id, 'full_name', pr.full_name, 'phone', pr.phone, 'email', pr.email,
        'avatar_url', pr.avatar_url, 'created_at', pr.created_at,
        'country', pr.country, 'region', pr.region, 'district', pr.district, 'ward', pr.sub_county
      ) FROM profiles pr WHERE pr.id = p_agent_id
    ),
    'tenants', (
      SELECT jsonb_build_object(
        'total', count(*),
        'active', count(*) FILTER (WHERE b.is_active),
        'inactive', count(*) FILTER (WHERE NOT COALESCE(b.is_active,false)),
        'new_month', count(*) FILTER (WHERE b.tenant_created_at >= date_trunc('month', v_today)),
        'due_today', count(*) FILTER (WHERE b.next_due_date = v_today),
        'due_tomorrow', count(*) FILTER (WHERE b.next_due_date = v_today + 1),
        'due_week', count(*) FILTER (WHERE b.next_due_date BETWEEN v_today AND date_trunc('week', v_today)::date + 6),
        'due_month', count(*) FILTER (WHERE b.next_due_date BETWEEN v_today AND (date_trunc('month', v_today) + interval '1 month - 1 day')::date),
        'overdue', count(*) FILTER (WHERE b.next_due_date < v_today AND b.outstanding > 0),
        'arrears', count(*) FILTER (WHERE b.arrears_amount > 0),
        'paid_early', count(*) FILTER (WHERE b.is_active AND b.schedule_delta_days > 0),
        'paid_on_time', count(*) FILTER (WHERE b.is_active AND b.schedule_delta_days = 0),
        'paid_late', count(*) FILTER (WHERE b.is_active AND b.schedule_delta_days < 0),
        'expiring_leases', count(*) FILTER (WHERE b.lease_end_date BETWEEN v_today AND v_today + 30),
        'ended_leases', count(*) FILTER (WHERE b.tenancy_status = 'ended'),
        'high_risk', count(*) FILTER (WHERE b.daily_repayment > 0 AND b.arrears_amount >= b.daily_repayment * 14),
        'medium_risk', count(*) FILTER (WHERE b.daily_repayment > 0 AND b.arrears_amount >= b.daily_repayment * 5 AND b.arrears_amount < b.daily_repayment * 14),
        'low_risk', count(*) FILTER (WHERE COALESCE(b.arrears_amount,0) < COALESCE(b.daily_repayment,0) * 5),
        'exposure_at_risk', COALESCE(sum(b.outstanding) FILTER (WHERE b.daily_repayment > 0 AND b.arrears_amount >= b.daily_repayment * 5), 0)
      ) FROM v_tenant_ops_tenant_base b WHERE b.agent_id = p_agent_id
    ),
    'financials', (
      SELECT jsonb_build_object(
        'portfolio_value', COALESCE(sum(b.total_repayment),0),
        'rent_expected_monthly', COALESCE(sum(b.daily_repayment) FILTER (WHERE b.is_active),0) * 30,
        'expected_to_date', COALESCE(sum(b.expected_to_date),0),
        'collected_to_date', COALESCE(sum(b.amount_repaid),0),
        'outstanding', COALESCE(sum(b.outstanding),0),
        'arrears', COALESCE(sum(b.arrears_amount),0),
        'advances', COALESCE(sum(b.advance_amount),0),
        'paid_today', COALESCE(sum(b.paid_today),0),
        'paid_week', COALESCE(sum(b.paid_week),0),
        'paid_month', COALESCE(sum(b.paid_month),0),
        'paid_quarter', COALESCE(sum(b.paid_quarter),0),
        'paid_year', COALESCE(sum(b.paid_year),0),
        'avg_rent', COALESCE(avg(NULLIF(b.rent_amount,0)),0)
      ) FROM v_tenant_ops_tenant_base b WHERE b.agent_id = p_agent_id
    ),
    'properties', (
      SELECT jsonb_build_object(
        'total', count(*),
        'occupied', count(*) FILTER (WHERE pb.is_occupied),
        'vacant', count(*) FILTER (WHERE NOT pb.is_occupied),
        'portfolio_rent', COALESCE(sum(pb.monthly_rent),0),
        'avg_rent', COALESCE(avg(NULLIF(pb.monthly_rent,0)),0),
        'new_month', count(*) FILTER (WHERE pb.created_at >= date_trunc('month', v_today))
      ) FROM v_tenant_ops_property_base pb WHERE pb.agent_id = p_agent_id
    ),
    'landlords', (
      SELECT jsonb_build_object(
        'total', count(*),
        'verified', count(*) FILTER (WHERE lb.verified),
        'new_month', count(*) FILTER (WHERE lb.created_at >= date_trunc('month', v_today))
      ) FROM v_tenant_ops_landlord_base lb WHERE lb.agent_id = p_agent_id
    ),
    'collections', (
      SELECT jsonb_build_object(
        'today', COALESCE(sum(ac.amount) FILTER (WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date = v_today),0),
        'week', COALESCE(sum(ac.amount) FILTER (WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date >= date_trunc('week', v_today)::date),0),
        'month', COALESCE(sum(ac.amount) FILTER (WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date >= date_trunc('month', v_today)::date),0),
        'quarter', COALESCE(sum(ac.amount) FILTER (WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date >= date_trunc('quarter', v_today)::date),0),
        'year', COALESCE(sum(ac.amount) FILTER (WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date >= date_trunc('year', v_today)::date),0),
        'count_month', count(*) FILTER (WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date >= date_trunc('month', v_today)::date)
      ) FROM agent_collections ac WHERE ac.agent_id = p_agent_id
    ),
    'commissions', (
      SELECT jsonb_build_object(
        'earned', COALESCE(sum(c.amount),0),
        'paid', COALESCE(sum(c.amount) FILTER (WHERE c.status = 'paid'),0),
        'pending', COALESCE(sum(c.amount) FILTER (WHERE c.status IN ('pending','approved')),0),
        'count', count(*)
      ) FROM commission_accrual_ledger c WHERE c.agent_id = p_agent_id
    ),
    'wallet', (
      SELECT jsonb_build_object(
        'balance', COALESCE(w.balance,0),
        'withdrawable', COALESCE(w.withdrawable_balance,0),
        'float', COALESCE(w.float_balance,0),
        'advance', COALESCE(w.advance_balance,0)
      ) FROM wallets w WHERE w.user_id = p_agent_id
    ),
    'withdrawals', (
      SELECT jsonb_build_object(
        'total', COALESCE(sum(wr.amount),0),
        'completed', COALESCE(sum(wr.amount) FILTER (WHERE wr.status = 'completed'),0),
        'pending', COALESCE(sum(wr.amount) FILTER (WHERE wr.status NOT IN ('completed','rejected','failed')),0),
        'failed', COALESCE(sum(wr.amount) FILTER (WHERE wr.status IN ('rejected','failed')),0),
        'count', count(*)
      ) FROM withdrawal_requests wr WHERE wr.user_id = p_agent_id
    ),
    'tenant_list', (
      SELECT COALESCE(jsonb_agg(x ORDER BY x->>'tenant_name'), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
          'tenant_id', b.tenant_id, 'tenant_name', b.tenant_name, 'phone', b.tenant_phone,
          'district', b.district, 'region', b.region,
          'rent_amount', b.rent_amount, 'total_repayment', b.total_repayment,
          'amount_repaid', b.amount_repaid, 'outstanding', b.outstanding,
          'arrears', b.arrears_amount, 'advance', b.advance_amount,
          'daily_repayment', b.daily_repayment, 'next_due_date', b.next_due_date,
          'lease_end_date', b.lease_end_date, 'status', b.rr_status,
          'schedule_delta_days', b.schedule_delta_days, 'last_payment_at', b.last_payment_at,
          'is_active', b.is_active
        ) AS x
        FROM v_tenant_ops_tenant_base b WHERE b.agent_id = p_agent_id LIMIT 500
      ) s
    ),
    'landlord_list', (
      SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
          'landlord_id', lb.landlord_id, 'name', lb.landlord_name, 'phone', lb.phone,
          'verified', lb.verified, 'district', lb.district, 'monthly_rent', lb.monthly_rent
        ) AS x
        FROM v_tenant_ops_landlord_base lb WHERE lb.agent_id = p_agent_id LIMIT 300
      ) s
    ),
    'property_list', (
      SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
          'listing_id', pb.listing_id, 'district', pb.district, 'region', pb.region,
          'monthly_rent', pb.monthly_rent, 'occupied', pb.is_occupied,
          'verified', pb.verified, 'status', pb.status
        ) AS x
        FROM v_tenant_ops_property_base pb WHERE pb.agent_id = p_agent_id LIMIT 300
      ) s
    ),
    'collection_trend', (
      SELECT COALESCE(jsonb_agg(x ORDER BY x->>'day'), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
          'day', d.day,
          'collected', COALESCE((SELECT sum(ac.amount) FROM agent_collections ac
             WHERE ac.agent_id = p_agent_id
               AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date = d.day), 0)
        ) AS x
        FROM generate_series(v_today - 29, v_today, interval '1 day') AS g(day)
        CROSS JOIN LATERAL (SELECT g.day::date AS day) d
      ) s
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_ops_agent_360(uuid) TO authenticated;