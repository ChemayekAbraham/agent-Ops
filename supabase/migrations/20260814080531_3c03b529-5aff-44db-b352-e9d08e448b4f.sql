-- 1. Official region for every district in the dataset
UPDATE public.ug_districts SET region = m.region
FROM (VALUES
 ('Bukomansimbi','Central'),('Buikwe','Central'),('Butambala','Central'),('Buvuma','Central'),
 ('Gomba','Central'),('Kalangala','Central'),('Kalungu','Central'),('Kampala','Central'),
 ('Kasanda','Central'),('Kayunga','Central'),('Kiboga','Central'),('Kyankwanzi','Central'),
 ('Kyotera','Central'),('Luweero','Central'),('Lwengo','Central'),('Lyantonde','Central'),
 ('Masaka','Central'),('Mityana','Central'),('Mpigi','Central'),('Mubende','Central'),
 ('Mukono','Central'),('Nakaseke','Central'),('Nakasongola','Central'),('Rakai','Central'),
 ('Ssembabule','Central'),('Wakiso','Central'),
 ('Amuria','Eastern'),('Budaka','Eastern'),('Bududa','Eastern'),('Bugiri','Eastern'),
 ('Bugweri','Eastern'),('Bukedea','Eastern'),('Bukwo','Eastern'),('Bulambuli','Eastern'),
 ('Busia','Eastern'),('Butaleja','Eastern'),('Butebo','Eastern'),('Buyende','Eastern'),
 ('Iganga','Eastern'),('Jinja','Eastern'),('Kaberamaido','Eastern'),('Kalaki','Eastern'),
 ('Kaliro','Eastern'),('Kamuli','Eastern'),('Kapchorwa','Eastern'),('Kapelebyong','Eastern'),
 ('Katakwi','Eastern'),('Kibuku','Eastern'),('Kumi','Eastern'),('Kween','Eastern'),
 ('Luuka','Eastern'),('Manafwa','Eastern'),('Mayuge','Eastern'),('Mbale','Eastern'),
 ('Namayingo','Eastern'),('Namisindwa','Eastern'),('Namutumba','Eastern'),('Ngora','Eastern'),
 ('Pallisa','Eastern'),('Serere','Eastern'),('Sironko','Eastern'),('Soroti','Eastern'),
 ('Tororo','Eastern'),
 ('Abim','Northern'),('Adjumani','Northern'),('Agago','Northern'),('Alebtong','Northern'),
 ('Amolatar','Northern'),('Amudat','Northern'),('Amuru','Northern'),('Apac','Northern'),
 ('Arua','Northern'),('Dokolo','Northern'),('Gulu','Northern'),('Kaabong','Northern'),
 ('Karenga','Northern'),('Kitgum','Northern'),('Koboko','Northern'),('Kole','Northern'),
 ('Kotido','Northern'),('Kwania','Northern'),('Lamwo','Northern'),('Lira','Northern'),
 ('Madi-Okollo','Northern'),('Maracha','Northern'),('Moroto','Northern'),('Moyo','Northern'),
 ('Nabilatuk','Northern'),('Nakapiripirit','Northern'),('Napak','Northern'),('Nebbi','Northern'),
 ('Nwoya','Northern'),('Obongi','Northern'),('Omoro','Northern'),('Otuke','Northern'),
 ('Oyam','Northern'),('Pader','Northern'),('Pakwach','Northern'),('Yumbe','Northern'),
 ('Zombo','Northern'),
 ('Buhweju','Western'),('Buliisa','Western'),('Bundibugyo','Western'),('Bunyangabu','Western'),
 ('Bushenyi','Western'),('Hoima','Western'),('Ibanda','Western'),('Isingiro','Western'),
 ('Kabale','Western'),('Kabarole','Western'),('Kagadi','Western'),('Kakumiro','Western'),
 ('Kamwenge','Western'),('Kanungu','Western'),('Kasese','Western'),('Kazo','Western'),
 ('Kibaale','Western'),('Kikuube','Western'),('Kiruhura','Western'),('Kiryandongo','Western'),
 ('Kisoro','Western'),('Kitagwenda','Western'),('Kyegegwa','Western'),('Kyenjojo','Western'),
 ('Masindi','Western'),('Mbarara','Western'),('Mitooma','Western'),('Ntoroko','Western'),
 ('Ntungamo','Western'),('Rubanda','Western'),('Rubirizi','Western'),('Rukiga','Western'),
 ('Rukungiri','Western'),('Rwampara','Western'),('Sheema','Western')
) AS m(name, region)
WHERE lower(btrim(public.ug_districts.name)) = lower(m.name);

