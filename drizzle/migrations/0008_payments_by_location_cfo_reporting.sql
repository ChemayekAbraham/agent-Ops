-- Read-only CFO reporting: rent payment activity grouped by the approved Uganda
-- location hierarchy (country -> region -> district -> sub-county -> village).
-- Source is agent_collections (non-reversed). Both functions are STABLE, read-only,
-- and change no payment, wallet, ledger or accounting logic.

CREATE OR REPLACE FUNCTION public.get_payments_location_breakdown(
  p_level         text    DEFAULT 'country',
  p_country       text    DEFAULT NULL,
  p_region        text    DEFAULT NULL,
  p_district_id   integer DEFAULT NULL,
  p_subcounty_id  integer DEFAULT NULL,
  p_from          date    DEFAULT NULL,
  p_to            date    DEFAULT NULL,
  p_method        text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_level text := lower(coalesce(p_level, 'country'));
  v_out   jsonb;
BEGIN
  PERFORM receivables_guard();

  IF v_level NOT IN ('country', 'region', 'district', 'subcounty', 'village') THEN
    RAISE EXCEPTION 'Unsupported level %. Use country, region, district, subcounty or village.', p_level;
  END IF;

  WITH scope AS (
    SELECT
      c.id,
      c.tenant_id,
      c.agent_id,
      round(coalesce(c.amount, 0), 2) AS amount,
      c.created_at,
      coalesce(c.payment_method::text, 'unknown') AS method,
      (vg.village_id IS NOT NULL OR da.district_id IS NOT NULL) AS is_mapped,
      CASE WHEN (vg.village_id IS NOT NULL OR da.district_id IS NOT NULL)
           THEN 'Uganda' ELSE 'Unmapped' END AS country,
      coalesce(vg.region,         da.region,         'Unmapped') AS region,
      coalesce(vg.district_name,  da.district_name,  'Unmapped') AS district,
      coalesce(vg.district_id,    da.district_id)                AS district_id,
      coalesce(vg.subcounty_name, sa.subcounty_name, nullif(p.town, ''), nullif(p.sub_county, ''), 'Unmapped') AS subcounty,
      coalesce(vg.subcounty_id,   sa.subcounty_id)               AS subcounty_id,
      coalesce(vg.village_name,   nullif(p.village, ''), 'Unmapped') AS village
    FROM agent_collections c
    LEFT JOIN profiles p ON p.id = c.tenant_id
    LEFT JOIN mv_ug_village_geo vg ON vg.village_id = p.ug_village_id
    LEFT JOIN mv_ug_district_alias da
           ON p.ug_village_id IS NULL
          AND da.norm_key = ug_norm_name(nullif(p.district, ''))
    LEFT JOIN mv_ug_subcounty_alias sa
           ON p.ug_village_id IS NULL
          AND sa.district_id = da.district_id
          AND sa.norm_key = ug_norm_name(nullif(p.sub_county, ''))
    WHERE c.reversed_at IS NULL
      AND coalesce(c.amount, 0) > 0
      AND (p_from IS NULL OR (c.created_at AT TIME ZONE 'Africa/Nairobi')::date >= p_from)
      AND (p_to   IS NULL OR (c.created_at AT TIME ZONE 'Africa/Nairobi')::date <= p_to)
      AND (p_method IS NULL OR coalesce(c.payment_method::text, 'unknown') = p_method)
  ), filtered AS (
    SELECT s.* FROM scope s
    WHERE (p_country IS NULL OR s.country = p_country)
      AND (p_region IS NULL OR s.region = p_region)
      AND (p_district_id IS NULL OR s.district_id = p_district_id)
      AND (p_subcounty_id IS NULL OR s.subcounty_id = p_subcounty_id)
  ), keyed AS (
    SELECT f.*,
      CASE v_level
        WHEN 'country'   THEN f.country
        WHEN 'region'    THEN f.region
        WHEN 'district'  THEN f.district
        WHEN 'subcounty' THEN f.subcounty
        ELSE f.village
      END AS group_label
    FROM filtered f
  ), grouped AS (
    SELECT
      k.group_label,
      max(k.country)      AS country,
      max(k.region)       AS region,
      max(k.district)     AS district,
      max(k.district_id)  AS district_id,
      max(k.subcounty_id) AS subcounty_id,
      round(sum(k.amount), 2)      AS amount,
      count(*)                     AS payment_count,
      count(DISTINCT k.tenant_id)  AS tenant_count,
      count(DISTINCT k.agent_id)   AS agent_count,
      min(k.created_at)            AS first_payment_at,
      max(k.created_at)            AS last_payment_at,
      bool_and(k.is_mapped)        AS fully_mapped
    FROM keyed k
    GROUP BY k.group_label
  ), methods AS (
    SELECT jsonb_agg(m ORDER BY (m->>'amount')::numeric DESC) AS list
    FROM (
      SELECT jsonb_build_object(
               'method', k.method,
               'amount', round(sum(k.amount), 2),
               'payment_count', count(*)
             ) AS m
      FROM keyed k
      GROUP BY k.method
    ) x
  ), daily AS (
    SELECT jsonb_agg(d ORDER BY d->>'date') AS list
    FROM (
      SELECT jsonb_build_object(
               'date', (k.created_at AT TIME ZONE 'Africa/Nairobi')::date,
               'amount', round(sum(k.amount), 2),
               'payment_count', count(*)
             ) AS d
      FROM keyed k
      GROUP BY (k.created_at AT TIME ZONE 'Africa/Nairobi')::date
    ) y
  )
  SELECT jsonb_build_object(
    'currency', 'UGX',
    'as_at', now(),
    'level', v_level,
    'from', p_from,
    'to', p_to,
    'total', coalesce((SELECT round(sum(amount), 2) FROM keyed), 0),
    'payment_count', (SELECT count(*) FROM keyed),
    'tenant_count', (SELECT count(DISTINCT tenant_id) FROM keyed),
    'located_amount', coalesce((SELECT round(sum(amount), 2) FROM keyed WHERE is_mapped), 0),
    'unmapped_amount', coalesce((SELECT round(sum(amount), 2) FROM keyed WHERE NOT is_mapped), 0),
    'methods', coalesce((SELECT list FROM methods), '[]'::jsonb),
    'daily', coalesce((SELECT list FROM daily), '[]'::jsonb),
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'label', g.group_label,
        'country', g.country,
        'region', g.region,
        'district', g.district,
        'district_id', g.district_id,
        'subcounty_id', g.subcounty_id,
        'amount', g.amount,
        'payment_count', g.payment_count,
        'tenant_count', g.tenant_count,
        'agent_count', g.agent_count,
        'first_payment_at', g.first_payment_at,
        'last_payment_at', g.last_payment_at,
        'fully_mapped', g.fully_mapped
      ) ORDER BY g.amount DESC)
      FROM grouped g
    ), '[]'::jsonb),
    'source', 'agent_collections (non-reversed) placed by approved Uganda location of the paying tenant'
  ) INTO v_out;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_payments_location_breakdown(text, text, text, integer, integer, date, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_payments_location_breakdown(text, text, text, integer, integer, date, date, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_payments_location_receipts(
  p_level         text    DEFAULT 'country',
  p_country       text    DEFAULT NULL,
  p_region        text    DEFAULT NULL,
  p_district_id   integer DEFAULT NULL,
  p_subcounty_id  integer DEFAULT NULL,
  p_group_label   text    DEFAULT NULL,
  p_from          date    DEFAULT NULL,
  p_to            date    DEFAULT NULL,
  p_method        text    DEFAULT NULL,
  p_limit         integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_level text := lower(coalesce(p_level, 'country'));
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_out   jsonb;
BEGIN
  PERFORM receivables_guard();

  IF v_level NOT IN ('country', 'region', 'district', 'subcounty', 'village') THEN
    RAISE EXCEPTION 'Unsupported level %. Use country, region, district, subcounty or village.', p_level;
  END IF;

  WITH scope AS (
    SELECT
      c.id,
      c.tenant_id,
      round(coalesce(c.amount, 0), 2) AS amount,
      c.created_at,
      coalesce(c.payment_method::text, 'unknown') AS method,
      c.collection_channel,
      c.momo_transaction_id,
      c.tracking_id,
      c.is_partial,
      c.rent_request_id,
      tp.full_name AS tenant_name,
      tp.phone     AS tenant_phone,
      ap.full_name AS agent_name,
      (vg.village_id IS NOT NULL OR da.district_id IS NOT NULL) AS is_mapped,
      CASE WHEN (vg.village_id IS NOT NULL OR da.district_id IS NOT NULL)
           THEN 'Uganda' ELSE 'Unmapped' END AS country,
      coalesce(vg.region,         da.region,         'Unmapped') AS region,
      coalesce(vg.district_name,  da.district_name,  'Unmapped') AS district,
      coalesce(vg.district_id,    da.district_id)                AS district_id,
      coalesce(vg.subcounty_name, sa.subcounty_name, nullif(tp.town, ''), nullif(tp.sub_county, ''), 'Unmapped') AS subcounty,
      coalesce(vg.subcounty_id,   sa.subcounty_id)               AS subcounty_id,
      coalesce(vg.village_name,   nullif(tp.village, ''), 'Unmapped') AS village
    FROM agent_collections c
    LEFT JOIN profiles tp ON tp.id = c.tenant_id
    LEFT JOIN profiles ap ON ap.id = c.agent_id
    LEFT JOIN mv_ug_village_geo vg ON vg.village_id = tp.ug_village_id
    LEFT JOIN mv_ug_district_alias da
           ON tp.ug_village_id IS NULL
          AND da.norm_key = ug_norm_name(nullif(tp.district, ''))
    LEFT JOIN mv_ug_subcounty_alias sa
           ON tp.ug_village_id IS NULL
          AND sa.district_id = da.district_id
          AND sa.norm_key = ug_norm_name(nullif(tp.sub_county, ''))
    WHERE c.reversed_at IS NULL
      AND coalesce(c.amount, 0) > 0
      AND (p_from IS NULL OR (c.created_at AT TIME ZONE 'Africa/Nairobi')::date >= p_from)
      AND (p_to   IS NULL OR (c.created_at AT TIME ZONE 'Africa/Nairobi')::date <= p_to)
      AND (p_method IS NULL OR coalesce(c.payment_method::text, 'unknown') = p_method)
  ), filtered AS (
    SELECT s.* FROM scope s
    WHERE (p_country IS NULL OR s.country = p_country)
      AND (p_region IS NULL OR s.region = p_region)
      AND (p_district_id IS NULL OR s.district_id = p_district_id)
      AND (p_subcounty_id IS NULL OR s.subcounty_id = p_subcounty_id)
      AND (
        p_group_label IS NULL OR p_group_label = CASE v_level
          WHEN 'country'   THEN s.country
          WHEN 'region'    THEN s.region
          WHEN 'district'  THEN s.district
          WHEN 'subcounty' THEN s.subcounty
          ELSE s.village
        END
      )
  ), ranked AS (
    SELECT f.*, row_number() OVER (ORDER BY f.created_at DESC) AS rn
    FROM filtered f
  )
  SELECT jsonb_build_object(
    'currency', 'UGX',
    'as_at', now(),
    'level', v_level,
    'group_label', p_group_label,
    'total', coalesce((SELECT round(sum(amount), 2) FROM filtered), 0),
    'payment_count', (SELECT count(*) FROM filtered),
    'tenant_count', (SELECT count(DISTINCT tenant_id) FROM filtered),
    'returned', (SELECT count(*) FROM ranked WHERE rn <= v_limit),
    'payments', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'payment_id', r.id,
        'tenant_id', r.tenant_id,
        'tenant', r.tenant_name,
        'phone', r.tenant_phone,
        'agent', r.agent_name,
        'amount', r.amount,
        'method', r.method,
        'channel', r.collection_channel,
        'transaction_id', r.momo_transaction_id,
        'tracking_id', r.tracking_id,
        'is_partial', r.is_partial,
        'rent_request_id', r.rent_request_id,
        'paid_at', r.created_at,
        'region', r.region,
        'district', r.district,
        'subcounty', r.subcounty,
        'village', r.village
      ) ORDER BY r.created_at DESC)
      FROM ranked r WHERE r.rn <= v_limit
    ), '[]'::jsonb),
    'source', 'agent_collections (non-reversed)'
  ) INTO v_out;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_payments_location_receipts(text, text, text, integer, integer, text, date, date, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_payments_location_receipts(text, text, text, integer, integer, text, date, date, text, integer) TO authenticated;
