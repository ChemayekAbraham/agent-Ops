-- Signup 500, 11 Nov 2026 (~18:00-19:00 EAT): POST /auth/v1/signup failed because
-- trg_normalize_validate_profile_phone raised
--   invalid_phone_number: "00256754206985" is not a valid phone number.
-- That is a Ugandan mobile written with the 00 international dialling prefix
-- (00 256 754206985). The previous function (20261030120300) treated every
-- no-plus digit string starting with 0 as Ugandan local form, stripped the
-- leading zeros and required exactly 9 national digits, so 00256754206985
-- (12 digits after the zeros) returned NULL.
--
-- A leading 00 with no "+" is now the international dialling prefix, equivalent
-- to "+". It is rewritten only when the digits after 00 are a 10-15 digit
-- country-code number that does not itself start with 0. Local forms that
-- legitimately start with zeros stay on the existing Ugandan path:
-- 0771234567 and 00771234567 still become +256771234567.
-- Signature, IMMUTABLE, search_path and every other branch are unchanged.
-- CREATE OR REPLACE keeps the existing EXECUTE grants. The trigger is untouched.

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
  intl     text;
BEGIN
  IF raw IS NULL THEN RETURN NULL; END IF;
  s := btrim(raw);
  IF s = '' THEN RETURN NULL; END IF;

  had_plus := left(s, 1) = '+';
  d := regexp_replace(s, '\D', '', 'g');   -- digits only
  IF d = '' THEN RETURN NULL; END IF;

  -- "00" without a "+" is the international dialling prefix (same as "+").
  -- Only when what follows is a 10-15 digit country-code number that does
  -- not start with 0. 0771234567 and 00771234567 stay on the local path below.
  IF NOT had_plus AND left(d, 2) = '00' THEN
    intl := substring(d FROM 3);
    IF length(intl) BETWEEN 10 AND 15 AND left(intl, 1) <> '0' THEN
      had_plus := true;
      d := intl;
    END IF;
  END IF;

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

-- Required results, the double-zero local form that must stay Ugandan, and the
-- branches this replacement must not change.
DO $assert$
DECLARE
  r   record;
  got text;
BEGIN
  FOR r IN
    SELECT *
    FROM (VALUES
      ('00256754206985'::text, '+256754206985'::text),
      ('00250793903844',       '+250793903844'),
      ('0771234567',           '+256771234567'),
      ('+256771234567',        '+256771234567'),
      ('256771234567',         '+256771234567'),
      ('771234567',            '+256771234567'),
      ('07827277378',          NULL),
      ('',                     NULL),
      -- local form with an extra leading 0; 00 is NOT an international prefix here
      ('00771234567',          '+256771234567'),
      -- unchanged: international without "+", Uganda trunk zero, malformed, too short
      ('250793903844',         '+250793903844'),
      ('+250793903844',        '+250793903844'),
      ('254712345678',         '+254712345678'),
      ('2560771234567',        '+256771234567'),
      ('2567712345',           NULL),
      ('+25779',               NULL),
      ('072',                  NULL),
      ('   ',                  NULL)
    ) AS t(raw, expected)
  LOOP
    got := public.normalize_e164_phone(r.raw);
    IF got IS DISTINCT FROM r.expected THEN
      RAISE EXCEPTION
        'normalize_e164_phone(%) returned %, expected %',
        r.raw, coalesce(got, '<NULL>'), coalesce(r.expected, '<NULL>');
    END IF;
  END LOOP;

  got := public.normalize_e164_phone(NULL);
  IF got IS NOT NULL THEN
    RAISE EXCEPTION 'normalize_e164_phone(NULL) returned %, expected NULL', got;
  END IF;
END
$assert$;
