-- Enable realtime so newly registered sub-agents appear instantly
-- on the parent agent's dashboard.
ALTER TABLE public.agent_subagents REPLICA IDENTITY FULL;
ALTER TABLE public.referrals REPLICA IDENTITY FULL;

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_subagents;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.referrals;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;