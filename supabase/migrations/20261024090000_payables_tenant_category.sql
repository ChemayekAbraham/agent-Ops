-- 2026-10-24: CFO Dashboard -> Payables: add the category 'Tenant Products and Services' (key: tenant). LIST ONLY.
--
-- The CFO asked for the category with no contents yet: no payables source is attached, so it shows UGX 0. Nothing in
-- production currently qualifies as owed to tenants under the 2026-10-21 payables rules (wallet balances and
-- withdrawal requests stay excluded). A source will be added separately once the CFO defines it.
--
-- Only payables_category_frame() changes: the new row is 4th (after Agent Products and Services) and the expense
-- categories move down one place. v_payables_lines, every payables record, amount and total are unchanged; the
-- payables functions list the new category with 0 because they read this list. No ledger, wallet, payout, grant or
-- financial record is written or changed. CREATE OR REPLACE keeps the function's grants and attributes.
-- TRANSACTION: run as ONE transaction (by hand: BEGIN; ... COMMIT;). The guard changes nothing when it refuses.
-- Rollback: supabase/rollbacks/20261024090000_payables_tenant_category.rollback.sql

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.payables_category_frame()'::regprocedure)
       IS DISTINCT FROM 'ac6625ba6972194e7a4f81beb33c69c3' THEN
    RAISE EXCEPTION 'precondition failed: payables_category_frame is not the version this migration was written from; nothing was changed. Regenerate it from the current definition';
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
    ('tenant','Tenant Products and Services',4),
    ('budget','Operational Expenses',5),
    ('marketing','Marketing Expenses',6),
    ('rnd','R&D (Research and Development)',7),
    ('other','Unclassified / Other',8)
  ) f(category_key, category_label, sort_order)
$function$;

RESET lock_timeout;
