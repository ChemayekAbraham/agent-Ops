DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.general_ledger'::regclass
      AND conname = 'general_ledger_wallet_id_fkey'
  ) THEN
    ALTER TABLE public.general_ledger
      DROP CONSTRAINT general_ledger_wallet_id_fkey;
  END IF;
END $$;