-- Josh (owner), 10-30: every phone number must be accepted. A foreign number typed without the "+" (e.g. Rwandan
-- 250793903844) was refused by normalize_e164_phone, so the profiles insert trigger raised invalid_phone_number and
-- signup returned a bare 500. The international branch now takes 9-15 digits with or without the "+". Uganda forms
-- are checked first and unchanged (07..., 256..., bare 9 digits); malformed Ugandan forms (07827277378, 2567712345)
-- and too-short numbers are still refused. Same change in src/lib/phoneUtils.ts and
-- supabase/functions/self-update-phone/index.ts, which mirror this function.
-- Applied to production by hand; this file is the record.
CREATE OR REPLACE FUNCTION public.normalize_e164_phone(raw text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  s        text;
  had_plus boolean;
  d        text;
  national text;
BEGIN
  IF raw IS NULL THEN RETURN NULL; END IF;
  s := btrim(raw);
  IF s = '' THEN RETURN NULL; END IF;

  had_plus := left(s, 1) = '+';
  d := regexp_replace(s, '\D', '', 'g');   -- digits only
  IF d = '' THEN RETURN NULL; END IF;

  -- Ugandan local form: leading 0, no country code (e.g. 0771234567)
  IF NOT had_plus AND left(d, 1) = '0' THEN
    national := regexp_replace(substring(d FROM 2), '^0+', '');  -- drop leading zeros
    IF length(national) = 9 THEN
      RETURN '+256' || national;
    END IF;
    RETURN NULL;  -- malformed local (e.g. 11-digit 07827277378 -> 10 national digits)
  END IF;

  -- Uganda country code, with or without + (e.g. 256771234567 / 2560771234567)
  IF left(d, 3) = '256' THEN
    national := regexp_replace(substring(d FROM 4), '^0+', '');
    IF length(national) = 9 THEN
      RETURN '+256' || national;
    END IF;
    RETURN NULL;  -- malformed 256 number
  END IF;

  -- Bare 9-digit Ugandan number without any prefix (e.g. 771234567)
  IF NOT had_plus AND length(d) = 9 THEN
    RETURN '+256' || d;
  END IF;

  -- International number, with or without the +: 9-15 digits starting with a country code
  -- (e.g. +250793903844 or 250793903844). A bare 9-digit number is Ugandan, handled above.
  IF length(d) BETWEEN 9 AND 15 THEN
    RETURN '+' || d;
  END IF;

  RETURN NULL;  -- not coercible to a valid phone number
END;
$function$;
