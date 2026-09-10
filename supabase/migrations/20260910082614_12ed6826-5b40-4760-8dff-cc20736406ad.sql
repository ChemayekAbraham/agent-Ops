CREATE OR REPLACE FUNCTION public.get_tenant_receivables_location_accounts(
  p_level text DEFAULT 'region',
  p_region text DEFAULT NULL,
  p_district_id integer DEFAULT NULL,
  p_subcounty_id integer DEFAULT NULL,
  p_group_label text DEFAULT NULL,
  p_product_key text DEFAULT NULL,
  p_limit integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_level text := lower(coalesce(p_level, 'region'));
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_out jsonb;
BEGIN
  PERFORM receivables_guard();

  IF v_level NOT IN ('region', 'district', 'subcounty', 'village') THEN
    RAISE EXCEPTION 'Unsupported level %. Use region, district, subcounty or village.', p_level;
  END IF;

  WITH scope AS (
    SELECT
      l.item_id,
      l.product_key,
      l.product_label,
      l.counterparty_id  AS tenant_id,
      l.counterparty_name AS tenant_name,
      round(l.outstanding_amount, 2) AS amount,
      l.due_kind,
      l.due_date,
      l.status,
      p.phone,
      coalesce(vg.region,        da.region,        'Unmapped') AS region,
      coalesce(vg.district_name, da.district_name, 'Unmapped') AS district,
      coalesce(vg.subcounty_name, sa.subcounty_name, nullif(p.town, ''), nullif(p.sub_county, ''), 'Unmapped') AS subcounty,
      coalesce(vg.village_name,  nullif(p.village, ''), 'Unmapped') AS village,
      nullif(p.town, '') AS town
    FROM v_receivables_lines l
    LEFT JOIN profiles p ON p.id = l.counterparty_id
    LEFT JOIN mv_ug_village_geo vg ON vg.village_id = p.ug_village_id
    LEFT JOIN mv_ug_district_alias da
           ON p.ug_village_id IS NULL
          AND da.norm_key = ug_norm_name(nullif(p.district, ''))
    LEFT JOIN mv_ug_subcounty_alias sa
           ON p.ug_village_id IS NULL
          AND sa.district_id = da.district_id
          AND sa.norm_key = ug_norm_name(nullif(p.sub_county, ''))
    WHERE l.category_key = 'tenant'
      AND (p_product_key IS NULL OR l.product_key = p_product_key)
      AND (p_region IS NULL OR coalesce(vg.region, da.region, 'Unmapped') = p_region)
      AND (p_district_id IS NULL OR coalesce(vg.district_id, da.district_id) = p_district_id)
      AND (p_subcounty_id IS NULL OR coalesce(vg.subcounty_id, sa.subcounty_id) = p_subcounty_id)
  ), keyed AS (
    SELECT s.*,
      CASE v_level
        WHEN 'region'    THEN s.region
        WHEN 'district'  THEN s.district
        WHEN 'subcounty' THEN s.subcounty
        ELSE s.village
      END AS group_label
    FROM scope s
  ), filtered AS (
    SELECT * FROM keyed
    WHERE p_group_label IS NULL OR group_label = p_group_label
  ), per_tenant AS (
    SELECT
      f.tenant_id,
      max(f.tenant_name) AS tenant_name,
      max(f.phone)       AS phone,
      max(f.region)      AS region,
      max(f.district)    AS district,
      max(f.subcounty)   AS subcounty,
      max(f.village)     AS village,
      max(f.town)        AS town,
      round(sum(f.amount), 2) AS outstanding,
      count(*) AS item_count,
      coalesce(round(sum(f.amount) FILTER (WHERE f.due_kind = 'scheduled'), 2), 0) AS scheduled_amount,
      coalesce(round(sum(f.amount) FILTER (WHERE f.due_kind = 'projected'), 2), 0) AS projected_amount,
      min(f.due_date) AS next_due_date,
      jsonb_agg(jsonb_build_object(
        'item_id', f.item_id,
        'product', f.product_label,
        'product_key', f.product_key,
        'amount', f.amount,
        'status', f.status,
        'due_date', f.due_date,
        'due_kind', f.due_kind
      ) ORDER BY f.amount DESC) AS items
    FROM filtered f
    GROUP BY f.tenant_id
  )
  SELECT jsonb_build_object(
    'currency', 'UGX',
    'as_at', now(),
    'level', v_level,
    'group_label', p_group_label,
    'total', coalesce((SELECT round(sum(outstanding), 2) FROM per_tenant), 0),
    'tenant_count', (SELECT count(*) FROM per_tenant),
    'item_count', coalesce((SELECT sum(item_count) FROM per_tenant), 0),
    'returned', least(v_limit, (SELECT count(*) FROM per_tenant)),
    'accounts', coalesce((
      SELECT jsonb_agg(x) FROM (
        SELECT jsonb_build_object(
          'tenant_id', tenant_id,
          'tenant', tenant_name,
          'phone', phone,
          'region', region,
          'district', district,
          'town', coalesce(town, subcounty),
          'subcounty', subcounty,
          'village', village,
          'outstanding', outstanding,
          'item_count', item_count,
          'scheduled_amount', scheduled_amount,
          'projected_amount', projected_amount,
          'next_due_date', next_due_date,
          'items', items
        ) AS x
        FROM per_tenant
        ORDER BY outstanding DESC
        LIMIT v_limit
      ) y
    ), '[]'::jsonb),
    'source', 'v_receivables_lines + approved Uganda location hierarchy'
  ) INTO v_out;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_tenant_receivables_location_accounts(text, text, integer, integer, text, text, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.get_tenant_receivables_location_accounts(text, text, integer, integer, text, text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_tenant_receivable_account_movements(
  p_tenant_id uuid,
  p_limit integer DEFAULT 150
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 150), 1), 500);
  v_out jsonb;
BEGIN
  PERFORM receivables_guard();

  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'p_tenant_id is required';
  END IF;

  SELECT jsonb_build_object(
    'currency', 'UGX',
    'as_at', now(),
    'tenant_id', p_tenant_id,
    'tenant', (SELECT coalesce(nullif(trim(coalesce(pr.first_name,'') || ' ' || coalesce(pr.last_name,'')), ''), pr.full_name, pr.phone)
               FROM profiles pr WHERE pr.id = p_tenant_id),
    'phone', (SELECT pr.phone FROM profiles pr WHERE pr.id = p_tenant_id),
    'outstanding', coalesce((
      SELECT round(sum(l.outstanding_amount), 2) FROM v_receivables_lines l
      WHERE l.category_key = 'tenant' AND l.counterparty_id = p_tenant_id), 0),
    'open_items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'item_id', l.item_id,
        'product', l.product_label,
        'amount', round(l.outstanding_amount, 2),
        'due_date', l.due_date,
        'due_kind', l.due_kind,
        'status', l.status,
        'source_table', l.source_table
      ) ORDER BY l.outstanding_amount DESC)
      FROM v_receivables_lines l
      WHERE l.category_key = 'tenant' AND l.counterparty_id = p_tenant_id), '[]'::jsonb),
    'bookings', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'rent_request_id', r.id,
        'status', r.status,
        'rent_amount', r.rent_amount,
        'total_repayment', r.total_repayment,
        'amount_repaid', coalesce(r.amount_repaid, 0),
        'outstanding', round(greatest(coalesce(r.total_repayment, 0) - coalesce(r.amount_repaid, 0), 0), 2),
        'daily_repayment', r.daily_repayment,
        'duration_days', r.duration_days,
        'created_at', r.created_at,
        'disbursed_at', r.disbursed_at,
        'schedule_status', r.schedule_status
      ) ORDER BY r.created_at DESC)
      FROM rent_requests r
      WHERE r.tenant_id = p_tenant_id), '[]'::jsonb),
    'field_receipts', coalesce((
      SELECT jsonb_agg(x) FROM (
        SELECT jsonb_build_object(
          'collection_id', c.id,
          'amount', c.amount,
          'created_at', c.created_at,
          'payment_method', c.payment_method::text,
          'rent_request_id', c.rent_request_id,
          'tracking_id', c.tracking_id,
          'is_partial', c.is_partial,
          'agent', (SELECT coalesce(nullif(trim(coalesce(ap.first_name,'') || ' ' || coalesce(ap.last_name,'')), ''), ap.full_name, ap.phone)
                    FROM profiles ap WHERE ap.id = c.agent_id)
        ) AS x
        FROM agent_collections c
        WHERE c.tenant_id = p_tenant_id
        ORDER BY c.created_at DESC
        LIMIT v_limit
      ) y), '[]'::jsonb),
    'ledger_movements', coalesce((
      SELECT jsonb_agg(x) FROM (
        SELECT jsonb_build_object(
          'entry_id', g.id,
          'transaction_date', g.transaction_date,
          'direction', g.direction,
          'amount', g.amount,
          'category', g.category,
          'description', g.description,
          'ledger_scope', g.ledger_scope,
          'classification', g.classification,
          'reference_id', g.reference_id,
          'rent_request_id', g.rent_request_id
        ) AS x
        FROM general_ledger g
        WHERE g.user_id = p_tenant_id
        ORDER BY g.transaction_date DESC, g.created_at DESC
        LIMIT v_limit
      ) y), '[]'::jsonb),
    'totals', jsonb_build_object(
      'field_receipts_total', coalesce((SELECT round(sum(c.amount), 2) FROM agent_collections c WHERE c.tenant_id = p_tenant_id), 0),
      'ledger_cash_in', coalesce((SELECT round(sum(g.amount), 2) FROM general_ledger g WHERE g.user_id = p_tenant_id AND g.direction = 'cash_in'), 0),
      'ledger_cash_out', coalesce((SELECT round(sum(g.amount), 2) FROM general_ledger g WHERE g.user_id = p_tenant_id AND g.direction = 'cash_out'), 0),
      'booked_total', coalesce((SELECT round(sum(coalesce(r.total_repayment, 0)), 2) FROM rent_requests r WHERE r.tenant_id = p_tenant_id), 0),
      'repaid_total', coalesce((SELECT round(sum(coalesce(r.amount_repaid, 0)), 2) FROM rent_requests r WHERE r.tenant_id = p_tenant_id), 0)
    ),
    'source', 'v_receivables_lines, rent_requests, agent_collections, general_ledger (read-only)'
  ) INTO v_out;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_tenant_receivable_account_movements(uuid, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.get_tenant_receivable_account_movements(uuid, integer) TO authenticated;