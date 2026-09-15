-- National ID: keep what the card reader saw AND what the person confirmed.
--
-- WHY BOTH
-- The reader prefills six fields and the person may correct any of them. That
-- correction is necessary - OCR misreads worn cards - but it also means the
-- submitted values are, on their own, just typing. What makes the pair useful
-- is the DIFFERENCE: a field the person overwrote is exactly where a reviewer
-- should look. Storing only the confirmed values would throw that away and
-- leave Financial Ops no better off than before the reader existed.
--
-- The six fields land on `profiles` as the account's identity details. The
-- reading, the divergence and the reader's own per-field verdicts live in
-- `national_id_readings`, one row per submission, so the history survives a
-- later correction.
--
-- PRIVACY: a National ID carries name, NIN, date of birth and card number
-- together. Read access is the owner plus the staff who verify payouts -
-- nobody else, and never anonymous.
--
-- Reference data only. No wallet, ledger or financial record is touched here.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS date_of_birth date,
  ADD COLUMN IF NOT EXISTS sex text,
  ADD COLUMN IF NOT EXISTS national_id_card_number text,
  ADD COLUMN IF NOT EXISTS national_id_surname text,
  ADD COLUMN IF NOT EXISTS national_id_given_name text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_sex_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_sex_check CHECK (sex IS NULL OR sex IN ('M','F'));
  END IF;
END $$;

COMMENT ON COLUMN public.profiles.date_of_birth IS
  'Date of birth as printed on the National ID and confirmed by the account holder. Asserted, not verified against NIRA.';
COMMENT ON COLUMN public.profiles.national_id_card_number IS
  'The CARD number printed on the National ID - changes when a card is reissued. Not the NIN.';


CREATE TABLE IF NOT EXISTS public.national_id_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- What the reader returned.
  sha256 text,
  status text,                                   -- valid | incomplete | invalid
  confidence numeric,
  ocr jsonb NOT NULL DEFAULT '{}'::jsonb,        -- the six fields as read
  field_verdicts jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing text[] NOT NULL DEFAULT '{}',
  consistency jsonb NOT NULL DEFAULT '[]'::jsonb, -- FAILED cross-checks only
  -- What the person submitted.
  confirmed jsonb NOT NULL DEFAULT '{}'::jsonb,
  edited_fields text[] NOT NULL DEFAULT '{}',    -- where the two disagree
  face_verified boolean,                         -- selfie face check at the time
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS national_id_readings_user_idx
  ON public.national_id_readings (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS national_id_readings_edited_idx
  ON public.national_id_readings (created_at DESC)
  WHERE array_length(edited_fields, 1) > 0;

ALTER TABLE public.national_id_readings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owner reads own ID readings" ON public.national_id_readings;
CREATE POLICY "Owner reads own ID readings"
  ON public.national_id_readings FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Payout staff read ID readings" ON public.national_id_readings;
CREATE POLICY "Payout staff read ID readings"
  ON public.national_id_readings FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  );

GRANT SELECT ON public.national_id_readings TO authenticated;
GRANT ALL ON public.national_id_readings TO service_role;


