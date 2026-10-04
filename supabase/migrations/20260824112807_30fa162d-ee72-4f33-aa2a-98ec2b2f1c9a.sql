CREATE SEQUENCE IF NOT EXISTS public.landlord_receipt_number_seq START 100000;

CREATE OR REPLACE FUNCTION public.generate_landlord_receipt_code()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := '';
  i int;
BEGIN
  FOR i IN 1..10 LOOP
    result := result || substr(chars, 1 + (get_byte(gen_random_bytes(1), 0) % length(chars)), 1);
  END LOOP;
  RETURN result;
END;
$$;

CREATE TABLE IF NOT EXISTS public.landlord_payout_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id uuid NOT NULL UNIQUE,
  receipt_code text NOT NULL UNIQUE DEFAULT public.generate_landlord_receipt_code(),
  receipt_number text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed', 'reversed', 'refunded')),
  amount numeric NOT NULL CHECK (amount > 0),
  landlord_id uuid,
  tenant_id uuid,
  agent_id uuid,
  processed_by uuid,
  landlord_phone text,
  snapshot jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by uuid,
  sms_sent_at timestamptz,
  sms_attempts integer NOT NULL DEFAULT 0,
  sms_last_error text,
  sms_last_attempt_at timestamptz,
  short_link_code text,
  reversed_at timestamptz,
  reversal_reason text,
  replaces_receipt_id uuid REFERENCES public.landlord_payout_receipts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_landlord_payout_receipts_landlord
  ON public.landlord_payout_receipts(landlord_id);
CREATE INDEX IF NOT EXISTS idx_landlord_payout_receipts_generated_at
  ON public.landlord_payout_receipts(generated_at DESC);

GRANT SELECT ON public.landlord_payout_receipts TO authenticated;
GRANT ALL ON public.landlord_payout_receipts TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.landlord_receipt_number_seq TO service_role;

ALTER TABLE public.landlord_payout_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Participants and ops read landlord receipts" ON public.landlord_payout_receipts;
CREATE POLICY "Participants and ops read landlord receipts"
ON public.landlord_payout_receipts
FOR SELECT
TO authenticated
USING (
  landlord_id = (SELECT auth.uid())
  OR tenant_id = (SELECT auth.uid())
  OR agent_id = (SELECT auth.uid())
  OR processed_by = (SELECT auth.uid())
  OR (SELECT public.is_ops_role((SELECT auth.uid())))
  OR (SELECT public.has_role((SELECT auth.uid()), 'cfo'::app_role))
  OR (SELECT public.has_role((SELECT auth.uid()), 'manager'::app_role))
);

CREATE OR REPLACE FUNCTION public.guard_landlord_receipt_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.payout_id <> OLD.payout_id
     OR NEW.receipt_code <> OLD.receipt_code
     OR NEW.receipt_number <> OLD.receipt_number
     OR NEW.amount <> OLD.amount
     OR NEW.snapshot::text <> OLD.snapshot::text
     OR NEW.generated_at <> OLD.generated_at
     OR COALESCE(NEW.landlord_id::text, '') <> COALESCE(OLD.landlord_id::text, '')
     OR COALESCE(NEW.tenant_id::text, '') <> COALESCE(OLD.tenant_id::text, '')
  THEN
    RAISE EXCEPTION 'Landlord receipt % is immutable; issue a reversal or replacement receipt instead', OLD.receipt_number;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_landlord_receipt_immutable ON public.landlord_payout_receipts;
CREATE TRIGGER trg_guard_landlord_receipt_immutable
BEFORE UPDATE ON public.landlord_payout_receipts
FOR EACH ROW EXECUTE FUNCTION public.guard_landlord_receipt_immutable();

