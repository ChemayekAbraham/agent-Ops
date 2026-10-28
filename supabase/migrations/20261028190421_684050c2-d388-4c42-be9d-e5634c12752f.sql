DO $mig$
DECLARE
  v_def text;
  v_new text;
  v_old text := '''Agent Commissions''';
  v_rep text := '''Agent Products and Services''';
BEGIN
  -- ---------- 1. summary tiles ----------
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_cfo_paid_by_category_totals';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_cfo_paid_by_category_totals not found';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
    RAISE EXCEPTION 'totals: expected exactly one Agent Commissions label';
  END IF;
  IF position(v_rep IN v_def) > 0 THEN
    RAISE EXCEPTION 'totals: Agent Products and Services already present';
  END IF;

  v_new := replace(v_def, v_old, v_rep);
  IF position('(''agent'', ''Agent Products and Services'', 3)' IN v_new) = 0 THEN
    RAISE EXCEPTION 'totals: tile label row did not land as expected';
  END IF;
  EXECUTE v_new;

  -- ---------- 2. transaction list ----------
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_cfo_paid_by_category_page';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_cfo_paid_by_category_page not found';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
    RAISE EXCEPTION 'page: expected exactly one Agent Commissions label';
  END IF;
  IF position(v_rep IN v_def) > 0 THEN
    RAISE EXCEPTION 'page: Agent Products and Services already present';
  END IF;

  v_new := replace(v_def, v_old, v_rep);
  IF position('WHEN ''agent'' THEN ''Agent Products and Services''' IN v_new) = 0 THEN
    RAISE EXCEPTION 'page: row label did not land as expected';
  END IF;
  EXECUTE v_new;

  -- ---------- 3. verify both live definitions ----------
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('get_cfo_paid_by_category_totals', 'get_cfo_paid_by_category_page')
      AND (position(v_old IN pg_get_functiondef(p.oid)) > 0
           OR position(v_rep IN pg_get_functiondef(p.oid)) = 0)
  ) THEN
    RAISE EXCEPTION 'rename verification failed';
  END IF;

  -- ---------- 4. verify nothing else about the report moved ----------
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('get_cfo_paid_by_category_totals', 'get_cfo_paid_by_category_page')
      AND (position('_cfo_paid_lunch_correction_ok' IN pg_get_functiondef(p.oid)) = 0
           OR position('has_role(auth.uid(), ''cfo''::app_role)' IN pg_get_functiondef(p.oid)) = 0
           OR position('landlord_float' IN pg_get_functiondef(p.oid)) > 0)
  ) THEN
    RAISE EXCEPTION 'report safeguards changed unexpectedly';
  END IF;
END
$mig$;