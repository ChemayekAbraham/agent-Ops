-- Full row data in change events (needed for UPDATE/DELETE payloads)
ALTER TABLE public.cash_deposit_verifications REPLICA IDENTITY FULL;

-- Add the table to the realtime publication so changes are streamed
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'cash_deposit_verifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.cash_deposit_verifications;
  END IF;
END $$;

-- Allow Financial Ops verifiers to receive realtime change events.
-- Realtime enforces RLS on the subscribing user, so these roles must be able
-- to read the rows for the panel's live subscription to fire.
CREATE POLICY "Fin ops can read cash deposit verifications"
  ON public.cash_deposit_verifications
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'operations')
  );