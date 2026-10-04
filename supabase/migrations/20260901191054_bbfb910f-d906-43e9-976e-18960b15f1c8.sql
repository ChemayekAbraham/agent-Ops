DO $patch$
DECLARE v_src text; v_new text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'partner_ops_approve_self_topup';
  IF v_src IS NULL THEN RAISE EXCEPTION 'partner_ops_approve_self_topup not found'; END IF;

  v_new := replace(v_src,
    $q$'Self-managed partner top-up capital received'$q$,
    $q$'Self-managed partner top-up capital received (self_managed_partner; float_usage=self_portfolio_funding)'$q$);

  IF v_new = v_src THEN
    RAISE NOTICE 'partner_ops_approve_self_topup already tagged';
  ELSE
    EXECUTE format(
      'CREATE OR REPLACE FUNCTION public.partner_ops_approve_self_topup(p_topup_id uuid, p_notes text DEFAULT NULL::text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' AS %L',
      v_new);
  END IF;
END
$patch$;