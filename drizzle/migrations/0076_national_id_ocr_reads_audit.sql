CREATE TABLE IF NOT EXISTS public.national_id_ocr_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  side text NOT NULL DEFAULT 'front',
  storage_path text,
  extracted_text text,
  extracted_name text,
  extracted_id_number text,
  extracted_date_of_birth text,
  account_name text,
  account_national_id text,
  name_match_score numeric,
  name_matched boolean,
  id_number_matched boolean,
  readable boolean,
  is_national_id boolean,
  failure_reason text,
  read_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT national_id_ocr_reads_side_ck CHECK (side IN ('front','back'))
);

CREATE INDEX IF NOT EXISTS national_id_ocr_reads_user_idx
  ON public.national_id_ocr_reads (user_id, read_at DESC);

GRANT SELECT ON public.national_id_ocr_reads TO authenticated;
GRANT ALL ON public.national_id_ocr_reads TO service_role;

ALTER TABLE public.national_id_ocr_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners and withdrawal staff can view id reads" ON public.national_id_ocr_reads;
CREATE POLICY "Owners and withdrawal staff can view id reads"
ON public.national_id_ocr_reads
FOR SELECT
TO authenticated
USING (user_id = auth.uid() OR public.is_withdrawal_staff(auth.uid()));

CREATE OR REPLACE FUNCTION public.finops_national_id_ocr_reads(p_user_id uuid)
RETURNS TABLE (
  id uuid,
  side text,
  read_at timestamptz,
  extracted_text text,
  extracted_name text,
  extracted_id_number text,
  extracted_date_of_birth text,
  account_name text,
  account_national_id text,
  name_match_score numeric,
  name_matched boolean,
  id_number_matched boolean,
  readable boolean,
  is_national_id boolean,
  failure_reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  select r.id, r.side, r.read_at, r.extracted_text, r.extracted_name,
         r.extracted_id_number, r.extracted_date_of_birth, r.account_name,
         r.account_national_id, r.name_match_score, r.name_matched,
         r.id_number_matched, r.readable, r.is_national_id, r.failure_reason
  from public.national_id_ocr_reads r
  where r.user_id = p_user_id
    and (public.is_withdrawal_staff(auth.uid()) or p_user_id = auth.uid())
  order by r.read_at desc
  limit 40
$$;

GRANT EXECUTE ON FUNCTION public.finops_national_id_ocr_reads(uuid) TO authenticated;