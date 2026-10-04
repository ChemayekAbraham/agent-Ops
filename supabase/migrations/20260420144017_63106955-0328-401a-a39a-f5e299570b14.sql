DO $$
DECLARE
  conname text;
BEGIN
  SELECT c.conname INTO conname
  FROM pg_constraint c
  WHERE c.conrelid = 'public.general_ledger'::regclass
    AND c.contype = 'f'
    AND c.confrelid = 'auth.users'::regclass
  LIMIT 1;

  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.general_ledger DROP CONSTRAINT %I', conname);
  END IF;
END $$;

ALTER TABLE public.general_ledger
  ADD CONSTRAINT general_ledger_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id)
  ON DELETE NO ACTION
  NOT VALID;