CREATE TABLE IF NOT EXISTS public.merchandise_share_codes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code text NOT NULL UNIQUE,
  catalog_id uuid NOT NULL REFERENCES public.merchandise_catalog(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merch_share_codes_catalog ON public.merchandise_share_codes(catalog_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_merch_share_codes_owner ON public.merchandise_share_codes(catalog_id, created_by);

GRANT SELECT ON public.merchandise_share_codes TO authenticated;
GRANT SELECT ON public.merchandise_share_codes TO anon;
GRANT ALL ON public.merchandise_share_codes TO service_role;

ALTER TABLE public.merchandise_share_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "share codes readable" ON public.merchandise_share_codes;
CREATE POLICY "share codes readable"
  ON public.merchandise_share_codes FOR SELECT
  USING (true);

ALTER TABLE public.merchandise_share_opens ADD COLUMN IF NOT EXISTS share_code text;

CREATE OR REPLACE FUNCTION public.get_merchandise_share_code(p_catalog_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_code text;
  v_try int := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.merchandise_catalog WHERE id = p_catalog_id) THEN
    RAISE EXCEPTION 'Unknown merchandise item';
  END IF;

  SELECT code INTO v_code
  FROM public.merchandise_share_codes
  WHERE catalog_id = p_catalog_id AND created_by = v_uid
  LIMIT 1;

  IF v_code IS NOT NULL THEN
    RETURN v_code;
  END IF;

  LOOP
    v_try := v_try + 1;
    v_code := lower(substr(replace(encode(gen_random_bytes(8), 'base64'), '/', ''), 1, 6));
    v_code := regexp_replace(v_code, '[^a-z0-9]', '', 'g');
    IF length(v_code) < 5 THEN
      CONTINUE;
    END IF;
    BEGIN
      INSERT INTO public.merchandise_share_codes (code, catalog_id, created_by)
      VALUES (v_code, p_catalog_id, v_uid);
      RETURN v_code;
    EXCEPTION WHEN unique_violation THEN
      SELECT code INTO v_code
      FROM public.merchandise_share_codes
      WHERE catalog_id = p_catalog_id AND created_by = v_uid
      LIMIT 1;
      IF v_code IS NOT NULL THEN
        RETURN v_code;
      END IF;
    END;
    EXIT WHEN v_try > 12;
  END LOOP;

  RAISE EXCEPTION 'Could not allocate share code';
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_merchandise_share_code(uuid) TO authenticated;