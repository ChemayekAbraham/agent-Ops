ALTER TABLE public.landlord_agreements
  ALTER COLUMN nin DROP NOT NULL,
  ALTER COLUMN landlord_signed_on DROP NOT NULL,
  ALTER COLUMN welile_signed_on DROP NOT NULL,
  ALTER COLUMN witness_signed_on DROP NOT NULL;