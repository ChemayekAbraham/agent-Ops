-- Rollback for 20261014140000_rent_request_desk_order.sql
-- Drops the one new function. Nothing existing was edited by the migration, so nothing else needs restoring.
-- Roll the app back with it (src/hooks/useRentDeskOrder.ts and its three callers): a desk whose ordering call fails simply
-- keeps the order it already had, so the screens keep working while the two are out of step.
DROP FUNCTION IF EXISTS public.rent_request_desk_order(uuid[], text);
