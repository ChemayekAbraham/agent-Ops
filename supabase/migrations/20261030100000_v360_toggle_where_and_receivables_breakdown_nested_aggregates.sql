-- 1. v360_set_new_plans_enabled updated the one-row v360_settings table with no WHERE clause. The database refuses an
--    UPDATE without WHERE ("UPDATE requires a WHERE clause", 10 refusals 10-30 06:08 UTC), so the CFO/COO switch
--    could not be changed (new_plans_enabled is still false). Same body with `where id is not null`; the table holds
--    one row (id = true).
-- 2. get_tenant_receivables_location_breakdown nested aggregates (jsonb_agg over sum()/count()) in group_products and
--    scope_products ("aggregate function calls cannot be nested", 6 failures). The per-product sums are now computed
--    in an inner query and the outer jsonb_agg only packs them. scope_products had no GROUP BY, so it also folded
--    every product into one row; it now groups by product as the output ('products' array) intends.
-- CREATE OR REPLACE keeps the grants. Applied to production by hand; this file is the record.
CREATE OR REPLACE FUNCTION public.v360_set_new_plans_enabled(p_enabled boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not ((select has_role((select auth.uid()),'cfo'::app_role)) or (select has_role((select auth.uid()),'coo'::app_role)) or (select has_role((select auth.uid()),'super_admin'::app_role))) then
    raise exception 'Only CFO, COO or super admin can change this';
  end if;
  update public.v360_settings set new_plans_enabled = p_enabled, updated_by = auth.uid(), updated_at = now() where id is not null;
  return jsonb_build_object('success', true, 'enabled', p_enabled);
end $function$;

CREATE OR REPLACE FUNCTION public.get_tenant_receivables_location_breakdown(p_level text DEFAULT 'region'::text, p_region text DEFAULT NULL::text, p_district_id integer DEFAULT NULL::integer, p_subcounty_id integer DEFAULT NULL::integer, p_product_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_level text := lower(coalesce(p_level, 'region'));
  v_out   jsonb;
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
      l.status,
      coalesce(vg.region,        da.region,        'Unmapped') AS region,
      coalesce(vg.district_name, da.district_name, 'Unmapped') AS district,
      coalesce(vg.district_id,   da.district_id)               AS district_id,
      coalesce(vg.subcounty_name, sa.subcounty_name, nullif(p.town, ''), nullif(p.sub_county, ''), 'Unmapped') AS subcounty,
      coalesce(vg.subcounty_id,  sa.subcounty_id)              AS subcounty_id,
      coalesce(vg.village_name,  nullif(p.village, ''), 'Unmapped') AS village,
      nullif(p.town, '') AS town,
      (vg.village_id IS NOT NULL OR da.district_id IS NOT NULL) AS is_mapped
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
  ), grouped AS (
    SELECT
      k.group_label,
      max(k.region)   AS region,
      max(k.district) AS district,
      max(k.district_id)  AS district_id,
      max(k.subcounty_id) AS subcounty_id,
      round(sum(k.amount), 2) AS outstanding,
      count(*)               AS item_count,
      count(DISTINCT k.tenant_id) AS tenant_count,
      coalesce(round(sum(k.amount) FILTER (WHERE k.due_kind = 'scheduled'), 2), 0) AS scheduled_amount,
      coalesce(round(sum(k.amount) FILTER (WHERE k.due_kind = 'projected'), 2), 0) AS projected_amount,
      bool_and(k.is_mapped) AS fully_mapped
    FROM keyed k
    GROUP BY k.group_label
  ), group_product_sums AS (
    SELECT k.group_label, k.product_key, k.product_label,
           round(sum(k.amount), 2) AS outstanding,
           count(*) AS item_count
    FROM keyed k
    GROUP BY k.group_label, k.product_key, k.product_label
  ), group_products_rolled AS (
    SELECT x.group_label,
           jsonb_agg(jsonb_build_object(
             'key', x.product_key,
             'label', x.product_label,
             'outstanding', x.outstanding,
             'item_count', x.item_count
           ) ORDER BY x.outstanding DESC) AS products
    FROM group_product_sums x
    GROUP BY x.group_label
  ), ranked_items AS (
    SELECT k.*, row_number() OVER (PARTITION BY k.group_label ORDER BY k.amount DESC) AS rn
    FROM keyed k
  ), group_items AS (
    SELECT group_label,
           jsonb_agg(jsonb_build_object(
             'item_id', item_id,
             'tenant', tenant_name,
             'product', product_label,
             'amount', amount,
             'status', status,
             'village', village,
             'town', town,
             'district', district
           ) ORDER BY amount DESC) AS top_items
    FROM ranked_items
    WHERE rn <= 25
    GROUP BY group_label
  ), scope_product_sums AS (
    SELECT product_key, product_label,
           round(sum(amount), 2) AS outstanding,
           count(*) AS item_count,
           count(DISTINCT tenant_id) AS tenant_count,
           coalesce(round(sum(amount) FILTER (WHERE due_kind = 'scheduled'), 2), 0) AS scheduled_amount,
           coalesce(round(sum(amount) FILTER (WHERE due_kind = 'projected'), 2), 0) AS projected_amount
    FROM scope
    GROUP BY product_key, product_label
  ), scope_products AS (
    SELECT jsonb_agg(jsonb_build_object(
             'key', product_key,
             'label', product_label,
             'outstanding', outstanding,
             'item_count', item_count,
             'tenant_count', tenant_count,
             'scheduled_amount', scheduled_amount,
             'projected_amount', projected_amount
           ) ORDER BY outstanding DESC) AS products
    FROM scope_product_sums
  ), totals AS (
    SELECT coalesce(round(sum(amount), 2), 0) AS total,
           count(*) AS item_count,
           count(DISTINCT tenant_id) AS tenant_count,
           coalesce(round(sum(amount) FILTER (WHERE is_mapped), 2), 0) AS located_amount,
           coalesce(round(sum(amount) FILTER (WHERE NOT is_mapped), 2), 0) AS unmapped_amount
    FROM scope
  )
  SELECT jsonb_build_object(
    'currency', 'UGX',
    'as_at', now(),
    'level', v_level,
    'filters', jsonb_build_object(
      'region', p_region,
      'district_id', p_district_id,
      'subcounty_id', p_subcounty_id,
      'product_key', p_product_key
    ),
    'total', t.total,
    'item_count', t.item_count,
    'tenant_count', t.tenant_count,
    'located_amount', t.located_amount,
    'unmapped_amount', t.unmapped_amount,
    'products', coalesce((SELECT products FROM scope_products), '[]'::jsonb),
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'key', g.group_label,
               'label', g.group_label,
               'region', g.region,
               'district', g.district,
               'district_id', g.district_id,
               'subcounty_id', g.subcounty_id,
               'outstanding', g.outstanding,
               'item_count', g.item_count,
               'tenant_count', g.tenant_count,
               'scheduled_amount', g.scheduled_amount,
               'projected_amount', g.projected_amount,
               'fully_mapped', g.fully_mapped,
               'products', coalesce(gp.products, '[]'::jsonb),
               'top_items', coalesce(gi.top_items, '[]'::jsonb)
             ) ORDER BY g.outstanding DESC)
        FROM grouped g
        LEFT JOIN group_products_rolled gp ON gp.group_label = g.group_label
        LEFT JOIN group_items gi ON gi.group_label = g.group_label
    ), '[]'::jsonb),
    'source', 'v_receivables_lines + approved Uganda location hierarchy'
  )
  INTO v_out
  FROM totals t;

  RETURN v_out;
END;
$function$;
