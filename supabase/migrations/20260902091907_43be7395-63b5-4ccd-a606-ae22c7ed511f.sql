-- Canonical, versioned landlord agreement register. Existing landlord rows are not backfilled.
CREATE TABLE IF NOT EXISTS public.landlord_agreement_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_code text NOT NULL UNIQUE,
  title text NOT NULL DEFAULT '12-Month Landlord Rent Agreement',
  body_text text NOT NULL,
  term_months integer NOT NULL DEFAULT 12,
  effective_from date NOT NULL DEFAULT current_date,
  retired_at date,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.landlord_agreement_versions TO authenticated;
GRANT ALL ON public.landlord_agreement_versions TO service_role;
ALTER TABLE public.landlord_agreement_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view landlord agreement versions" ON public.landlord_agreement_versions;
CREATE POLICY "Authenticated users can view landlord agreement versions"
  ON public.landlord_agreement_versions FOR SELECT TO authenticated
  USING (true);

CREATE TABLE IF NOT EXISTS public.landlord_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id uuid NOT NULL REFERENCES public.landlords(id) ON DELETE RESTRICT,
  version_id uuid NOT NULL REFERENCES public.landlord_agreement_versions(id) ON DELETE RESTRICT,
  agreement_no text NOT NULL,
  sequence_no integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('original','addendum','renewal','termination')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','terminated','expired')),
  is_current boolean NOT NULL DEFAULT true,
  supersedes_id uuid REFERENCES public.landlord_agreements(id) ON DELETE RESTRICT,

  -- Frozen commercial, identity, property, and payment terms from the signed document.
  agreement_date date NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  landlord_name text NOT NULL,
  landlord_phone text NOT NULL,
  nin text NOT NULL,
  property_address text NOT NULL,
  house_number text,
  house_category text,
  number_of_rooms integer,
  monthly_rent numeric NOT NULL,
  payment_day integer NOT NULL CHECK (payment_day BETWEEN 1 AND 31),
  payout_mode text,
  bank_name text,
  account_number text,
  mobile_money_name text,
  mobile_money_number text,
  water_meter_number text,
  water_registered_name text,
  electricity_meter_number text,
  electricity_registered_name text,

  -- The uploaded signed agreement is the evidence for all signature blocks.
  landlord_signature_name text NOT NULL,
  landlord_signature_path text NOT NULL,
  landlord_signed_on date NOT NULL,
  welile_signature_name text NOT NULL,
  welile_signature_path text NOT NULL,
  welile_signed_on date NOT NULL,
  witness_name text NOT NULL,
  witness_signature_path text NOT NULL,
  witness_signed_on date NOT NULL,

  bucket text NOT NULL DEFAULT 'landlord-agreements',
  signed_file_path text NOT NULL,
  signed_file_name text,
  signed_file_sha256 text,
  signed_file_mime_type text,
  uploaded_by uuid NOT NULL,
  verified_by uuid,
  verified_at timestamptz,
  termination_notice_date date,
  termination_effective_date date,
  termination_party text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT landlord_agreements_sequence_unique UNIQUE (landlord_id, sequence_no),
  CONSTRAINT landlord_agreements_current_dates CHECK (end_date >= start_date),
  CONSTRAINT landlord_agreements_file_bucket CHECK (bucket = 'landlord-agreements'),
  CONSTRAINT landlord_agreements_file_path CHECK (signed_file_path !~ '(^|/)\.\.?(/|$)')
);

