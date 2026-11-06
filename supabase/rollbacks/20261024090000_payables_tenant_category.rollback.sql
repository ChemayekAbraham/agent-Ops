-- Rollback for 20261024090000_payables_tenant_category.sql: restores payables_category_frame() exactly as it was (7 categories, no Tenant).
-- Refuses, changing nothing, unless the list is the one 20261024090000_payables_tenant_category created. Run as one transaction.
SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.payables_category_frame()'::regprocedure)
       IS DISTINCT FROM 'e9358103c738ff54b646f01b2ba2cf10' THEN
    RAISE EXCEPTION 'precondition failed: payables_category_frame is not the one 20261024090000_payables_tenant_category created; nothing was changed. Reverse by hand';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.payables_category_frame()
 RETURNS TABLE(category_key text, category_label text, sort_order integer)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT * FROM (VALUES
    ('partner','Partner Products and Services',1),
    ('landlord','Landlord Products and Services',2),
    ('agent','Agent Products and Services',3),
    ('budget','Operational Expenses',4),
    ('marketing','Marketing Expenses',5),
    ('rnd','R&D (Research and Development)',6),
    ('other','Unclassified / Other',7)
  ) f(category_key, category_label, sort_order)
$function$;

RESET lock_timeout;
