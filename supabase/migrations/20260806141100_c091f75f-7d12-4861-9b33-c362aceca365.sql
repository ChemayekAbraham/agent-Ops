CREATE OR REPLACE FUNCTION public.fin_ops_reissue_cash_code(p_verification_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_code text;
  v_rec record;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'operations')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT * INTO v_rec FROM public.cash_deposit_verifications WHERE id = p_verification_id;
  IF v_rec.id IS NULL THEN
    RAISE EXCEPTION 'verification_not_found';
  END IF;
  IF v_rec.status = 'verified' THEN
    RAISE EXCEPTION 'already_verified';
  END IF;

  v_code := lpad((floor(random() * 10000))::int::text, 4, '0');

  UPDATE public.cash_deposit_verifications
     SET code_hash = encode(extensions.digest(v_code::bytea, 'sha256'::text), 'hex'),
         code_plain = v_code,
         status = 'awaiting_code',
         attempts = 0,
         expires_at = now() + interval '10 minutes'
   WHERE id = p_verification_id;

  RETURN v_code;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fin_ops_reissue_cash_code(uuid) TO authenticated;