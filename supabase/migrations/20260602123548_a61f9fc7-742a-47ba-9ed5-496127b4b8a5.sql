GRANT SELECT ON public.cash_deposit_verifications TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'cash_deposit_verifications'
      AND policyname = 'Owners can read their cash deposit verifications'
  ) THEN
    CREATE POLICY "Owners can read their cash deposit verifications"
      ON public.cash_deposit_verifications
      FOR SELECT
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END $$;