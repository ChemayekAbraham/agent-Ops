SET lock_timeout = '20s';

CREATE OR REPLACE FUNCTION public.asset_register_list(
  p_search text DEFAULT NULL, p_category text DEFAULT NULL, p_status text DEFAULT NULL,
  p_condition text DEFAULT NULL, p_department text DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_q text;
  v_qnorm text;
  v_total bigint;
  v_items jsonb;
BEGIN
  PERFORM public._asset_register_require(false);
  IF p_search IS NOT NULL AND length(p_search) > 100 THEN
    RAISE EXCEPTION 'SEARCH_TOO_LONG' USING ERRCODE = '22023';
  END IF;
  v_q := NULLIF(btrim(p_search), '');
  IF v_q IS NOT NULL THEN
    v_qnorm := NULLIF(upper(regexp_replace(v_q, '[^A-Za-z0-9]', '', 'g')), '');
    v_q := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  WITH f AS (
    SELECT a.id, a.created_at, a.asset_code
      FROM public.assets a
      LEFT JOIN public.profiles cp ON cp.id = a.custodian_user_id
      LEFT JOIN public.asset_sites st ON st.key = a.site_key
     WHERE (p_category IS NULL OR a.category = p_category)
       AND (p_status IS NULL OR a.status = p_status)
       AND (p_condition IS NULL OR a.condition = p_condition)
       AND (p_department IS NULL OR a.department_key = p_department)
       AND (v_q IS NULL
            OR a.asset_code ILIKE v_q OR a.asset_tag ILIKE v_q OR a.name ILIKE v_q OR a.brand ILIKE v_q
            OR a.model ILIKE v_q OR a.supplier ILIKE v_q OR a.location ILIKE v_q OR st.name ILIKE v_q
            OR a.custodian_name ILIKE v_q OR a.invoice_reference ILIKE v_q OR cp.full_name ILIKE v_q
            OR (v_qnorm IS NOT NULL AND a.serial_number_norm LIKE '%' || v_qnorm || '%'))
  ), page AS (
    SELECT id FROM f ORDER BY created_at DESC, asset_code DESC LIMIT v_limit OFFSET v_offset
  ), pg AS (
    SELECT a.id, a.category, lower(btrim(a.name)) nm, a.site_key
      FROM public.assets a JOIN page USING (id)
  ), cnt AS (
    SELECT b.category, lower(btrim(b.name)) nm, b.site_key, count(*) n
      FROM public.assets b
      JOIN pg k ON k.category = b.category
               AND k.nm = lower(btrim(b.name))
               AND k.site_key IS NOT DISTINCT FROM b.site_key
     GROUP BY 1, 2, 3
  )
  SELECT (SELECT count(*) FROM f),
         COALESCE((SELECT jsonb_agg(public._asset_register_row_json(a)
                                    || jsonb_build_object('same_item_count', COALESCE(c.n, 1))
                                   ORDER BY a.created_at DESC, a.asset_code DESC)
                     FROM public.assets a
                     JOIN page USING (id)
                     LEFT JOIN cnt c ON c.category = a.category
                                    AND c.nm = lower(btrim(a.name))
                                    AND c.site_key IS NOT DISTINCT FROM a.site_key), '[]'::jsonb)
    INTO v_total, v_items;

  RETURN jsonb_build_object('total_count', v_total, 'limit', v_limit, 'offset', v_offset, 'items', v_items);
END $$;

GRANT EXECUTE ON FUNCTION public.asset_register_list(text, text, text, text, text, integer, integer) TO authenticated;

RESET lock_timeout;