-- ---------------------------------------------------------------------------
-- Submit the six confirmed fields in one call.
--
-- Supersedes `submit_national_id(p_national_id, p_id_name)`, which took only a
-- number and a name and is kept for older callers.
--
-- The browser may only ASK. Every format is re-checked here and the NIN
-- uniqueness rule is re-applied, so a caller that skipped the screen's own
-- validation gains nothing. A refusal writes nothing at all - no profile
-- change, no reading row - so a rejected submission never leaves a half-state.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_national_id_details(
  p_surname text,
  p_given_name text,
  p_nin text,
  p_date_of_birth date,
  p_card_number text,
  p_sex text,
  p_reading jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_surname text := upper(btrim(coalesce(p_surname,'')));
  v_given   text := upper(btrim(coalesce(p_given_name,'')));
  v_nin     text := upper(regexp_replace(coalesce(p_nin,''), '[^A-Za-z0-9]', '', 'g'));
  v_card    text := regexp_replace(coalesce(p_card_number,''), '[^0-9]', '', 'g');
  v_sex     text := upper(btrim(coalesce(p_sex,'')));
  v_name    text;
  v_taken   uuid;
  v_ocr     jsonb := coalesce(p_reading->'data', '{}'::jsonb);
  v_edited  text[] := '{}';
  v_reading_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Please sign in again.');
  END IF;

  IF v_surname !~ '^[A-Z][A-Z ''-]{1,39}$' THEN
    RETURN jsonb_build_object('success', false, 'field', 'surname',
      'message', 'Enter the surname exactly as printed on the card.');
  END IF;
  IF v_given !~ '^[A-Z][A-Z ''-]{1,39}$' THEN
    RETURN jsonb_build_object('success', false, 'field', 'given_name',
      'message', 'Enter the given name exactly as printed on the card.');
  END IF;
  IF v_nin !~ '^[A-Z0-9]{12,16}$' THEN
    RETURN jsonb_build_object('success', false, 'field', 'nin',
      'message', 'A NIN is 12 to 16 letters and numbers, with no spaces.');
  END IF;
  IF p_date_of_birth IS NULL
     OR p_date_of_birth > current_date
     OR extract(year FROM p_date_of_birth) < 1900 THEN
    RETURN jsonb_build_object('success', false, 'field', 'date_of_birth',
      'message', 'Enter the date of birth printed on the card.');
  END IF;
  IF v_card !~ '^[0-9]{6,12}$' THEN
    RETURN jsonb_build_object('success', false, 'field', 'card_number',
      'message', 'The card number is the row of digits on the card.');
  END IF;
  IF v_sex NOT IN ('M','F') THEN
    RETURN jsonb_build_object('success', false, 'field', 'sex',
      'message', 'Sex must be M or F, as printed on the card.');
  END IF;

  -- One National ID, one account. (If the FIFO linking rule is ever adopted,
  -- this is the single place that changes.)
  SELECT public.duplicate_national_id_owner(v_uid, v_nin) INTO v_taken;
  IF v_taken IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'duplicate', true, 'field', 'nin',
      'message', 'This National ID is already recorded on another account. One ID can verify one account only.');
  END IF;

  v_name := btrim(v_given || ' ' || v_surname);

  -- Which of the six the person changed after the reader filled them in.
  IF coalesce(v_ocr->>'surname','')       IS DISTINCT FROM v_surname THEN v_edited := v_edited || 'surname'; END IF;
  IF coalesce(v_ocr->>'given_name','')    IS DISTINCT FROM v_given   THEN v_edited := v_edited || 'given_name'; END IF;
  IF coalesce(v_ocr->>'nin','')           IS DISTINCT FROM v_nin     THEN v_edited := v_edited || 'nin'; END IF;
  IF coalesce(v_ocr->>'date_of_birth','') IS DISTINCT FROM to_char(p_date_of_birth,'YYYY-MM-DD') THEN v_edited := v_edited || 'date_of_birth'; END IF;
  IF coalesce(v_ocr->>'card_number','')   IS DISTINCT FROM v_card    THEN v_edited := v_edited || 'card_number'; END IF;
  IF coalesce(v_ocr->>'sex','')           IS DISTINCT FROM v_sex     THEN v_edited := v_edited || 'sex'; END IF;

  BEGIN
    UPDATE public.profiles
       SET national_id              = v_nin,
           national_id_name         = v_name,
           national_id_surname      = v_surname,
           national_id_given_name   = v_given,
           national_id_card_number  = v_card,
           date_of_birth            = p_date_of_birth,
           sex                      = v_sex
     WHERE id = v_uid;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'duplicate', true, 'field', 'nin',
      'message', 'This National ID is already recorded on another account.');
  END;

  UPDATE public.payout_destination_verifications d
     SET national_id = v_nin,
         national_id_name = v_name,
         national_id_submitted_at = now(),
         name_match_score = (public.payout_name_match_report(v_name, d.account_name)->>'score')::numeric,
         name_mismatch_tokens = coalesce(public.payout_name_match_report(v_name, d.account_name)->'diff', '[]'::jsonb)
   WHERE d.user_id = v_uid;

  INSERT INTO public.national_id_readings (
    user_id, sha256, status, confidence, ocr, field_verdicts, missing, consistency,
    confirmed, edited_fields, face_verified
  ) VALUES (
    v_uid,
    nullif(p_reading->>'sha256',''),
    nullif(p_reading->>'status',''),
    nullif(p_reading->>'confidence','')::numeric,
    v_ocr,
    coalesce(p_reading->'fields', '{}'::jsonb),
    coalesce((SELECT array_agg(x::text) FROM jsonb_array_elements_text(coalesce(p_reading->'missing','[]'::jsonb)) x), '{}'),
    coalesce(p_reading->'consistency', '[]'::jsonb),
    jsonb_build_object('surname', v_surname, 'given_name', v_given, 'nin', v_nin,
                       'date_of_birth', to_char(p_date_of_birth,'YYYY-MM-DD'),
                       'card_number', v_card, 'sex', v_sex),
    v_edited,
    CASE WHEN p_reading ? 'face_verified' THEN (p_reading->>'face_verified')::boolean END
  ) RETURNING id INTO v_reading_id;

  -- Deliberately records the FIELD NAMES that were corrected, never the values:
  -- an audit row must not become a second copy of somebody's National ID.
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_uid, 'national_id_details_submitted', 'profiles', v_uid::text,
          'Account holder confirmed the details read from their National ID.',
          jsonb_build_object('reading_id', v_reading_id,
                             'status', p_reading->>'status',
                             'edited_fields', to_jsonb(v_edited)));

  RETURN jsonb_build_object(
    'success', true,
    'reading_id', v_reading_id,
    'edited_fields', to_jsonb(v_edited),
    'full_name', v_name,
    'message', 'National ID details saved.');
END;
$function$;

COMMENT ON FUNCTION public.submit_national_id_details(text, text, text, date, text, text, jsonb) IS
  'Records the six National ID fields the account holder confirmed, alongside what the card reader saw, and flags which fields they corrected.';

GRANT EXECUTE ON FUNCTION public.submit_national_id_details(text, text, text, date, text, text, jsonb) TO authenticated;
