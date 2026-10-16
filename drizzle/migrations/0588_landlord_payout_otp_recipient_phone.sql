ALTER TABLE public.landlord_payout_otp_challenges
  ADD COLUMN IF NOT EXISTS otp_recipient_phone text;

COMMENT ON COLUMN public.landlord_payout_otp_challenges.otp_recipient_phone IS
  'Phone the OTP SMS is sent to: the landlord registered contact number (landlords.phone), falling back to the approved payout number when no contact phone exists. landlord_phone remains the verified payout (mobile money) number and is untouched by this column.';

UPDATE public.landlord_payout_otp_challenges
  SET otp_recipient_phone = landlord_phone
  WHERE otp_recipient_phone IS NULL;