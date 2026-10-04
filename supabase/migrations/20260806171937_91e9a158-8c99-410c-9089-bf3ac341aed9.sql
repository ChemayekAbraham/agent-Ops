CREATE TABLE IF NOT EXISTS public.ug_districts (
  id integer PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.ug_counties (
  id integer PRIMARY KEY,
  name text NOT NULL,
  district_id integer NOT NULL REFERENCES public.ug_districts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.ug_subcounties (
  id integer PRIMARY KEY,
  name text NOT NULL,
  county_id integer NOT NULL REFERENCES public.ug_counties(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.ug_parishes (
  id integer PRIMARY KEY,
  name text NOT NULL,
  subcounty_id integer NOT NULL REFERENCES public.ug_subcounties(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.ug_villages (
  id integer PRIMARY KEY,
  name text NOT NULL,
  parish_id integer NOT NULL REFERENCES public.ug_parishes(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.ug_districts, public.ug_counties, public.ug_subcounties, public.ug_parishes, public.ug_villages TO anon, authenticated;
GRANT ALL ON public.ug_districts, public.ug_counties, public.ug_subcounties, public.ug_parishes, public.ug_villages TO service_role;

ALTER TABLE public.ug_districts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ug_counties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ug_subcounties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ug_parishes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ug_villages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ug_districts_public_read" ON public.ug_districts FOR SELECT USING (true);
CREATE POLICY "ug_counties_public_read" ON public.ug_counties FOR SELECT USING (true);
CREATE POLICY "ug_subcounties_public_read" ON public.ug_subcounties FOR SELECT USING (true);
CREATE POLICY "ug_parishes_public_read" ON public.ug_parishes FOR SELECT USING (true);
CREATE POLICY "ug_villages_public_read" ON public.ug_villages FOR SELECT USING (true);

CREATE INDEX IF NOT EXISTS idx_ug_counties_district ON public.ug_counties(district_id);
CREATE INDEX IF NOT EXISTS idx_ug_subcounties_county ON public.ug_subcounties(county_id);
CREATE INDEX IF NOT EXISTS idx_ug_parishes_subcounty ON public.ug_parishes(subcounty_id);
CREATE INDEX IF NOT EXISTS idx_ug_villages_parish ON public.ug_villages(parish_id);

CREATE INDEX IF NOT EXISTS idx_ug_districts_name ON public.ug_districts(lower(name));
CREATE INDEX IF NOT EXISTS idx_ug_counties_name ON public.ug_counties(lower(name));
CREATE INDEX IF NOT EXISTS idx_ug_subcounties_name ON public.ug_subcounties(lower(name));
CREATE INDEX IF NOT EXISTS idx_ug_parishes_name ON public.ug_parishes(lower(name));
CREATE INDEX IF NOT EXISTS idx_ug_villages_name ON public.ug_villages(lower(name));

CREATE OR REPLACE FUNCTION public.ug_search_villages(p_query text, p_limit integer DEFAULT 20)
RETURNS TABLE (
  village_id integer, village_name text,
  parish_id integer, parish_name text,
  subcounty_id integer, subcounty_name text,
  county_id integer, county_name text,
  district_id integer, district_name text,
  full_path text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT v.id, v.name, p.id, p.name, s.id, s.name, c.id, c.name, d.id, d.name,
         v.name || ', ' || p.name || ', ' || s.name || ', ' || c.name || ', ' || d.name
  FROM public.ug_villages v
  JOIN public.ug_parishes p ON p.id = v.parish_id
  JOIN public.ug_subcounties s ON s.id = p.subcounty_id
  JOIN public.ug_counties c ON c.id = s.county_id
  JOIN public.ug_districts d ON d.id = c.district_id
  WHERE p_query IS NOT NULL AND length(trim(p_query)) >= 2
    AND v.name ILIKE '%' || trim(p_query) || '%'
  ORDER BY (lower(v.name) = lower(trim(p_query))) DESC, length(v.name), v.name
  LIMIT LEAST(COALESCE(p_limit, 20), 50)
$$;

CREATE OR REPLACE FUNCTION public.ug_resolve_village(p_village_id integer)
RETURNS TABLE (
  village_id integer, village_name text,
  parish_id integer, parish_name text,
  subcounty_id integer, subcounty_name text,
  county_id integer, county_name text,
  district_id integer, district_name text,
  full_path text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT v.id, v.name, p.id, p.name, s.id, s.name, c.id, c.name, d.id, d.name,
         v.name || ', ' || p.name || ', ' || s.name || ', ' || c.name || ', ' || d.name
  FROM public.ug_villages v
  JOIN public.ug_parishes p ON p.id = v.parish_id
  JOIN public.ug_subcounties s ON s.id = p.subcounty_id
  JOIN public.ug_counties c ON c.id = s.county_id
  JOIN public.ug_districts d ON d.id = c.district_id
  WHERE v.id = p_village_id
$$;

GRANT EXECUTE ON FUNCTION public.ug_search_villages(text, integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ug_resolve_village(integer) TO anon, authenticated, service_role;