GRANT SELECT, INSERT ON public.landlord_agreements TO authenticated;
GRANT ALL ON public.landlord_agreements TO service_role;
ALTER TABLE public.landlord_agreements ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_landlord_agreements_landlord_current
  ON public.landlord_agreements (landlord_id, is_current, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_landlord_agreements_status
  ON public.landlord_agreements (status, end_date);
CREATE UNIQUE INDEX IF NOT EXISTS landlord_agreements_one_current
  ON public.landlord_agreements (landlord_id) WHERE is_current;

CREATE OR REPLACE FUNCTION public.landlord_agreement_actor_can_view(p_landlord_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_ops_role(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.landlords l
      WHERE l.id = p_landlord_id
        AND l.registered_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.borrower_landlord_id = p_landlord_id
        AND p.id = auth.uid()
    );
$$;

GRANT EXECUTE ON FUNCTION public.landlord_agreement_actor_can_view(uuid) TO authenticated;

DROP POLICY IF EXISTS "Authorized users can view landlord agreements" ON public.landlord_agreements;
CREATE POLICY "Authorized users can view landlord agreements"
  ON public.landlord_agreements FOR SELECT TO authenticated
  USING (public.landlord_agreement_actor_can_view(landlord_id));

DROP POLICY IF EXISTS "Authorized users can submit landlord agreements" ON public.landlord_agreements;
CREATE POLICY "Authorized users can submit landlord agreements"
  ON public.landlord_agreements FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    AND public.landlord_agreement_actor_can_view(landlord_id)
  );

CREATE OR REPLACE FUNCTION public.landlord_agreements_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_landlord_agreements_updated_at ON public.landlord_agreements;
CREATE TRIGGER trg_landlord_agreements_updated_at
  BEFORE UPDATE ON public.landlord_agreements
  FOR EACH ROW EXECUTE FUNCTION public.landlord_agreements_touch_updated_at();

-- Signed evidence and frozen commercial terms cannot be changed in place.
-- Lifecycle fields may change only through a trusted server-side path.
CREATE OR REPLACE FUNCTION public.guard_landlord_agreement_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.landlord_id IS DISTINCT FROM OLD.landlord_id
     OR NEW.version_id IS DISTINCT FROM OLD.version_id
     OR NEW.agreement_no IS DISTINCT FROM OLD.agreement_no
     OR NEW.sequence_no IS DISTINCT FROM OLD.sequence_no
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.agreement_date IS DISTINCT FROM OLD.agreement_date
     OR NEW.start_date IS DISTINCT FROM OLD.start_date
     OR NEW.end_date IS DISTINCT FROM OLD.end_date
     OR NEW.landlord_name IS DISTINCT FROM OLD.landlord_name
     OR NEW.landlord_phone IS DISTINCT FROM OLD.landlord_phone
     OR NEW.nin IS DISTINCT FROM OLD.nin
     OR NEW.property_address IS DISTINCT FROM OLD.property_address
     OR NEW.house_number IS DISTINCT FROM OLD.house_number
     OR NEW.house_category IS DISTINCT FROM OLD.house_category
     OR NEW.number_of_rooms IS DISTINCT FROM OLD.number_of_rooms
     OR NEW.monthly_rent IS DISTINCT FROM OLD.monthly_rent
     OR NEW.payment_day IS DISTINCT FROM OLD.payment_day
     OR NEW.payout_mode IS DISTINCT FROM OLD.payout_mode
     OR NEW.bank_name IS DISTINCT FROM OLD.bank_name
     OR NEW.account_number IS DISTINCT FROM OLD.account_number
     OR NEW.mobile_money_name IS DISTINCT FROM OLD.mobile_money_name
     OR NEW.mobile_money_number IS DISTINCT FROM OLD.mobile_money_number
     OR NEW.water_meter_number IS DISTINCT FROM OLD.water_meter_number
     OR NEW.water_registered_name IS DISTINCT FROM OLD.water_registered_name
     OR NEW.electricity_meter_number IS DISTINCT FROM OLD.electricity_meter_number
     OR NEW.electricity_registered_name IS DISTINCT FROM OLD.electricity_registered_name
     OR NEW.landlord_signature_name IS DISTINCT FROM OLD.landlord_signature_name
     OR NEW.landlord_signature_path IS DISTINCT FROM OLD.landlord_signature_path
     OR NEW.landlord_signed_on IS DISTINCT FROM OLD.landlord_signed_on
     OR NEW.welile_signature_name IS DISTINCT FROM OLD.welile_signature_name
     OR NEW.welile_signature_path IS DISTINCT FROM OLD.welile_signature_path
     OR NEW.welile_signed_on IS DISTINCT FROM OLD.welile_signed_on
     OR NEW.witness_name IS DISTINCT FROM OLD.witness_name
     OR NEW.witness_signature_path IS DISTINCT FROM OLD.witness_signature_path
     OR NEW.witness_signed_on IS DISTINCT FROM OLD.witness_signed_on
     OR NEW.bucket IS DISTINCT FROM OLD.bucket
     OR NEW.signed_file_path IS DISTINCT FROM OLD.signed_file_path
     OR NEW.signed_file_name IS DISTINCT FROM OLD.signed_file_name
     OR NEW.signed_file_sha256 IS DISTINCT FROM OLD.signed_file_sha256
     OR NEW.signed_file_mime_type IS DISTINCT FROM OLD.signed_file_mime_type
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
     OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN
    RAISE EXCEPTION 'Signed landlord agreement versions are immutable; submit a new addendum or renewal'
      USING ERRCODE = '22000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_landlord_agreement_immutability ON public.landlord_agreements;
CREATE TRIGGER trg_guard_landlord_agreement_immutability
  BEFORE UPDATE ON public.landlord_agreements
  FOR EACH ROW EXECUTE FUNCTION public.guard_landlord_agreement_immutability();

-- New current agreements supersede the prior current version without altering its evidence.
CREATE OR REPLACE FUNCTION public.landlord_agreement_set_current()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_current THEN
    UPDATE public.landlord_agreements
    SET is_current = false, status = 'superseded'
    WHERE landlord_id = NEW.landlord_id
      AND id <> NEW.id
      AND is_current = true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_landlord_agreement_set_current ON public.landlord_agreements;
CREATE TRIGGER trg_landlord_agreement_set_current
  AFTER INSERT ON public.landlord_agreements
  FOR EACH ROW EXECUTE FUNCTION public.landlord_agreement_set_current();

CREATE OR REPLACE FUNCTION public.landlord_has_current_agreement(p_landlord_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.landlord_agreements a
    WHERE a.landlord_id = p_landlord_id
      AND a.is_current = true
      AND a.status = 'active'
      AND a.end_date >= current_date
      AND a.signed_file_path <> ''
      AND a.landlord_signature_name <> ''
      AND a.landlord_signature_path <> ''
      AND a.welile_signature_name <> ''
      AND a.welile_signature_path <> ''
      AND a.witness_name <> ''
      AND a.witness_signature_path <> ''
  );
$$;

GRANT EXECUTE ON FUNCTION public.landlord_has_current_agreement(uuid) TO authenticated;

-- One canonical write path for originals, addendums, renewals, and termination documents.
CREATE OR REPLACE FUNCTION public.submit_landlord_agreement(
  p_landlord_id uuid,
  p_kind text,
  p_file_path text,
  p_file_name text,
  p_file_sha256 text,
  p_file_mime_type text,
  p_details jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_version_id uuid;
  v_current_id uuid;
  v_sequence integer;
  v_id uuid;
  v_agreement_no text;
  v_start date;
  v_end date;
  v_agreement_date date;
BEGIN
  IF v_actor IS NULL OR NOT public.landlord_agreement_actor_can_view(p_landlord_id) THEN
    RAISE EXCEPTION 'Not authorized to submit this landlord agreement' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('original','addendum','renewal','termination') THEN
    RAISE EXCEPTION 'Invalid landlord agreement type';
  END IF;
  IF p_file_path IS NULL OR p_file_path = '' OR position(p_landlord_id::text || '/' IN p_file_path) <> 1 THEN
    RAISE EXCEPTION 'Agreement file must be stored under the landlord agreement folder';
  END IF;
  IF p_details IS NULL THEN
    RAISE EXCEPTION 'Agreement details are required';
  END IF;

  v_agreement_date := NULLIF(p_details->>'agreement_date', '')::date;
  v_start := NULLIF(p_details->>'start_date', '')::date;
  v_end := NULLIF(p_details->>'end_date', '')::date;
  IF v_agreement_date IS NULL OR v_start IS NULL OR v_end IS NULL OR v_end < v_start THEN
    RAISE EXCEPTION 'Agreement date, start date, and valid end date are required';
  END IF;
  IF NULLIF(btrim(p_details->>'nin'), '') IS NULL
     OR NULLIF(btrim(p_details->>'property_address'), '') IS NULL
     OR NULLIF(btrim(p_details->>'landlord_name'), '') IS NULL
     OR NULLIF(btrim(p_details->>'landlord_phone'), '') IS NULL
     OR NULLIF(btrim(p_details->>'monthly_rent'), '') IS NULL
     OR NULLIF(btrim(p_details->>'payment_day'), '') IS NULL THEN
    RAISE EXCEPTION 'Identity, property, rent, and payment terms are required';
  END IF;
  IF NULLIF(btrim(p_details->>'landlord_signature_name'), '') IS NULL
     OR NULLIF(btrim(p_details->>'welile_signature_name'), '') IS NULL
     OR NULLIF(btrim(p_details->>'witness_name'), '') IS NULL THEN
    RAISE EXCEPTION 'Landlord, Welile, and witness names are required';
  END IF;

  SELECT id INTO v_version_id
  FROM public.landlord_agreement_versions
  WHERE retired_at IS NULL
  ORDER BY effective_from DESC, created_at DESC
  LIMIT 1;
  IF v_version_id IS NULL THEN
    RAISE EXCEPTION 'No active landlord agreement template is configured';
  END IF;

  SELECT id INTO v_current_id
  FROM public.landlord_agreements
  WHERE landlord_id = p_landlord_id AND is_current = true
  LIMIT 1;

  SELECT COALESCE(max(sequence_no), 0) + 1 INTO v_sequence
  FROM public.landlord_agreements
  WHERE landlord_id = p_landlord_id;
  v_agreement_no := 'LL-' || to_char(current_date, 'YYYYMMDD') || '-' || lpad(v_sequence::text, 4, '0');

  INSERT INTO public.landlord_agreements (
    landlord_id, version_id, agreement_no, sequence_no, kind, status, is_current, supersedes_id,
    agreement_date, start_date, end_date, landlord_name, landlord_phone, nin, property_address,
    house_number, house_category, number_of_rooms, monthly_rent, payment_day, payout_mode,
    bank_name, account_number, mobile_money_name, mobile_money_number, water_meter_number,
    water_registered_name, electricity_meter_number, electricity_registered_name,
    landlord_signature_name, landlord_signature_path, landlord_signed_on,
    welile_signature_name, welile_signature_path, welile_signed_on,
    witness_name, witness_signature_path, witness_signed_on,
    signed_file_path, signed_file_name, signed_file_sha256, signed_file_mime_type,
    uploaded_by, termination_notice_date, termination_effective_date, termination_party, metadata
  ) VALUES (
    p_landlord_id, v_version_id, v_agreement_no, v_sequence, p_kind, 'active', p_kind <> 'termination', v_current_id,
    v_agreement_date, v_start, v_end, btrim(p_details->>'landlord_name'), btrim(p_details->>'landlord_phone'),
    btrim(p_details->>'nin'), btrim(p_details->>'property_address'), NULLIF(btrim(p_details->>'house_number'), ''),
    NULLIF(btrim(p_details->>'house_category'), ''), NULLIF(p_details->>'number_of_rooms', '')::integer,
    (p_details->>'monthly_rent')::numeric, (p_details->>'payment_day')::integer, NULLIF(btrim(p_details->>'payout_mode'), ''),
    NULLIF(btrim(p_details->>'bank_name'), ''), NULLIF(btrim(p_details->>'account_number'), ''),
    NULLIF(btrim(p_details->>'mobile_money_name'), ''), NULLIF(btrim(p_details->>'mobile_money_number'), ''),
    NULLIF(btrim(p_details->>'water_meter_number'), ''), NULLIF(btrim(p_details->>'water_registered_name'), ''),
    NULLIF(btrim(p_details->>'electricity_meter_number'), ''), NULLIF(btrim(p_details->>'electricity_registered_name'), ''),
    btrim(p_details->>'landlord_signature_name'), p_file_path, NULLIF(p_details->>'landlord_signed_on', '')::date,
    btrim(p_details->>'welile_signature_name'), p_file_path, NULLIF(p_details->>'welile_signed_on', '')::date,
    btrim(p_details->>'witness_name'), p_file_path, NULLIF(p_details->>'witness_signed_on', '')::date,
    p_file_path, NULLIF(btrim(p_file_name), ''), NULLIF(btrim(p_file_sha256), ''), NULLIF(btrim(p_file_mime_type), ''),
    v_actor, NULLIF(p_details->>'termination_notice_date', '')::date,
    NULLIF(p_details->>'termination_effective_date', '')::date,
    NULLIF(btrim(p_details->>'termination_party'), ''), p_details
  ) RETURNING id INTO v_id;

  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'landlord_agreement_submitted', 'landlord_agreements', v_id,
    jsonb_build_object('reason', 'Submitted signed landlord agreement for immutable record history',
      'landlord_id', p_landlord_id, 'kind', p_kind, 'agreement_no', v_agreement_no,
      'supersedes_id', v_current_id));

  RETURN jsonb_build_object('ok', true, 'agreement_id', v_id, 'agreement_no', v_agreement_no,
    'landlord_id', p_landlord_id, 'kind', p_kind);
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_landlord_agreement(uuid, text, text, text, text, text, jsonb) TO authenticated;

-- Keep automatic pipeline approvals pending until the canonical agreement exists.
CREATE OR REPLACE FUNCTION public.sync_landlord_verified_on_pipeline_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.landlord_ops_reviewed_at IS NOT NULL AND NEW.landlord_id IS NOT NULL
     AND public.landlord_has_current_agreement(NEW.landlord_id) THEN
    PERFORM set_config('landlord_verification.sync_authorized', 'true', true);
    UPDATE public.landlords
       SET verification_status = 'verified',
           verification_source = COALESCE(verification_source, 'pipeline_auto'),
           verification_reason = COALESCE(verification_reason, 'Auto-verified after landlord agreement requirement was satisfied'),
           verified_at = COALESCE(verified_at, NEW.landlord_ops_reviewed_at),
           verified_by = COALESCE(verified_by, NEW.landlord_ops_reviewed_by)
     WHERE id = NEW.landlord_id
       AND COALESCE(verification_status, 'pending') = 'pending';
    PERFORM set_config('landlord_verification.sync_authorized', 'false', true);
  END IF;
  RETURN NEW;
END;
$$;

-- Preserve the existing verification workflow and add only the agreement gate.
CREATE OR REPLACE FUNCTION public.set_landlord_verification(
  p_landlord_id uuid,
  p_status text,
  p_reason text,
  p_source text DEFAULT 'ops_manual'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_name text;
  v_registered_by uuid;
  v_reason text := btrim(p_reason);
  v_title text;
  v_message text;
  v_type text;
  v_charge_amount integer := 2000;
  v_agent_charged boolean := false;
BEGIN
  IF NOT is_ops_role(v_actor) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF p_status NOT IN ('pending','verified','rejected','resubmitted') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 THEN RAISE EXCEPTION 'A reason of at least 10 characters is required'; END IF;
  IF p_status = 'verified' AND NOT public.landlord_has_current_agreement(p_landlord_id) THEN
    RAISE EXCEPTION 'A signed current 12-month Landlord Rent Agreement is required before verification';
  END IF;

  PERFORM set_config('landlord_verification.sync_authorized', 'true', true);
  UPDATE public.landlords
  SET verification_status = p_status,
      verification_reason = v_reason,
      verification_source = COALESCE(NULLIF(btrim(p_source), ''), 'ops_manual'),
      verified = (p_status = 'verified'),
      verified_at = CASE WHEN p_status = 'verified' THEN now() ELSE verified_at END,
      verified_by = CASE WHEN p_status = 'verified' THEN v_actor ELSE verified_by END
  WHERE id = p_landlord_id
  RETURNING name, registered_by INTO v_name, v_registered_by;
  IF NOT FOUND THEN RAISE EXCEPTION 'Landlord not found'; END IF;
  PERFORM set_config('landlord_verification.sync_authorized', 'false', true);

  UPDATE public.landlord_verification_requests
  SET status = CASE WHEN p_status IN ('verified','rejected') THEN p_status ELSE 'pending' END,
      reject_comment = CASE WHEN p_status = 'rejected' THEN v_reason ELSE reject_comment END,
      resolved_by = v_actor,
      resolved_at = now()
  WHERE landlord_id = p_landlord_id AND status = 'pending';

  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'landlord_verification_status_set', 'landlords', p_landlord_id,
    jsonb_build_object('status', p_status, 'reason', v_reason, 'source', p_source,
      'agreement_required', true));

  IF p_status = 'verified' THEN
    v_type := 'success'; v_title := 'Landlord verified';
    v_message := 'Your landlord' || COALESCE(' (' || v_name || ')', '') || ' has been verified.';
  ELSIF p_status = 'rejected' THEN
    v_type := 'error'; v_title := 'Landlord verification rejected';
    v_message := 'Your landlord' || COALESCE(' (' || v_name || ')', '') || ' verification was rejected. Reason: ' || v_reason;
  ELSE
    v_type := 'info'; v_title := 'Landlord verification pending';
    v_message := 'Your landlord' || COALESCE(' (' || v_name || ')', '') || ' verification is under review. ' || v_reason;
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  SELECT p.id, v_title, v_message, v_type,
    jsonb_build_object('kind', 'landlord_verification', 'landlord_id', p_landlord_id, 'status', p_status, 'reason', v_reason)
  FROM public.profiles p
  WHERE p.borrower_landlord_id = p_landlord_id;

  IF p_status = 'rejected' AND v_registered_by IS NOT NULL THEN
    BEGIN
      PERFORM public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object('user_id', v_registered_by, 'amount', v_charge_amount, 'direction', 'cash_out',
            'category', 'listing_rejection_penalty', 'ledger_scope', 'wallet', 'wallet_bucket', 'withdrawable',
            'source_table', 'landlords', 'source_id', p_landlord_id::text,
            'description', 'Landlord rejection charge — ' || COALESCE(v_name, 'landlord'), 'currency', 'UGX'),
          jsonb_build_object('amount', v_charge_amount, 'direction', 'cash_in',
            'category', 'listing_rejection_recovery', 'ledger_scope', 'platform',
            'source_table', 'landlords', 'source_id', p_landlord_id::text,
            'description', 'Recovery: landlord rejection charge — ' || COALESCE(v_name, 'landlord'), 'currency', 'UGX')
        ),
        'landlord_rejection_charge:' || p_landlord_id::text, true);
      v_agent_charged := true;
    EXCEPTION WHEN OTHERS THEN v_agent_charged := false;
    END;
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (v_registered_by, 'Landlord Rejected',
      'The landlord "' || COALESCE(v_name, 'landlord') || '" you registered was rejected. Reason: ' || v_reason,
      'warning', jsonb_build_object('kind', 'landlord_rejection_penalty', 'landlord_id', p_landlord_id,
        'reason', v_reason, 'charge', CASE WHEN v_agent_charged THEN v_charge_amount ELSE 0 END));
  END IF;

  RETURN jsonb_build_object('ok', true, 'landlord_id', p_landlord_id, 'status', p_status,
    'source', COALESCE(NULLIF(btrim(p_source), ''), 'ops_manual'), 'agent_id', v_registered_by,
    'agent_charged', v_agent_charged, 'charge_amount', CASE WHEN v_agent_charged THEN v_charge_amount ELSE 0 END);
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_landlord_verification(uuid, text, text, text) TO authenticated;

