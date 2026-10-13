CREATE OR REPLACE FUNCTION public._shopping_advance_received_24h()
RETURNS TABLE(user_id uuid, transfer_count bigint, transfer_total numeric, first_transfer_at timestamptz, last_transfer_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT gl.user_id, count(*)::bigint, sum(gl.amount)::numeric, min(gl.transaction_date), max(gl.transaction_date)
  FROM public.general_ledger gl
  WHERE gl.user_id IS NOT NULL AND gl.ledger_scope = 'wallet'
    AND gl.category = 'wallet_transfer' AND gl.direction = 'cash_in'
    AND gl.amount > 0 AND gl.classification <> 'admin_correction'
    AND gl.transaction_date >= now() - interval '24 hours'
  GROUP BY gl.user_id;
$$;
REVOKE ALL ON FUNCTION public._shopping_advance_received_24h() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.agent_ops_shopping_advance_qualified_senders()
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM public.user_roles r
    WHERE r.user_id = auth.uid() AND r.enabled = true
      AND r.role IN ('agent_ops', 'manager', 'super_admin', 'coo', 'ceo', 'operations')
  ) THEN (SELECT count(*)::bigint FROM public._shopping_advance_received_24h())
  ELSE NULL::bigint END;
$$;

CREATE OR REPLACE FUNCTION public.agent_ops_shopping_advance_qualified_profiles()
RETURNS TABLE(user_id uuid, full_name text, phone text, email text, national_id text, occupation text, primary_persona text, verified boolean, phone_verified boolean, is_frozen boolean, created_at timestamptz, last_active_at timestamptz, continent text, country text, region text, district text, sub_county text, parish text, village text, town text, city text, landmark text, residence_lat numeric, residence_lng numeric, residence_updated_at timestamptz, location_source text, mobile_money_provider text, mobile_money_number text, transfer_count bigint, transfer_total numeric, first_transfer_at timestamptz, last_transfer_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid() AND COALESCE(ur.enabled, true)
      AND ur.role::text IN ('agent_ops','manager','super_admin','coo','ceo','operations')
  ) THEN RETURN; END IF;
  RETURN QUERY
  SELECT s.user_id, p.full_name, p.phone, p.email, p.national_id, p.occupation, p.primary_persona,
    p.verified, p.phone_verified, p.is_frozen, p.created_at, p.last_active_at,
    p.continent, p.country, p.region, p.district, p.sub_county, p.parish, p.village, p.town, p.city, p.landmark,
    p.residence_lat, p.residence_lng, p.residence_updated_at, p.location_source,
    p.mobile_money_provider, p.mobile_money_number,
    s.transfer_count, s.transfer_total, s.first_transfer_at, s.last_transfer_at
  FROM public._shopping_advance_received_24h() s LEFT JOIN public.profiles p ON p.id = s.user_id
  ORDER BY s.last_transfer_at DESC NULLS LAST;
END;
$$;

-- Preserve every non-qualification dossier field and existing grants verbatim.
DO $migration$
DECLARE
  v_definition text := pg_get_functiondef('public.agent_ops_shopping_advance_user_dossier(uuid)'::regprocedure);
  v_start integer;
  v_end integer;
BEGIN
  v_start := strpos(v_definition, '  SELECT EXISTS (');
  v_end := strpos(v_definition, '  IF NOT EXISTS (SELECT 1 FROM public.profiles');
  IF v_start = 0 OR v_end <= v_start THEN RAISE EXCEPTION 'Unexpected dossier qualification definition'; END IF;
  v_definition := left(v_definition, v_start - 1) || substr(v_definition, v_end);
  v_start := strpos(v_definition, '  SELECT COALESCE(sum(wt.amount), 0)');
  v_end := strpos(v_definition, '  SELECT jsonb_build_object(');
  IF v_start = 0 OR v_end <= v_start THEN RAISE EXCEPTION 'Unexpected dossier received-total definition'; END IF;
  v_definition := left(v_definition, v_start - 1) || E'  SELECT COALESCE((SELECT s.transfer_total FROM public._shopping_advance_received_24h() s WHERE s.user_id = p_user_id), 0) INTO v_received_total;\n\n' || substr(v_definition, v_end);
  v_start := strpos(v_definition, E'    ''qualification'', (');
  v_end := strpos(v_definition, E'    ''wallet'', (');
  IF v_start = 0 OR v_end <= v_start THEN RAISE EXCEPTION 'Unexpected dossier qualification output definition'; END IF;
  v_definition := left(v_definition, v_start - 1) || $replacement$    'qualification', (
      SELECT jsonb_build_object(
        'transfer_count', COALESCE(s.transfer_count, 0),
        'transfer_total', v_received_total,
        'first_transfer_at', s.first_transfer_at,
        'last_transfer_at', s.last_transfer_at,
        'received_transfer_total', v_received_total,
        'access_limit', CASE WHEN v_received_total > 0 THEN LEAST(30000000::numeric, 30000::numeric + v_received_total * 2) ELSE 0::numeric END
      ) FROM (SELECT 1) seed LEFT JOIN public._shopping_advance_received_24h() s ON s.user_id = p_user_id
    ),
$replacement$ || substr(v_definition, v_end);
  EXECUTE v_definition;
END;
$migration$;