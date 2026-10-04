-- `wallets` is a view over `wallets_physical`. Publish the physical table
-- so apply_wallet_movement UPDATEs flow through Supabase Realtime to the
-- client's useWalletRealtime hook (scoped per-user via user_id filter).
ALTER TABLE public.wallets_physical REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'wallets_physical'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.wallets_physical';
  END IF;
END $$;