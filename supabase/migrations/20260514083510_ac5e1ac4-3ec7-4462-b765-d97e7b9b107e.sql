DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'pending_wallet_operations'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'pending_wallet_operations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.pending_wallet_operations;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'proxy_agent_assignments'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'proxy_agent_assignments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.proxy_agent_assignments;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'agent_proxy_card_dismissals'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'agent_proxy_card_dismissals'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_proxy_card_dismissals;
  END IF;
END $$;