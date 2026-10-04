CREATE OR REPLACE FUNCTION public.receivables_category_frame()
 RETURNS TABLE(category_key text, category_label text, sort_order integer)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT * FROM (VALUES
    ('agent','Agent Products & Services',1),
    ('landlord','Landlord Products & Services',3),
    ('partner','Partner Products & Services',4),
    ('tenant','Tenant Products & Services',5),
    ('rnd','R&D',6),
    ('other','Unclassified / Other',7)
  ) f(category_key, category_label, sort_order)
$function$;