CREATE INDEX IF NOT EXISTS ug_districts_lower_name_idx ON public.ug_districts (lower(btrim(name)));
CREATE INDEX IF NOT EXISTS ug_districts_name_trgm_idx ON public.ug_districts USING gin (name gin_trgm_ops);

-- 2. Alias table for misspellings / towns / cities
CREATE TABLE IF NOT EXISTS public.ug_district_aliases (
  alias text PRIMARY KEY,
  district_id integer NOT NULL REFERENCES public.ug_districts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.ug_district_aliases TO anon, authenticated;
GRANT ALL ON public.ug_district_aliases TO service_role;
ALTER TABLE public.ug_district_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read district aliases" ON public.ug_district_aliases;
CREATE POLICY "Anyone can read district aliases" ON public.ug_district_aliases FOR SELECT USING (true);

INSERT INTO public.ug_district_aliases (alias, district_id)
SELECT a.alias, d.id
FROM (VALUES
 ('wakiiso','Wakiso'),('wakiao','Wakiso'),('waksio','Wakiso'),('wskisi','Wakiso'),
 ('wakisl','Wakiso'),('wkiso','Wakiso'),('nansana','Wakiso'),('kira','Wakiso'),
 ('kiira','Wakiso'),('entebbe','Wakiso'),('entebbe town','Wakiso'),('kajjansi','Wakiso'),
 ('jampala','Kampala'),('kapamala','Kampala'),('kampala centrol','Kampala'),
 ('kampala central','Kampala'),('kla','Kampala'),
 ('masaja','Masaka'),('mbale city','Mbale'),('jinja city','Jinja'),('gulu city','Gulu'),
 ('mbarara city','Mbarara'),('arua city','Arua'),('lira city','Lira'),('fort portal','Kabarole'),
 ('butalejja','Butaleja'),('luweero','Luweero'),('luwero','Luweero'),('luweero district','Luweero'),
 ('seeta','Mukono'),('mukono town','Mukono'),('soroti city','Soroti'),
 ('sembabule','Ssembabule'),('mityana','Mityana'),('mitiyana','Mityana'),
 ('kabale b','Kabale'),('bugweri','Bugweri'),('hoima city','Hoima')
) AS a(alias, dname)
JOIN public.ug_districts d ON lower(btrim(d.name)) = lower(a.dname)
ON CONFLICT (alias) DO NOTHING;

-- 3. Canonical resolvers
CREATE OR REPLACE FUNCTION public.ug_canonical_region(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN p_text IS NULL OR btrim(p_text) = '' THEN NULL
    WHEN lower(btrim(p_text)) ~ '^(c|s)ent' THEN 'Central'
    WHEN lower(btrim(p_text)) ~ '^(e|a)st' OR lower(btrim(p_text)) ~ '^e(a)?st' THEN 'Eastern'
    WHEN lower(btrim(p_text)) ~ '^nor' THEN 'Northern'
    WHEN lower(btrim(p_text)) ~ '^w(e)?st' THEN 'Western'
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.ug_resolve_district_id(p_text text)
RETURNS integer LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_norm text;
  v_id integer;
BEGIN
  v_norm := lower(btrim(regexp_replace(COALESCE(p_text,''), '[^a-zA-Z ''\-]', '', 'g')));
  v_norm := btrim(regexp_replace(v_norm, '\s+(district|city|municipality|town council|town|tc)$', '', 'g'));
  v_norm := btrim(regexp_replace(v_norm, '\s+', ' ', 'g'));
  IF v_norm = '' OR length(v_norm) < 3 THEN RETURN NULL; END IF;

  SELECT d.id INTO v_id FROM public.ug_districts d
   WHERE lower(btrim(d.name)) = v_norm LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  SELECT a.district_id INTO v_id FROM public.ug_district_aliases a
   WHERE a.alias = v_norm LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  SELECT d.id INTO v_id FROM public.ug_districts d
   WHERE similarity(lower(btrim(d.name)), v_norm) >= 0.55
   ORDER BY similarity(lower(btrim(d.name)), v_norm) DESC
   LIMIT 1;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ug_canonical_region(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ug_resolve_district_id(text) TO anon, authenticated, service_role;

-- 4. Link profiles to the dataset
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS district_id integer REFERENCES public.ug_districts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS profiles_district_id_idx ON public.profiles (district_id);

-- 5. Write-time normalisation (keeps text + link consistent forever)
CREATE OR REPLACE FUNCTION public.normalize_profile_location()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_id integer;
  v_name text;
  v_region text;
BEGIN
  v_id := public.ug_resolve_district_id(NEW.district);
  IF v_id IS NULL AND NEW.district_id IS NOT NULL THEN
    v_id := NEW.district_id;
  END IF;

  IF v_id IS NOT NULL THEN
    SELECT d.name, d.region INTO v_name, v_region FROM public.ug_districts d WHERE d.id = v_id;
    NEW.district_id := v_id;
    NEW.district := v_name;
    NEW.region := COALESCE(v_region, public.ug_canonical_region(NEW.region));
  ELSE
    NEW.district_id := NULL;
    NEW.district := NULLIF(btrim(COALESCE(NEW.district,'')), '');
    NEW.region := public.ug_canonical_region(NEW.region);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_profile_location ON public.profiles;
CREATE TRIGGER trg_normalize_profile_location
BEFORE INSERT OR UPDATE OF district, region, district_id ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.normalize_profile_location();

-- 6. One-shot backfill (single set-based statement, no per-row round trips)
WITH resolved AS (
  SELECT p.id,
         r.district_id,
         d.name AS district_name,
         COALESCE(d.region, public.ug_canonical_region(p.region)) AS region_name
    FROM public.profiles p
    CROSS JOIN LATERAL (SELECT public.ug_resolve_district_id(p.district) AS district_id) r
    LEFT JOIN public.ug_districts d ON d.id = r.district_id
   WHERE COALESCE(btrim(p.district),'') <> '' OR COALESCE(btrim(p.region),'') <> ''
)
UPDATE public.profiles p
   SET district_id = res.district_id,
       district = COALESCE(res.district_name, NULLIF(btrim(p.district),'')),
       region = res.region_name
  FROM resolved res
 WHERE res.id = p.id
   AND (p.district_id IS DISTINCT FROM res.district_id
     OR p.district IS DISTINCT FROM COALESCE(res.district_name, NULLIF(btrim(p.district),''))
     OR p.region IS DISTINCT FROM res.region_name);

-- 7. Region / district breakdown now dataset-backed
CREATE OR REPLACE FUNCTION public.get_agent_directory_region_breakdown(_verified_only boolean DEFAULT false)
RETURNS TABLE(region text, district text, agent_count bigint, verified_count bigint, active_30d bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT
    COALESCE(d.region, public.ug_canonical_region(p.region), 'Unassigned') AS region,
    COALESCE(d.name, 'Unassigned') AS district,
    COUNT(*)::bigint,
    COUNT(*) FILTER (WHERE p.verified IS TRUE)::bigint,
    COUNT(*) FILTER (WHERE p.last_active_at >= (now() - interval '30 days'))::bigint
  FROM public.agent_ops_qualifying_agent_ids() q
  JOIN public.profiles p ON p.id = q.agent_id
  LEFT JOIN public.ug_districts d ON d.id = p.district_id
  WHERE (NOT _verified_only OR p.verified IS TRUE)
  GROUP BY 1, 2
  ORDER BY (CASE COALESCE(d.region, public.ug_canonical_region(p.region), 'Unassigned')
              WHEN 'Central' THEN 1 WHEN 'Eastern' THEN 2
              WHEN 'Northern' THEN 3 WHEN 'Western' THEN 4 ELSE 9 END),
           3 DESC;
$function$;

-- 8. Directory rows return canonical location + are searchable by it
CREATE OR REPLACE FUNCTION public.get_agent_directory_v2(p_search text DEFAULT NULL::text, p_type text DEFAULT 'all'::text, p_status text DEFAULT 'all'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_limit int := GREATEST(1, LEAST(100, COALESCE(p_limit,50)));
  v_offset int := GREATEST(0, COALESCE(p_offset,0));
  v_q text := NULLIF(btrim(COALESCE(p_search,'')),'');
BEGIN
  PERFORM public.agent_ops_directory_guard();

  RETURN (
    WITH universe AS (
      SELECT agent_id AS uid FROM public.agent_ops_strict_agent_ids()
    ),
    subs AS (
      SELECT DISTINCT sa.sub_agent_id AS uid FROM agent_subagents sa
       WHERE sa.sub_agent_id IS NOT NULL
    ),
    tenant_counts AS (
      SELECT rr.agent_id AS uid, count(DISTINCT rr.tenant_id) AS n
        FROM rent_requests rr
        JOIN universe u ON u.uid = rr.agent_id
       WHERE rr.tenant_id IS NOT NULL AND rr.tenant_id <> rr.agent_id
       GROUP BY rr.agent_id
    ),
    enriched AS (
      SELECT
        u.uid,
        p.full_name, p.phone, p.email, p.avatar_url, p.verified, p.territory,
        COALESCE(dd.region, public.ug_canonical_region(p.region), 'Unassigned') AS region,
        COALESCE(dd.name, 'Unassigned') AS district,
        p.created_at, p.last_active_at, p.is_frozen,
        p.agent_tier,
        CASE WHEN s.uid IS NOT NULL THEN 'sub_agent' ELSE 'agent' END AS agent_kind,
        COALESCE(tc.n, 0)::int AS total_tenants,
        CASE
          WHEN p.is_frozen THEN 'frozen'
          WHEN p.last_active_at IS NOT NULL AND p.last_active_at >= now() - interval '30 days' THEN 'active'
          ELSE 'inactive'
        END AS status
      FROM universe u
      JOIN profiles p ON p.id = u.uid
      LEFT JOIN ug_districts dd ON dd.id = p.district_id
      LEFT JOIN subs s ON s.uid = u.uid
      LEFT JOIN tenant_counts tc ON tc.uid = u.uid
    ),
    kpi AS (
      SELECT
        count(*) FILTER (WHERE agent_kind = 'agent')::int AS total_agents,
        count(*) FILTER (WHERE agent_kind = 'sub_agent')::int AS total_sub_agents,
        count(*) FILTER (WHERE status = 'active')::int AS total_active,
        count(*)::int AS total_all
      FROM enriched
    ),
    filtered AS (
      SELECT * FROM enriched e
      WHERE (COALESCE(p_type,'all') = 'all' OR e.agent_kind = p_type)
        AND (COALESCE(p_status,'all') = 'all' OR e.status = p_status)
        AND (
          v_q IS NULL
          OR e.full_name ILIKE '%'||v_q||'%'
          OR e.phone ILIKE '%'||v_q||'%'
          OR e.email ILIKE '%'||v_q||'%'
          OR e.territory ILIKE '%'||v_q||'%'
          OR e.district ILIKE '%'||v_q||'%'
          OR e.region ILIKE '%'||v_q||'%'
          OR e.uid::text = v_q
        )
    ),
    page AS (
      SELECT * FROM filtered
      ORDER BY total_tenants DESC, full_name ASC NULLS LAST
      LIMIT v_limit OFFSET v_offset
    ),
    page_metrics AS (
      SELECT
        pg.*,
        (SELECT count(*)::int FROM agent_subagents s WHERE s.parent_agent_id = pg.uid) AS sub_agents_count,
        (SELECT count(*)::int FROM house_listings hl WHERE hl.agent_id = pg.uid) AS houses_listed,
        COALESCE((
          SELECT sum(rr.daily_repayment) FROM rent_requests rr
           WHERE rr.agent_id = pg.uid
             AND rr.status IN ('funded','repaying')
             AND COALESCE(rr.amount_repaid,0) < COALESCE(rr.total_repayment,0)
             AND COALESCE(rr.agent_payment_status,'') <> 'not_paying'
        ),0) AS daily_target,
        COALESCE((
          SELECT GREATEST(0, sum(COALESCE(rr.total_repayment,0)) - sum(COALESCE(rr.amount_repaid,0)))
            FROM rent_requests rr
           WHERE rr.agent_id = pg.uid AND rr.status IN ('funded','repaying')
        ),0) AS outstanding,
        COALESCE((
          SELECT sum(ac.amount) FROM agent_collections ac
           WHERE ac.agent_id = pg.uid AND ac.created_at >= date_trunc('day', now())
        ),0) AS collected_today,
        (SELECT max(ac.created_at) FROM agent_collections ac WHERE ac.agent_id = pg.uid) AS last_collection_at
      FROM page pg
    )
    SELECT jsonb_build_object(
      'kpis', (SELECT to_jsonb(k) FROM kpi k),
      'total_matched', (SELECT count(*)::int FROM filtered),
      'limit', v_limit,
      'offset', v_offset,
      'rows', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', pm.uid,
          'full_name', pm.full_name,
          'phone', pm.phone,
          'email', pm.email,
          'avatar_url', pm.avatar_url,
          'verified', COALESCE(pm.verified,false),
          'territory', pm.territory,
          'region', pm.region,
          'district', pm.district,
          'agent_tier', pm.agent_tier,
          'created_at', pm.created_at,
          'last_active_at', pm.last_active_at,
          'agent_kind', pm.agent_kind,
          'total_tenants', pm.total_tenants,
          'sub_agents_count', pm.sub_agents_count,
          'houses_listed', pm.houses_listed,
          'daily_target', pm.daily_target,
          'collected_today', pm.collected_today,
          'outstanding', pm.outstanding,
          'last_collection_at', pm.last_collection_at,
          'status', pm.status
        ) ORDER BY pm.total_tenants DESC, pm.full_name ASC NULLS LAST)
        FROM page_metrics pm
      ), '[]'::jsonb)
    )
  );
END;
$function$;