-- Daily encrypted backup of Supporter (partner) and tenant data.
--
-- The edge function partner-tenant-daily-backup runs every night at 02:00
-- Kampala time. It exports the six tables below as CSV, zips them with AES-256
-- under a fresh random password, stores the zip in the private bucket
-- partner-tenant-backups, opens it again to check every row count, keeps the
-- newest good backup of each of the last 7 days and deletes the rest. Only the
-- password (never the file) is emailed, straight through Mailgun so it is not
-- written to email_send_log or the email queue.
--
-- People in scope: Supporters (anyone with an investor_portfolios row) and
-- tenants (anyone with a rent_requests row, i.e. a Rent Plan).
--   profiles, wallets          -> only rows for those people (functions below)
--   investor_portfolios, rent_requests, repayments, agent_collections
--                              -> whole table (every row belongs to them)
-- investor_portfolios.portfolio_pin and activation_token are credentials and
-- are left out of the export.

-- 1. Private bucket. No storage.objects policies on purpose: only service_role
--    (the edge function and the Supabase dashboard) can read or write it.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('partner-tenant-backups', 'partner-tenant-backups', false, 209715200, ARRAY['application/zip'])
ON CONFLICT (id) DO NOTHING;

-- 2. Column lists and start-of-run row counts. Columns come from the live
--    schema so a new column is backed up without a code change; id is always
--    first because the export pages by it.
CREATE OR REPLACE FUNCTION public.partner_tenant_backup_manifest()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH people AS (
    SELECT investor_id AS id FROM public.investor_portfolios
    UNION
    SELECT tenant_id FROM public.rent_requests
  ),
  cols AS (
    SELECT c.table_name::text AS table_name,
           jsonb_agg(c.column_name::text ORDER BY (c.column_name <> 'id'), c.ordinal_position) AS columns
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name IN ('profiles', 'wallets', 'investor_portfolios', 'rent_requests', 'repayments', 'agent_collections')
      AND NOT (c.table_name = 'investor_portfolios' AND c.column_name IN ('portfolio_pin', 'activation_token'))
    GROUP BY c.table_name
  )
  SELECT jsonb_build_object(
    'partners', (SELECT count(DISTINCT investor_id) FROM public.investor_portfolios),
    'tenants', (SELECT count(DISTINCT tenant_id) FROM public.rent_requests),
    'columns', (SELECT jsonb_object_agg(table_name, columns) FROM cols),
    'rows', jsonb_build_object(
      'profiles', (SELECT count(*) FROM public.profiles WHERE id IN (SELECT id FROM people)),
      'wallets', (SELECT count(*) FROM public.wallets WHERE user_id IN (SELECT id FROM people)),
      'investor_portfolios', (SELECT count(*) FROM public.investor_portfolios),
      'rent_requests', (SELECT count(*) FROM public.rent_requests),
      'repayments', (SELECT count(*) FROM public.repayments),
      'agent_collections', (SELECT count(*) FROM public.agent_collections)
    )
  );
$$;

-- 3. One page of in-scope profiles / wallets, keyset by id:
--    id > p_after (null = from the start), id <= p_through (null = no bound).
CREATE OR REPLACE FUNCTION public.partner_tenant_backup_profiles(
  p_after uuid DEFAULT NULL, p_through uuid DEFAULT NULL, p_limit integer DEFAULT 1000)
RETURNS SETOF public.profiles
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT p.* FROM public.profiles p
  WHERE p.id IN (SELECT investor_id FROM public.investor_portfolios
                 UNION SELECT tenant_id FROM public.rent_requests)
    AND (p_after IS NULL OR p.id > p_after)
    AND (p_through IS NULL OR p.id <= p_through)
  ORDER BY p.id
  LIMIT least(greatest(p_limit, 1), 1000);
$$;

CREATE OR REPLACE FUNCTION public.partner_tenant_backup_wallets(
  p_after uuid DEFAULT NULL, p_through uuid DEFAULT NULL, p_limit integer DEFAULT 1000)
RETURNS SETOF public.wallets
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT w.* FROM public.wallets w
  WHERE w.user_id IN (SELECT investor_id FROM public.investor_portfolios
                      UNION SELECT tenant_id FROM public.rent_requests)
    AND (p_after IS NULL OR w.id > p_after)
    AND (p_through IS NULL OR w.id <= p_through)
  ORDER BY w.id
  LIMIT least(greatest(p_limit, 1), 1000);
$$;

-- Bulk personal data: service_role only.
REVOKE ALL ON FUNCTION public.partner_tenant_backup_manifest() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partner_tenant_backup_profiles(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partner_tenant_backup_wallets(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_tenant_backup_manifest() TO service_role;
GRANT EXECUTE ON FUNCTION public.partner_tenant_backup_profiles(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.partner_tenant_backup_wallets(uuid, uuid, integer) TO service_role;

-- 4. Nightly at 02:00 EAT (23:00 UTC), after the 01:00 EAT ledger backup.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'partner-tenant-daily-backup';
  PERFORM cron.schedule('partner-tenant-daily-backup', '0 23 * * *', $cmd$
  SELECT net.http_post(
    url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/partner-tenant-daily-backup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key' LIMIT 1), '')
    ),
    body := jsonb_build_object('scheduled_at', now())
  );
  $cmd$);
END
$$;
