ALTER TABLE public.ug_districts ADD COLUMN IF NOT EXISTS region text;

UPDATE public.ug_districts SET region = 'Central' WHERE name IN (
 'Buikwe','Bukomansimbi','Butambala','Buvuma','Gomba','Kalangala','Kalungu','Kampala','Kasanda','Kassanda','Kayunga','Kiboga','Kyankwanzi','Kyotera','Luweero','Lwengo','Lyantonde','Masaka','Mityana','Mityana','Mpigi','Mubende','Mukono','Nakaseke','Nakasongola','Rakai','Ssembabule','Wakiso');

UPDATE public.ug_districts SET region = 'Eastern' WHERE name IN (
 'Amuria','Budaka','Bududa','Bugiri','Bugweri','Bukedea','Bukwo','Bulambuli','Busia','Butaleja','Butebo','Buyende','Iganga','Jinja','Kaberamaido','Kalaki','Kaliro','Kamuli','Kapchorwa','Kapelebyong','Katakwi','Kibuku','Kumi','Kween','Luuka','Manafwa','Mayuge','Mbale','Namayingo','Namisindwa','Namutumba','Ngora','Pallisa','Serere','Sironko','Soroti','Tororo');

UPDATE public.ug_districts SET region = 'Northern' WHERE name IN (
 'Abim','Adjumani','Agago','Alebtong','Amolatar','Amudat','Amuru','Apac','Arua','Dokolo','Gulu','Kaabong','Karenga','Kitgum','Koboko','Kole','Kotido','Kwania','Lamwo','Lira','Madi-Okollo','Maracha','Moroto','Moyo','Nabilatuk','Nakapiripirit','Napak','Nebbi','Nwoya','Obongi','Omoro','Otuke','Oyam','Pader','Pakwach','Terego','Yumbe','Zombo');

UPDATE public.ug_districts SET region = 'Western' WHERE name IN (
 'Buhweju','Buliisa','Bundibugyo','Bunyangabu','Bushenyi','Hoima','Ibanda','Isingiro','Kabale','Kabarole','Kagadi','Kakumiro','Kamwenge','Kanungu','Kasese','Kazo','Kibaale','Kikuube','Kiruhura','Kiryandongo','Kisoro','Kitagwenda','Kyegegwa','Kyenjojo','Masindi','Mbarara','Mitooma','Ntoroko','Ntungamo','Rubanda','Rubirizi','Rukiga','Rukungiri','Rwampara','Sheema');

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(name, ', ') INTO missing FROM public.ug_districts WHERE region IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Districts without a region: %', missing;
  END IF;
END $$;

ALTER TABLE public.ug_districts
  ADD CONSTRAINT ug_districts_region_check CHECK (region IN ('Central','Eastern','Northern','Western'));

CREATE INDEX IF NOT EXISTS idx_ug_districts_region ON public.ug_districts (region);

DROP FUNCTION IF EXISTS public.ug_search_villages(text, integer, integer, text);
DROP FUNCTION IF EXISTS public.ug_search_villages(text, integer);
DROP FUNCTION IF EXISTS public.ug_resolve_village(integer);

CREATE OR REPLACE FUNCTION public.ug_search_villages(p_query text, p_limit integer DEFAULT 20, p_district_id integer DEFAULT NULL::integer, p_district_name text DEFAULT NULL::text)
 RETURNS TABLE(village_id integer, village_name text, parish_id integer, parish_name text, subcounty_id integer, subcounty_name text, county_id integer, county_name text, district_id integer, district_name text, region text, full_path text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT v.id, v.name,
         p.id, p.name,
         s.id, s.name,
         c.id, c.name,
         d.id, d.name,
         d.region,
         v.name || ', ' || p.name || ', ' || s.name || ', ' || c.name || ', ' || d.name
  FROM ug_villages v
  JOIN ug_parishes p ON p.id = v.parish_id
  JOIN ug_subcounties s ON s.id = p.subcounty_id
  JOIN ug_counties c ON c.id = s.county_id
  JOIN ug_districts d ON d.id = c.district_id
  WHERE lower(v.name) LIKE '%' || lower(trim(coalesce(p_query, ''))) || '%'
    AND (p_district_id IS NULL OR d.id = p_district_id)
    AND (p_district_name IS NULL OR trim(p_district_name) = '' OR lower(d.name) = lower(trim(p_district_name)))
  ORDER BY (lower(v.name) = lower(trim(coalesce(p_query, '')))) DESC,
           length(v.name), v.name
  LIMIT LEAST(coalesce(p_limit, 20), 50);
$function$;

CREATE OR REPLACE FUNCTION public.ug_search_villages(p_query text, p_limit integer DEFAULT 20)
 RETURNS TABLE(village_id integer, village_name text, parish_id integer, parish_name text, subcounty_id integer, subcounty_name text, county_id integer, county_name text, district_id integer, district_name text, region text, full_path text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT * FROM public.ug_search_villages(p_query, p_limit, NULL::integer, NULL::text);
$function$;

CREATE OR REPLACE FUNCTION public.ug_resolve_village(p_village_id integer)
 RETURNS TABLE(village_id integer, village_name text, parish_id integer, parish_name text, subcounty_id integer, subcounty_name text, county_id integer, county_name text, district_id integer, district_name text, region text, full_path text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT v.id, v.name, p.id, p.name, s.id, s.name, c.id, c.name, d.id, d.name, d.region,
         v.name || ', ' || p.name || ', ' || s.name || ', ' || c.name || ', ' || d.name
  FROM public.ug_villages v
  JOIN public.ug_parishes p ON p.id = v.parish_id
  JOIN public.ug_subcounties s ON s.id = p.subcounty_id
  JOIN public.ug_counties c ON c.id = s.county_id
  JOIN public.ug_districts d ON d.id = c.district_id
  WHERE v.id = p_village_id
$function$;