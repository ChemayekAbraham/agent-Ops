-- 1. Name-match helper: token overlap score + differing tokens
CREATE OR REPLACE FUNCTION public.payout_name_match_report(p_a text, p_b text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  a_tokens text[];
  b_tokens text[];
  v_common int := 0;
  v_diff text[] := '{}';
  t text;
BEGIN
  IF coalesce(btrim(p_a),'') = '' OR coalesce(btrim(p_b),'') = '' THEN
    RETURN jsonb_build_object('score', NULL, 'diff', '[]'::jsonb);
  END IF;

  SELECT array_agg(x) INTO a_tokens FROM (
    SELECT DISTINCT x FROM unnest(
      regexp_split_to_array(regexp_replace(lower(btrim(p_a)), '[^a-z0-9 ]', ' ', 'g'), '\s+')
    ) AS x WHERE length(x) > 1
  ) s;
  SELECT array_agg(x) INTO b_tokens FROM (
    SELECT DISTINCT x FROM unnest(
      regexp_split_to_array(regexp_replace(lower(btrim(p_b)), '[^a-z0-9 ]', ' ', 'g'), '\s+')
    ) AS x WHERE length(x) > 1
  ) s;

  IF a_tokens IS NULL OR b_tokens IS NULL THEN
    RETURN jsonb_build_object('score', NULL, 'diff', '[]'::jsonb);
  END IF;

  FOREACH t IN ARRAY a_tokens LOOP
    IF t = ANY (b_tokens) THEN
      v_common := v_common + 1;
    ELSE
      v_diff := v_diff || t;
    END IF;
  END LOOP;

  FOREACH t IN ARRAY b_tokens LOOP
    IF NOT (t = ANY (a_tokens)) THEN
      v_diff := v_diff || t;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'score', round((v_common::numeric / greatest(array_length(a_tokens,1), array_length(b_tokens,1)))::numeric, 2),
    'diff', to_jsonb(v_diff)
  );
END;
$$;

-- 2. Canonical destination key (phones normalised to last 9 digits)
CREATE OR REPLACE FUNCTION public.payout_destination_key(
  p_method text,
  p_momo_number text DEFAULT NULL,
  p_bank_name text DEFAULT NULL,
  p_bank_account_number text DEFAULT NULL
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE lower(coalesce(p_method,''))
    WHEN 'mobile_money' THEN
      CASE WHEN coalesce(btrim(p_momo_number),'') = '' THEN NULL
           ELSE 'momo:' || right(regexp_replace(p_momo_number, '\D', '', 'g'), 9) END
    WHEN 'bank_transfer' THEN
      CASE WHEN coalesce(btrim(p_bank_account_number),'') = '' THEN NULL
           ELSE 'bank:' || lower(regexp_replace(coalesce(p_bank_name,''), '[^a-zA-Z0-9]', '', 'g'))
                || ':' || regexp_replace(p_bank_account_number, '\D', '', 'g') END
    ELSE NULL
  END;
$$;

-- 3. The verification record
CREATE TABLE IF NOT EXISTS public.payout_destination_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  destination_type text NOT NULL CHECK (destination_type IN ('mobile_money','bank_transfer')),
  destination_key text NOT NULL,
  provider text,
  momo_number text,
  bank_name text,
  bank_account_number text,
  account_name text,
  national_id text,
  national_id_name text,
  name_match_score numeric,
  name_mismatch_tokens jsonb DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','verified','rejected')),
  call_outcome text,
  decision_reason text,
  decided_by uuid,
  decided_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_dest_unique_per_user UNIQUE (user_id, destination_key)
);

CREATE INDEX IF NOT EXISTS idx_payout_dest_status ON public.payout_destination_verifications (status, first_seen_at);
CREATE INDEX IF NOT EXISTS idx_payout_dest_user ON public.payout_destination_verifications (user_id);

GRANT SELECT ON public.payout_destination_verifications TO authenticated;
GRANT ALL ON public.payout_destination_verifications TO service_role;

ALTER TABLE public.payout_destination_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner reads own payout destinations"
ON public.payout_destination_verifications
FOR SELECT TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "Finance reads all payout destinations"
ON public.payout_destination_verifications
FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE OR REPLACE FUNCTION public.touch_payout_destination_verifications()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_payout_dest ON public.payout_destination_verifications;
CREATE TRIGGER trg_touch_payout_dest
BEFORE UPDATE ON public.payout_destination_verifications
FOR EACH ROW EXECUTE FUNCTION public.touch_payout_destination_verifications();

