-- Doc 111 locked the landlord payout phone field to "whatever is on file for
-- this landlord" — but `mobile_money_number`/`phone` are ordinary, always-
-- editable columns with NO link to verification at all. set_landlord_verification()
-- never touched them, so a landlord being `verified = true` only ever meant
-- "Ops approved something about this landlord" — never "Ops approved THIS
-- phone number". Anyone with landlords-UPDATE access (e.g. EditLandlordDialog,
-- an ordinary Ops edit) could silently change the number after verification
-- with zero re-approval and zero effect on `verified`.
--
-- Fix: a dedicated `verified_mobile_money_number` snapshot, written ONLY by
-- set_landlord_verification() at the moment a landlord is (re-)verified —
-- sourced from the specific pending landlord_verification_requests row being
-- resolved when one exists (the number Ops was actually looking at), else
-- from whatever is currently on file (ad-hoc verification with no request,
-- e.g. initial onboarding). Cleared to NULL whenever verification is revoked,
-- so payouts block again until re-approval. The payout flow (doc 111/112)
-- reads ONLY this column — never the raw, freely-editable mobile_money_number.

ALTER TABLE public.landlords
  ADD COLUMN IF NOT EXISTS verified_mobile_money_number text,
  ADD COLUMN IF NOT EXISTS verified_mobile_money_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_mobile_money_source text;

COMMENT ON COLUMN public.landlords.verified_mobile_money_number IS
  'The MoMo number Landlord Ops actually approved, frozen at verification time. Set ONLY by set_landlord_verification() (see trg_aa_landlord_verification_gate). This — never mobile_money_number/phone — is what the agent Landlord Payout Float flow prefills and pays to.';

-- Extend the existing verification-columns lock to cover the new snapshot too,
-- so it can only ever be written through set_landlord_verification().
CREATE OR REPLACE FUNCTION public.landlord_verification_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.verification_status := COALESCE(NULLIF(btrim(NEW.verification_status), ''), 'pending');
    IF NEW.verified IS TRUE AND NEW.verification_status = 'pending' THEN
      NEW.verification_status := 'verified';
    END IF;
    NEW.verified := (NEW.verification_status = 'verified');
    NEW.verification_source := COALESCE(NEW.verification_source, 'registration');
    NEW.verification_updated_at := COALESCE(NEW.verification_updated_at, now());
    RETURN NEW;
  END IF;

  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status
     OR NEW.verified IS DISTINCT FROM OLD.verified
     OR NEW.verification_reason IS DISTINCT FROM OLD.verification_reason
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
     OR NEW.verification_source IS DISTINCT FROM OLD.verification_source
     OR NEW.verified_mobile_money_number IS DISTINCT FROM OLD.verified_mobile_money_number
     OR NEW.verified_mobile_money_set_at IS DISTINCT FROM OLD.verified_mobile_money_set_at
     OR NEW.verified_mobile_money_source IS DISTINCT FROM OLD.verified_mobile_money_source THEN

    IF COALESCE(current_setting('landlord_verification.sync_authorized', true), '') <> 'true' THEN
      RAISE EXCEPTION 'Landlord verification is locked. Use set_landlord_verification() (landlord %)', OLD.id
        USING ERRCODE = '42501';
    END IF;

    NEW.verification_status := COALESCE(NULLIF(btrim(NEW.verification_status), ''), 'pending');
    NEW.verified := (NEW.verification_status = 'verified');
    NEW.verification_updated_at := now();
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_landlord_verification(
  p_landlord_id uuid,
  p_status text,
  p_reason text,
  p_source text DEFAULT 'ops_manual'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  -- The phone on the SPECIFIC pending request being resolved by this call —
  -- the number Ops was actually looking at when they clicked approve.
  v_request_phone text;
BEGIN
  IF NOT is_ops_role(v_actor) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF p_status NOT IN ('pending','verified','rejected','resubmitted') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 THEN RAISE EXCEPTION 'A reason of at least 10 characters is required'; END IF;

  IF p_status = 'verified' THEN
    SELECT lvr.landlord_phone INTO v_request_phone
    FROM public.landlord_verification_requests lvr
    WHERE lvr.landlord_id = p_landlord_id AND lvr.status = 'pending'
    ORDER BY lvr.created_at DESC
    LIMIT 1;
  END IF;

  PERFORM set_config('landlord_verification.sync_authorized', 'true', true);
  UPDATE public.landlords
  SET verification_status = p_status,
      verification_reason = v_reason,
      verification_source = COALESCE(NULLIF(btrim(p_source), ''), 'ops_manual'),
      verified = (p_status = 'verified'),
      verified_at = CASE WHEN p_status = 'verified' THEN now() ELSE verified_at END,
      verified_by = CASE WHEN p_status = 'verified' THEN v_actor ELSE verified_by END,
      -- Snapshot the approved number ONLY on a transition to verified; any
      -- other status (rejected/pending/resubmitted) clears it, so a payout
      -- can never run against a landlord whose approval was revoked.
      verified_mobile_money_number = CASE
        WHEN p_status = 'verified'
          THEN COALESCE(NULLIF(btrim(v_request_phone), ''), mobile_money_number, phone)
        ELSE NULL
      END,
      verified_mobile_money_set_at = CASE WHEN p_status = 'verified' THEN now() ELSE NULL END,
      verified_mobile_money_source = CASE
        WHEN p_status = 'verified'
          THEN CASE WHEN v_request_phone IS NOT NULL THEN 'verification_request' ELSE 'ops_ad_hoc' END
        ELSE NULL
      END
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
      'agreement_required', false));

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
$function$;

