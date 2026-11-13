-- Pending record when a Supporter pays a verified Rent Plan outside the Welile
-- wallet: mobile money sent to the landlord, or cash taken to the landlord.
-- Nothing here debits a wallet, posts the ledger, or approves a payout.
-- Welile confirms the row later. Until then status stays pending.
--
-- REQUIRES CEO YES before this file is applied.

CREATE TABLE IF NOT EXISTS public.funder_offplatform_rent_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  funder_id uuid NOT NULL,
  rent_request_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('mobile_money', 'cash')),
  amount numeric NOT NULL CHECK (amount > 0),
  provider text NULL CHECK (provider IS NULL OR provider IN ('mtn', 'airtel')),
  reference text NULL,
  paid_at timestamptz NULL,
  receipt_photo_path text NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.funder_offplatform_rent_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS funder_reads_own_offplatform_rent ON public.funder_offplatform_rent_payments;
CREATE POLICY funder_reads_own_offplatform_rent
  ON public.funder_offplatform_rent_payments
  FOR SELECT
  TO authenticated
  USING (funder_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS mfa_required_for_staff ON public.funder_offplatform_rent_payments;
CREATE POLICY mfa_required_for_staff
  ON public.funder_offplatform_rent_payments
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

GRANT SELECT ON public.funder_offplatform_rent_payments TO authenticated;
GRANT ALL ON public.funder_offplatform_rent_payments TO service_role;

CREATE INDEX IF NOT EXISTS funder_offplatform_rent_payments_funder
  ON public.funder_offplatform_rent_payments (funder_id, created_at DESC);

INSERT INTO storage.buckets (id, name, public)
VALUES ('funder-offplatform-receipts', 'funder-offplatform-receipts', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS funder_uploads_own_offplatform_receipt ON storage.objects;
CREATE POLICY funder_uploads_own_offplatform_receipt
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'funder-offplatform-receipts'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

DROP POLICY IF EXISTS funder_reads_own_offplatform_receipt ON storage.objects;
CREATE POLICY funder_reads_own_offplatform_receipt
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'funder-offplatform-receipts'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

-- Same verified rule as funder_verified_rent_plan_dossier, without requiring
-- that the caller already funds the plan. Direct and cash payments are how
-- they fund it.
CREATE OR REPLACE FUNCTION public.funder_plan_is_verified(p_rent_request_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
  v_visible boolean;
  v_reviewed timestamptz;
  v_agent uuid;
  v_eligible boolean := true;
BEGIN
  SELECT status, COALESCE(funder_visible, true), coo_reviewed_at,
         COALESCE(assigned_agent_id, agent_id)
    INTO v_status, v_visible, v_reviewed, v_agent
    FROM public.rent_requests
   WHERE id = p_rent_request_id;
  IF NOT FOUND OR v_reviewed IS NULL OR NOT v_visible THEN
    RETURN false;
  END IF;
  IF v_status = 'coo_approved' THEN
    BEGIN
      SELECT e.eligible INTO v_eligible
        FROM public._eligible_agents() e
       WHERE e.agent_id = v_agent
       LIMIT 1;
      IF NOT FOUND THEN
        v_eligible := true;
      END IF;
    EXCEPTION
      WHEN undefined_function THEN
        v_eligible := false;
    END;
    RETURN COALESCE(v_eligible, false);
  END IF;
  RETURN v_status IN ('funded', 'repaying', 'completed');
END;
$function$;

REVOKE ALL ON FUNCTION public.funder_plan_is_verified(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.funder_plan_is_verified(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.funder_verified_plan_payout_contact(p_rent_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ok boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT (
    public.has_role(v_uid, 'supporter'::public.app_role)
    OR public.psm_is_partner(v_uid)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_available');
  END IF;
  v_ok := public.funder_plan_is_verified(p_rent_request_id);
  IF NOT COALESCE(v_ok, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_verified');
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'ok', true,
      'landlord_name', COALESCE(NULLIF(btrim(ll.name), ''), NULLIF(btrim(hll.name), ''), 'Landlord'),
      'landlord_phone', COALESCE(NULLIF(btrim(ll.phone), ''), NULLIF(btrim(hll.phone), '')),
      'payout_momo_number', COALESCE(
        NULLIF(btrim(ll.verified_mobile_money_number), ''),
        NULLIF(btrim(ll.mobile_money_number), ''),
        NULLIF(btrim(hll.verified_mobile_money_number), ''),
        NULLIF(btrim(hll.mobile_money_number), '')
      ),
      'payout_momo_name', COALESCE(NULLIF(btrim(ll.mobile_money_name), ''), NULLIF(btrim(hll.mobile_money_name), '')),
      'location', NULLIF(concat_ws(', ',
        NULLIF(btrim(hl.address), ''),
        NULLIF(btrim(hl.village), ''),
        NULLIF(btrim(hl.district), ''),
        NULLIF(btrim(rr.request_city), '')
      ), '')
    )
    FROM public.rent_requests rr
    LEFT JOIN public.landlords ll ON ll.id = rr.landlord_id
    LEFT JOIN public.house_listings hl ON hl.id = rr.house_listing_id
    LEFT JOIN public.landlords hll ON hll.id = hl.landlord_id
    WHERE rr.id = p_rent_request_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.funder_verified_plan_payout_contact(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.funder_verified_plan_payout_contact(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.funder_record_offplatform_rent_payment(
  p_rent_request_id uuid,
  p_method text,
  p_amount numeric,
  p_provider text DEFAULT NULL,
  p_reference text DEFAULT NULL,
  p_paid_at timestamptz DEFAULT NULL,
  p_receipt_photo_path text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT (
    public.has_role(v_uid, 'supporter'::public.app_role)
    OR public.psm_is_partner(v_uid)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_available');
  END IF;
  IF NOT public.funder_plan_is_verified(p_rent_request_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_verified');
  END IF;
  IF p_method NOT IN ('mobile_money', 'cash') OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid');
  END IF;
  IF p_method = 'mobile_money' AND (p_provider IS NULL OR p_provider NOT IN ('mtn', 'airtel') OR COALESCE(btrim(p_reference), '') = '') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid');
  END IF;
  IF p_receipt_photo_path IS NOT NULL AND p_receipt_photo_path NOT LIKE v_uid::text || '/%' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid');
  END IF;

  INSERT INTO public.funder_offplatform_rent_payments (
    funder_id, rent_request_id, method, amount, provider, reference, paid_at, receipt_photo_path, status
  ) VALUES (
    v_uid, p_rent_request_id, p_method, p_amount,
    CASE WHEN p_method = 'mobile_money' THEN p_provider ELSE NULL END,
    NULLIF(btrim(p_reference), ''),
    COALESCE(p_paid_at, now()),
    p_receipt_photo_path,
    'pending'
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'pending');
END;
$function$;

REVOKE ALL ON FUNCTION public.funder_record_offplatform_rent_payment(uuid, text, numeric, text, text, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.funder_record_offplatform_rent_payment(uuid, text, numeric, text, text, timestamptz, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.funder_record_offplatform_rent_payment(uuid, text, numeric, text, text, timestamptz, text) IS
  'Records a pending mobile-money or cash rent payment. Does not debit a wallet or move money.';