-- Seed only the current source template; this does not create any landlord agreement.
INSERT INTO public.landlord_agreement_versions (version_code, title, body_text, term_months, effective_from)
VALUES (
  'LL-12M-V1',
  '12-Month Landlord Rent Agreement',
  'LIST YOUR PROPERTY WITH WELILE — UPFRONT RENT & OCCUPANCY SECURITY\n\nCanonical source: the signed 12-Month Landlord Rent Agreement supplied for this workflow. The signed uploaded file is the controlling evidence for each landlord agreement version.',
  12,
  current_date
)
ON CONFLICT (version_code) DO NOTHING;

-- Private storage access for agreement files. Files are never publicly served and are not overwriteable.
DROP POLICY IF EXISTS "Authorized users can view landlord agreement files" ON storage.objects;
CREATE POLICY "Authorized users can view landlord agreement files"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'landlord-agreements'
    AND public.landlord_agreement_actor_can_view(NULLIF(split_part(name, '/', 1), '')::uuid)
  );

DROP POLICY IF EXISTS "Authorized users can upload landlord agreement files" ON storage.objects;
CREATE POLICY "Authorized users can upload landlord agreement files"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'landlord-agreements'
    AND (
      public.is_ops_role(auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.landlords l
        WHERE l.id = NULLIF(split_part(name, '/', 1), '')::uuid
          AND l.registered_by = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.borrower_landlord_id = NULLIF(split_part(name, '/', 1), '')::uuid
          AND p.id = auth.uid()
      )
    )
  );

-- No update/delete policies: a new signed version is required for every correction or change.