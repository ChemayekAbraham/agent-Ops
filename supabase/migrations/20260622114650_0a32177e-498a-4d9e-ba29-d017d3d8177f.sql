CREATE OR REPLACE FUNCTION public.get_crm_landlords(
  _search text DEFAULT NULL,
  _limit int DEFAULT 50,
  _offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  name text,
  phone text,
  verified boolean,
  created_at timestamptz,
  country text,
  region text,
  district text,
  city text,
  property_address text,
  bank_name text,
  account_number text,
  mobile_money_number text,
  mobile_money_name text,
  number_of_houses int,
  monthly_rent numeric,
  is_occupied boolean,
  is_agent_managed boolean,
  verification_status text,
  total_matched bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'crm') OR
    public.has_role(auth.uid(), 'manager') OR
    public.has_role(auth.uid(), 'coo') OR
    public.has_role(auth.uid(), 'ceo') OR
    public.has_role(auth.uid(), 'super_admin') OR
    public.has_role(auth.uid(), 'cto')
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  _limit := least(greatest(coalesce(_limit, 50), 1), 200);
  _offset := greatest(coalesce(_offset, 0), 0);

  RETURN QUERY
  WITH matched AS (
    SELECT l.*
    FROM public.landlords l
    WHERE _search IS NULL OR _search = '' OR (
      l.name ILIKE '%' || _search || '%' OR
      l.phone ILIKE '%' || _search || '%' OR
      l.district ILIKE '%' || _search || '%' OR
      l.region ILIKE '%' || _search || '%' OR
      l.village ILIKE '%' || _search || '%' OR
      l.town_council ILIKE '%' || _search || '%' OR
      l.property_address ILIKE '%' || _search || '%' OR
      l.bank_name ILIKE '%' || _search || '%' OR
      l.account_number ILIKE '%' || _search || '%' OR
      l.mobile_money_number ILIKE '%' || _search || '%'
    )
  )
  SELECT
    m.id, m.name, m.phone, m.verified, m.created_at,
    m.country, m.region, m.district,
    coalesce(nullif(m.town_council, ''), nullif(m.village, ''), nullif(m.cell, '')) AS city,
    m.property_address, m.bank_name, m.account_number,
    m.mobile_money_number, m.mobile_money_name,
    m.number_of_houses, m.monthly_rent, m.is_occupied, m.is_agent_managed,
    m.verification_status,
    count(*) OVER() AS total_matched
  FROM matched m
  ORDER BY m.verified DESC, m.created_at DESC NULLS LAST
  LIMIT _limit OFFSET _offset;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_crm_landlords_totals()
RETURNS TABLE (
  total bigint,
  verified bigint,
  occupied bigint,
  new30d bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'crm') OR
    public.has_role(auth.uid(), 'manager') OR
    public.has_role(auth.uid(), 'coo') OR
    public.has_role(auth.uid(), 'ceo') OR
    public.has_role(auth.uid(), 'super_admin') OR
    public.has_role(auth.uid(), 'cto')
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  RETURN QUERY
  SELECT
    count(*)::bigint AS total,
    count(*) FILTER (WHERE l.verified)::bigint AS verified,
    count(*) FILTER (WHERE l.is_occupied)::bigint AS occupied,
    count(*) FILTER (WHERE l.created_at >= now() - interval '30 days')::bigint AS new30d
  FROM public.landlords l;
END;
$$;

REVOKE ALL ON FUNCTION public.get_crm_landlords(text, int, int) FROM public, anon;
REVOKE ALL ON FUNCTION public.get_crm_landlords_totals() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_crm_landlords(text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_crm_landlords_totals() TO authenticated;