-- 4. National ID name on the profile (additive, nullable)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS national_id_name text;

-- 5. Backfill: every destination ever used, and every saved method, starts as waiting
INSERT INTO public.payout_destination_verifications (
  user_id, destination_type, destination_key, provider,
  momo_number, bank_name, bank_account_number, account_name, first_seen_at
)
SELECT DISTINCT ON (w.user_id, public.payout_destination_key(w.payout_method, w.mobile_money_number, w.bank_name, w.bank_account_number))
  w.user_id,
  CASE WHEN lower(w.payout_method) = 'mobile_money' THEN 'mobile_money' ELSE 'bank_transfer' END,
  public.payout_destination_key(w.payout_method, w.mobile_money_number, w.bank_name, w.bank_account_number),
  CASE WHEN lower(w.payout_method) = 'mobile_money' THEN lower(w.mobile_money_provider) ELSE 'bank' END,
  CASE WHEN lower(w.payout_method) = 'mobile_money' THEN btrim(w.mobile_money_number) END,
  CASE WHEN lower(w.payout_method) = 'bank_transfer' THEN btrim(w.bank_name) END,
  CASE WHEN lower(w.payout_method) = 'bank_transfer' THEN btrim(w.bank_account_number) END,
  coalesce(nullif(btrim(w.mobile_money_name), ''), nullif(btrim(w.bank_account_name), '')),
  min(w.created_at) OVER (PARTITION BY w.user_id, public.payout_destination_key(w.payout_method, w.mobile_money_number, w.bank_name, w.bank_account_number))
FROM public.withdrawal_requests w
WHERE lower(coalesce(w.payout_method,'')) IN ('mobile_money','bank_transfer')
  AND w.user_id IS NOT NULL
  AND public.payout_destination_key(w.payout_method, w.mobile_money_number, w.bank_name, w.bank_account_number) IS NOT NULL
ON CONFLICT (user_id, destination_key) DO NOTHING;

INSERT INTO public.payout_destination_verifications (
  user_id, destination_type, destination_key, provider,
  momo_number, bank_name, bank_account_number, account_name, first_seen_at
)
SELECT DISTINCT ON (s.user_id, public.payout_destination_key(s.payout_mode, s.momo_number, s.bank_name, s.bank_account_number))
  s.user_id,
  CASE WHEN s.payout_mode = 'mobile_money' THEN 'mobile_money' ELSE 'bank_transfer' END,
  public.payout_destination_key(s.payout_mode, s.momo_number, s.bank_name, s.bank_account_number),
  CASE WHEN s.payout_mode = 'mobile_money' THEN lower(coalesce(s.momo_provider,'')) ELSE 'bank' END,
  CASE WHEN s.payout_mode = 'mobile_money' THEN btrim(s.momo_number) END,
  CASE WHEN s.payout_mode = 'bank_transfer' THEN btrim(s.bank_name) END,
  CASE WHEN s.payout_mode = 'bank_transfer' THEN btrim(s.bank_account_number) END,
  coalesce(nullif(btrim(s.momo_name), ''), nullif(btrim(s.bank_account_name), '')),
  s.created_at
FROM public.saved_payout_methods s
WHERE s.payout_mode IN ('mobile_money','bank_transfer')
  AND public.payout_destination_key(s.payout_mode, s.momo_number, s.bank_name, s.bank_account_number) IS NOT NULL
ON CONFLICT (user_id, destination_key) DO NOTHING;

-- Stamp the National ID snapshot + name match on the backfilled rows
UPDATE public.payout_destination_verifications d
SET national_id = p.national_id,
    national_id_name = p.national_id_name,
    name_match_score = (public.payout_name_match_report(coalesce(p.national_id_name, p.full_name), d.account_name)->>'score')::numeric,
    name_mismatch_tokens = coalesce(public.payout_name_match_report(coalesce(p.national_id_name, p.full_name), d.account_name)->'diff', '[]'::jsonb)
FROM public.profiles p
WHERE p.id = d.user_id;
