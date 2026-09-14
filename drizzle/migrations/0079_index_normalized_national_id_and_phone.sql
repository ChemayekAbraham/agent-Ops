-- Speeds up the "one ID / one phone number per account" lookups.
CREATE INDEX IF NOT EXISTS profiles_national_id_norm_idx
  ON public.profiles ((upper(regexp_replace(coalesce(national_id, ''), '[^A-Za-z0-9]', '', 'g'))));

CREATE INDEX IF NOT EXISTS profiles_phone_norm9_idx
  ON public.profiles ((right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 9)));

CREATE INDEX IF NOT EXISTS pdv_user_status_idx
  ON public.payout_destination_verifications (user_id, status);