CREATE OR REPLACE FUNCTION public.issue_landlord_payout_receipt(
  p_payout_id uuid,
  p_processed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payout public.landlord_payouts;
  v_existing public.landlord_payout_receipts;
  v_receipt public.landlord_payout_receipts;
  v_processor uuid;
  v_processor_name text;
  v_processor_role text;
  v_landlord_name text;
  v_tenant_name text;
  v_agent_name text;
  v_house public.house_listings;
  v_paid_at timestamptz;
  v_reference text;
  v_method text;
  v_snapshot jsonb;
  v_number text;
BEGIN
  SELECT * INTO v_payout FROM public.landlord_payouts WHERE id = p_payout_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payout_not_found');
  END IF;

  SELECT * INTO v_existing FROM public.landlord_payout_receipts WHERE payout_id = p_payout_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'created', false,
      'receipt_id', v_existing.id,
      'receipt_code', v_existing.receipt_code,
      'receipt_number', v_existing.receipt_number,
      'sms_sent_at', v_existing.sms_sent_at,
      'landlord_phone', v_existing.landlord_phone,
      'snapshot', v_existing.snapshot
    );
  END IF;

  IF v_payout.status NOT IN ('awaiting_agent_receipt', 'completed')
     OR COALESCE(v_payout.disbursed_at, v_payout.finops_disbursed_at) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payout_not_confirmed', 'status', v_payout.status);
  END IF;

  v_paid_at := COALESCE(v_payout.disbursed_at, v_payout.finops_disbursed_at, now());
  v_processor := COALESCE(p_processed_by, v_payout.finops_disbursed_by);

  SELECT full_name INTO v_processor_name FROM public.profiles WHERE id = v_processor;
  IF EXISTS (SELECT 1 FROM public.cashout_agents WHERE agent_id = v_processor) THEN
    v_processor_role := 'Merchant Agent';
  ELSIF v_processor IS NOT NULL AND public.is_ops_role(v_processor) THEN
    v_processor_role := 'Financial Ops';
  ELSE
    v_processor_role := 'Welile Staff';
  END IF;

  SELECT COALESCE(v_payout.landlord_name, p.full_name) INTO v_landlord_name
  FROM public.profiles p WHERE p.id = v_payout.landlord_id;
  v_landlord_name := COALESCE(v_landlord_name, v_payout.landlord_name, 'Landlord');

  SELECT full_name INTO v_tenant_name FROM public.profiles WHERE id = v_payout.tenant_id;
  SELECT full_name INTO v_agent_name FROM public.profiles WHERE id = v_payout.agent_id;

  SELECT * INTO v_house
  FROM public.house_listings
  WHERE tenant_id = v_payout.tenant_id
  ORDER BY updated_at DESC NULLS LAST
  LIMIT 1;

  v_reference := COALESCE(v_payout.finops_momo_reference, v_payout.external_reference, '—');
  v_method := CASE
    WHEN v_payout.mobile_money_provider IS NOT NULL
      THEN 'Mobile Money (' || upper(v_payout.mobile_money_provider) || ')'
    ELSE 'Mobile Money'
  END;

  v_number := 'WLR-' || nextval('public.landlord_receipt_number_seq')::text;

  v_snapshot := jsonb_build_object(
    'receipt_number', v_number,
    'status', 'completed',
    'amount', v_payout.amount,
    'landlord_name', v_landlord_name,
    'tenant_name', COALESCE(v_tenant_name, 'Tenant'),
    'agent_name', v_agent_name,
    'rent_period', to_char(v_paid_at, 'FMMonth YYYY'),
    'house_type', COALESCE(v_house.house_category, 'Rental Unit'),
    'property_address', NULLIF(
      concat_ws(', ',
        NULLIF(v_house.address, ''),
        NULLIF(v_house.village, ''),
        NULLIF(v_house.sub_county, ''),
        NULLIF(v_house.district, '')
      ), ''),
    'paid_at', v_paid_at,
    'processed_by_name', COALESCE(v_processor_name, 'Welile Staff'),
    'processor_role', v_processor_role,
    'payment_method', v_method,
    'transaction_reference', v_reference
  );

  INSERT INTO public.landlord_payout_receipts (
    payout_id, receipt_number, amount, landlord_id, tenant_id, agent_id,
    processed_by, landlord_phone, snapshot, generated_by
  ) VALUES (
    p_payout_id, v_number, v_payout.amount, v_payout.landlord_id, v_payout.tenant_id,
    v_payout.agent_id, v_processor, v_payout.landlord_phone, v_snapshot, v_processor
  )
  ON CONFLICT (payout_id) DO NOTHING
  RETURNING * INTO v_receipt;

  IF v_receipt.id IS NULL THEN
    SELECT * INTO v_receipt FROM public.landlord_payout_receipts WHERE payout_id = p_payout_id;
    RETURN jsonb_build_object(
      'ok', true, 'created', false,
      'receipt_id', v_receipt.id,
      'receipt_code', v_receipt.receipt_code,
      'receipt_number', v_receipt.receipt_number,
      'sms_sent_at', v_receipt.sms_sent_at,
      'landlord_phone', v_receipt.landlord_phone,
      'snapshot', v_receipt.snapshot
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'created', true,
    'receipt_id', v_receipt.id,
    'receipt_code', v_receipt.receipt_code,
    'receipt_number', v_receipt.receipt_number,
    'sms_sent_at', NULL,
    'landlord_phone', v_receipt.landlord_phone,
    'snapshot', v_receipt.snapshot
  );
END;
$$;

REVOKE ALL ON FUNCTION public.issue_landlord_payout_receipt(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.issue_landlord_payout_receipt(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.issue_landlord_payout_receipt(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_landlord_payout_receipt(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v public.landlord_payout_receipts;
BEGIN
  IF p_code IS NULL OR length(p_code) < 8 THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v FROM public.landlord_payout_receipts WHERE receipt_code = p_code;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN v.snapshot
    || jsonb_build_object(
      'receipt_code', v.receipt_code,
      'status', v.status,
      'reversed_at', v.reversed_at,
      'generated_at', v.generated_at,
      'sms_sent_at', v.sms_sent_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_landlord_payout_receipt(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_landlord_payout_receipt(text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_landlord_receipt_sms(
  p_receipt_id uuid,
  p_ok boolean,
  p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.landlord_payout_receipts
  SET sms_sent_at = CASE WHEN p_ok THEN COALESCE(sms_sent_at, now()) ELSE sms_sent_at END,
      sms_attempts = sms_attempts + 1,
      sms_last_attempt_at = now(),
      sms_last_error = CASE WHEN p_ok THEN NULL ELSE p_error END
  WHERE id = p_receipt_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_landlord_receipt_sms(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_landlord_receipt_sms(uuid, boolean, text) TO service_role;