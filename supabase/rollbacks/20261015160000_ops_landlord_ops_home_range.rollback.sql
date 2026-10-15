-- Rollback for 20261015160000_ops_landlord_ops_home_range.sql: the migration only adds one read-only function.
DROP FUNCTION IF EXISTS public.ops_landlord_ops_home_range(timestamptz, timestamptz);
