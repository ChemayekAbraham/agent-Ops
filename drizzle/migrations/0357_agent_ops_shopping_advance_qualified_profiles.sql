CREATE OR REPLACE FUNCTION public.agent_ops_shopping_advance_qualified_profiles()
RETURNS TABLE (
  user_id uuid, full_name text, phone text, email text, national_id text, occupation text,
  primary_persona text, verified boolean, phone_verified boolean, is_frozen boolean,
  created_at timestamptz, last_active_at timestamptz,
  continent text, country text, region text, district text, sub_county text, parish text,
  village text, town text, city text, landmark text,
  residence_lat numeric, residence_lng numeric, residence_updated_at timestamptz, location_source text,
  mobile_money_provider text, mobile_money_number text,
  transfer_count bigint, transfer_total numeric, first_transfer_at timestamptz, last_transfer_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid() AND COALESCE(ur.enabled, true)
      AND ur.role::text IN ('agent_ops','manager','super_admin','coo','ceo','operations')
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH t AS (
    SELECT wt.sender_id AS uid, wt.amount::numeric AS amt, wt.created_at AS at
    FROM public.wallet_transactions wt
    WHERE wt.sender_id IS NOT NULL AND wt.sender_id <> wt.recipient_id AND wt.amount > 0
    UNION ALL
    SELECT gl.user_id, gl.amount::numeric, gl.transaction_date
    FROM public.general_ledger gl
    WHERE gl.ledger_scope = 'wallet' AND gl.category = 'wallet_transfer'
      AND gl.direction = 'cash_out' AND gl.source_table = 'wallet_transactions'
      AND gl.user_id IS NOT NULL AND gl.amount > 0
  ), s AS (
    SELECT uid, count(*)::bigint c, sum(amt) tot, min(at) f, max(at) l FROM t GROUP BY uid
  )
  SELECT s.uid, p.full_name, p.phone, p.email, p.national_id, p.occupation, p.primary_persona,
    p.verified, p.phone_verified, p.is_frozen, p.created_at, p.last_active_at,
    p.continent, p.country, p.region, p.district, p.sub_county, p.parish, p.village, p.town, p.city, p.landmark,
    p.residence_lat, p.residence_lng, p.residence_updated_at, p.location_source,
    p.mobile_money_provider, p.mobile_money_number,
    s.c, s.tot, s.f, s.l
  FROM s LEFT JOIN public.profiles p ON p.id = s.uid
  ORDER BY s.l DESC NULLS LAST;
END $$;
COMMENT ON FUNCTION public.agent_ops_shopping_advance_qualified_profiles() IS 'Read-only, role-gated list of users qualified for Shopping Advance via wallet transfers (informational). Counts may double-count a transfer present in both sources.';
REVOKE ALL ON FUNCTION public.agent_ops_shopping_advance_qualified_profiles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_ops_shopping_advance_qualified_profiles() TO authenticated;