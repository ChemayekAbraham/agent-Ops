DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='wallet_transactions') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.wallet_transactions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='wallets_physical') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.wallets_physical';
  END IF;
END $$;

ALTER TABLE public.wallet_transactions REPLICA IDENTITY FULL;
ALTER TABLE public.wallets_physical REPLICA IDENTITY FULL;