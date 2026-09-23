-- Reclassify Service Centre receivables under Tenant Products & Services.
-- Service Centre Products & Services should not appear as an independent top-level
-- category on the CFO dashboard; its products (advances and receivables) are part
-- of the tenant book.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_catalog.pg_get_viewdef(c.oid, true)
  INTO v_def
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'v_receivables_lines';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'View public.v_receivables_lines not found';
  END IF;

  -- Replace the independent Service Centre category with Tenant classification.
  v_def := replace(v_def, '''service_centre''::text AS category_key,', '''tenant''::text AS category_key,');
  v_def := replace(v_def, '''Service Centre Products & Services''::text AS category_label,', '''Tenant Products & Services''::text AS category_label,');

  -- Guardrails: ensure we did not accidentally create duplicate or missing labels.
  IF position('''service_centre''::text AS category_key' IN v_def) > 0 THEN
    RAISE EXCEPTION 'Service Centre category key still present in view definition';
  END IF;
  IF position('''Service Centre Products & Services''::text AS category_label' IN v_def) > 0 THEN
    RAISE EXCEPTION 'Service Centre category label still present in view definition';
  END IF;

  EXECUTE format('CREATE OR REPLACE VIEW public.v_receivables_lines AS %s', v_def);
END;
$$;
