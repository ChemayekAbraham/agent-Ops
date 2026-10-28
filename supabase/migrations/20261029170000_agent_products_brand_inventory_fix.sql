-- "Brand inventory" on the Smart phones overview multiplied every brand's issued quantity, value
-- and outstanding balance by its number of catalog models (iPhone: 23 models -> 5 phones showed as
-- 115 issued, UGX 109.25M, UGX 213.2M outstanding). The sales were summed once per catalog row and
-- then added up again per brand. Sales are now summed once per brand, and only phone sales count.
DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.get_agent_products_overview(text)'::regprocedure);
  v_start int;
  v_end int;
  v_new text;
BEGIN
  v_start := position($s$    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'label')), '[]'::jsonb)
    INTO v_breakdown
    FROM (
      SELECT jsonb_build_object(
               'label', COALESCE(NULLIF(btrim(c.brand),''), 'Unbranded'),$s$ IN v_def);
  v_end := position($e$    ) q;
  ELSE$e$ IN v_def);
  IF v_start = 0 OR v_end = 0 OR v_end < v_start THEN
    RAISE EXCEPTION 'brand breakdown block not found';
  END IF;

  v_new := substr(v_def, 1, v_start - 1) || $n$    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'label')), '[]'::jsonb)
    INTO v_breakdown
    FROM (
      SELECT jsonb_build_object(
               'label', b.label,
               'models', b.models,
               'reference_price', b.reference_price,
               'issued_qty', COALESCE(m.qty, 0),
               'issued_value', COALESCE(m.value, 0),
               'outstanding', COALESCE(m.outstanding, 0)
             ) AS x
      FROM (
        SELECT COALESCE(NULLIF(btrim(c.brand),''), 'Unbranded') AS label,
               COUNT(DISTINCT c.id) AS models,
               ROUND(AVG(COALESCE(c.default_amount,0))) AS reference_price
        FROM public.smartphone_catalog c
        WHERE c.is_active
        GROUP BY COALESCE(NULLIF(btrim(c.brand),''), 'Unbranded')
      ) b
      LEFT JOIN LATERAL (
        SELECT SUM(COALESCE(s.quantity,1)) AS qty,
               SUM(COALESCE(NULLIF(s.total_amount,0), s.total_revenue, 0)) AS value,
               SUM(COALESCE(s.amount_outstanding,0)) AS outstanding
        FROM public.merchandise_sales s
        WHERE lower(COALESCE(s.brand,'')) = lower(b.label)
          AND public.agent_product_category(s.item_name) = 'smart_phone'
          AND (
            (v_is_boutique AND lower(COALESCE(s.order_status,'issued')) = ANY(v_issued_statuses))
            OR
            (NOT v_is_boutique AND lower(COALESCE(s.order_status,'issued')) <> ALL (v_excluded))
          )
      ) m ON true
$n$ || substr(v_def, v_end);

  EXECUTE v_new;
END
$mig$;
