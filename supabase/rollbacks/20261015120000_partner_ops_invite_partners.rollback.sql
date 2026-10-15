-- Rollback for drizzle/migrations/0578_partner_ops_invite_partners.sql
-- The migration only adds one read-only function, so removing it is the whole rollback. No data, table, policy or existing function was touched.
DROP FUNCTION IF EXISTS public.partner_ops_invite_partners(uuid[]);
