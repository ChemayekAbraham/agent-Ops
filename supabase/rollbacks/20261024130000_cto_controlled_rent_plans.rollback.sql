-- Removes the CTO-controlled Rent Plans tracker. The list itself is dropped with the table.
DROP FUNCTION IF EXISTS public.cto_search_rent_plans(text, integer);
DROP FUNCTION IF EXISTS public.get_cto_controlled_plan_collections();
DROP FUNCTION IF EXISTS public.cto_remove_controlled_plans(uuid[]);
DROP FUNCTION IF EXISTS public.cto_add_controlled_plans(uuid[], text);
DROP TABLE IF EXISTS public.cto_controlled_rent_plans;
