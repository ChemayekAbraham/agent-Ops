DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.promissory_notes;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;