-- Backfill: every landlord already sitting at verified=true today has no
-- historical record of what Ops actually looked at in the vast majority of
-- cases (only 721 of ~5,068 have a resolved 'verified' request row with a
-- phone attached — the rest were verified through other UI paths with no
-- request trail at all). Best-available baseline: the request phone if one
-- exists, else whatever is currently on file. This is a one-time grandfather
-- of existing state, not a retroactive claim that Ops reviewed every number —
-- going forward, only set_landlord_verification() can ever set this column.
UPDATE public.landlords l
SET verified_mobile_money_number = COALESCE(
      (SELECT lvr.landlord_phone
       FROM public.landlord_verification_requests lvr
       WHERE lvr.landlord_id = l.id AND lvr.status = 'verified' AND lvr.landlord_phone IS NOT NULL
       ORDER BY lvr.resolved_at DESC NULLS LAST
       LIMIT 1),
      NULLIF(btrim(l.mobile_money_number), ''),
      NULLIF(btrim(l.phone), '')
    ),
    verified_mobile_money_set_at = COALESCE(l.verified_at, now()),
    verified_mobile_money_source = 'migration_backfill_20260922'
WHERE (l.verification_status = 'verified' OR l.verified = true)
  AND l.verified_mobile_money_number IS NULL;

-- ── The DB-level eligibility gates were still checking the raw, freely-
-- editable `landlords.phone` column, not the new approved snapshot. Both are
-- defense-in-depth independent of the edge functions above; the trigger is
-- the actual last line of defense on every `landlord_payouts` INSERT.

CREATE OR REPLACE FUNCTION public.check_landlord_payout_eligibility(p_agent_id uuid, p_landlord_id uuid, p_amount numeric)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_landlord_verified boolean;
  v_landlord_phone text;
  v_float_balance numeric;
  v_kampala_hour int;
  v_cutoff_ok boolean;
  v_float_ok boolean;
  v_landlord_ok boolean;
BEGIN
  v_kampala_hour := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Africa/Kampala'));
  v_cutoff_ok := v_kampala_hour >= 6 AND v_kampala_hour < 22;

  -- verified_mobile_money_number (never raw phone/mobile_money_number) is the
  -- only number Landlord Ops actually approved.
  SELECT verified, verified_mobile_money_number INTO v_landlord_verified, v_landlord_phone
  FROM public.landlords WHERE id = p_landlord_id;

  v_landlord_ok := COALESCE(v_landlord_verified, false)
                   AND v_landlord_phone IS NOT NULL
                   AND length(trim(v_landlord_phone)) >= 8;

  SELECT balance INTO v_float_balance
  FROM public.agent_landlord_float WHERE agent_id = p_agent_id;
  v_float_ok := COALESCE(v_float_balance, 0) >= p_amount;

  RETURN jsonb_build_object(
    'eligible', v_cutoff_ok AND v_landlord_ok AND v_float_ok,
    'cutoff_ok', v_cutoff_ok,
    'kampala_hour', v_kampala_hour,
    'landlord_verified', v_landlord_ok,
    'landlord_phone_present', v_landlord_phone IS NOT NULL,
    'float_ok', v_float_ok,
    'float_balance', COALESCE(v_float_balance, 0),
    'amount_required', p_amount
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_landlord_payout_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_landlord_verified boolean;
  v_landlord_phone text;
  v_float_balance numeric;
  v_kampala_hour int;
BEGIN
  IF public.landlord_float_withdrawals_paused() THEN
    RAISE EXCEPTION 'Landlord float withdrawals are currently paused from Platform Controls. Try again once they are re-enabled.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_kampala_hour := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Africa/Kampala'));
  IF v_kampala_hour < 6 OR v_kampala_hour >= 22 THEN
    RAISE EXCEPTION 'Landlord payouts are only allowed between 06:00 and 22:00 Africa/Kampala.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- verified_mobile_money_number (never raw phone/mobile_money_number) is the
  -- only number Landlord Ops actually approved.
  SELECT verified, verified_mobile_money_number INTO v_landlord_verified, v_landlord_phone
  FROM public.landlords WHERE id = NEW.landlord_id;

  IF v_landlord_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'Landlord is not verified — Landlord Ops must verify the phone number first.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_landlord_phone IS NULL OR length(trim(v_landlord_phone)) < 8 THEN
    RAISE EXCEPTION 'Landlord Ops has not approved a payout number for this landlord.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Structural guarantee, independent of any application code: the phone
  -- actually being paid out to must be exactly the number Landlord Ops
  -- approved -- never a different value some caller supplied.
  IF NEW.landlord_phone IS DISTINCT FROM v_landlord_phone THEN
    RAISE EXCEPTION 'Payout phone does not match the number Landlord Ops approved for this landlord.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT balance INTO v_float_balance
  FROM public.agent_landlord_float WHERE agent_id = NEW.agent_id;

  IF v_float_balance IS NULL THEN
    RAISE EXCEPTION 'Agent has no landlord float account.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_float_balance < NEW.amount THEN
    RAISE EXCEPTION 'Insufficient landlord float (balance: %, requested: %).', v_float_balance, NEW.amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;
