DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.wallet_deductions'::regclass
      AND conname = 'wallet_deductions_target_user_id_fkey'
  ) THEN
    ALTER TABLE public.wallet_deductions
      DROP CONSTRAINT wallet_deductions_target_user_id_fkey;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.wallet_deductions'::regclass
      AND conname = 'wallet_deductions_deducted_by_fkey'
  ) THEN
    ALTER TABLE public.wallet_deductions
      DROP CONSTRAINT wallet_deductions_deducted_by_fkey;
  END IF;
END $$;