-- Welile Cover on direct mobile money and cash rent payments.
--
-- The existing self-support 2% is not a separate wallet debit. approve_pending_portfolio
-- takes rent + fee as partner_funding / supporter_rent_fund (partner capital, which
-- earns Rent profit share). self_support_pay_proxy_fee then pays the proxy agent from
-- the company (agent_commission_earned / agent_commission) and does not debit the
-- partner again. wallet_deduction cannot be used: trg_block_legacy_wallet_deduction
-- rejects it (WALLET_DEDUCTION_RETIRED, 2026-05).
--
-- This fee is different: the rent was paid outside Welile, so only the cover comes
-- from the partner wallet, and it must not be capital. New category welile_cover_fee.
-- The rent itself never touches a wallet. When staff confirm the payment, the
-- cover fee (self_support_proxy_fee, 0 while the policy is off) is taken from
-- the partner's Welile wallet and paid to their proxy agent. A short wallet
-- waits for a top-up. No partial debit. Never charged twice.
-- Private agreement (support team) creates no row and no fee.
-- REQUIRES CEO YES. Do not apply until Benjamin says so.
-- Does not edit 20261113150000 or 20261113160000.

ALTER TABLE public.funder_offplatform_rent_payments
  ADD COLUMN IF NOT EXISTS cover_fee_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cover_fee_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS cover_fee_charged_at timestamptz,
  ADD COLUMN IF NOT EXISTS proxy_agent_id uuid,
  ADD COLUMN IF NOT EXISTS cover_fee_ledger_group_id uuid,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_by uuid,
  ADD COLUMN IF NOT EXISTS confirm_note text,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by uuid,
  ADD COLUMN IF NOT EXISTS reject_note text;

ALTER TABLE public.funder_offplatform_rent_payments
  DROP CONSTRAINT IF EXISTS funder_offplatform_rent_payments_cover_fee_status_check;
ALTER TABLE public.funder_offplatform_rent_payments
  ADD CONSTRAINT funder_offplatform_rent_payments_cover_fee_status_check
  CHECK (cover_fee_status IN ('none', 'awaiting_confirmation', 'awaiting_topup', 'charged', 'waived', 'kept'));

-- Same signature as 20261113160000, now storing the server-computed fee.
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
  v_fee numeric;
  v_fee_status text;
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

  -- Server computes the fee. A client-supplied amount is ignored.
  v_fee := GREATEST(0, COALESCE(public.self_support_proxy_fee(p_amount), 0));
  v_fee_status := CASE WHEN v_fee > 0 THEN 'awaiting_confirmation' ELSE 'none' END;

  INSERT INTO public.funder_offplatform_rent_payments (
    funder_id, rent_request_id, method, amount, provider, reference, paid_at, receipt_photo_path, status,
    cover_fee_amount, cover_fee_status
  ) VALUES (
    v_uid, p_rent_request_id, p_method, p_amount,
    CASE WHEN p_method = 'mobile_money' THEN p_provider ELSE NULL END,
    NULLIF(btrim(p_reference), ''),
    COALESCE(p_paid_at, now()),
    p_receipt_photo_path,
    'pending',
    v_fee,
    v_fee_status
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'pending', 'cover_fee_amount', v_fee, 'cover_fee_status', v_fee_status);
END;
$function$;

REVOKE ALL ON FUNCTION public.funder_record_offplatform_rent_payment(uuid, text, numeric, text, text, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.funder_record_offplatform_rent_payment(uuid, text, numeric, text, text, timestamptz, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._offplatform_cover_staff_ok()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL
    AND public.staff_mfa_ok()
    AND (
      public.is_partner_ops(auth.uid())
      OR public.has_role(auth.uid(), 'cfo'::public.app_role)
      OR public.has_role(auth.uid(), 'ceo'::public.app_role)
      OR public.has_role(auth.uid(), 'coo'::public.app_role)
      OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
    );
$function$;
REVOKE ALL ON FUNCTION public._offplatform_cover_staff_ok() FROM PUBLIC, anon, authenticated;

-- Charge the stored fee once. Called by confirm and by the retry.
CREATE OR REPLACE FUNCTION public._offplatform_cover_charge(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.funder_offplatform_rent_payments%ROWTYPE;
  v_bal numeric;
  v_e uuid;
  v_path text;
  v_note uuid;
  v_asg uuid;
  v_basis text;
  v_idem text;
  v_group uuid;
  v_rate numeric;
  v_label text;
BEGIN
  IF NOT public._offplatform_cover_staff_ok() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  v_idem := 'opcover-' || p_id::text;
  PERFORM pg_advisory_xact_lock(hashtext(v_idem));

  SELECT * INTO v_row FROM public.funder_offplatform_rent_payments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_row.status = 'rejected' OR v_row.cover_fee_status IN ('waived', 'kept') THEN
    RETURN jsonb_build_object('ok', true, 'cover_fee_status', v_row.cover_fee_status, 'status', v_row.status);
  END IF;
  IF v_row.cover_fee_status = 'charged' OR v_row.cover_fee_ledger_group_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'cover_fee_status', 'charged', 'ledger_group_id', v_row.cover_fee_ledger_group_id);
  END IF;
  IF COALESCE(v_row.cover_fee_amount, 0) <= 0 OR v_row.cover_fee_status = 'none' THEN
    UPDATE public.funder_offplatform_rent_payments
       SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, now()), confirmed_by = COALESCE(confirmed_by, auth.uid()),
           cover_fee_status = 'none'
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'cover_fee_status', 'none');
  END IF;

  SELECT r.earner_id, r.earner_path, r.note_id, r.assignment_id, r.basis
    INTO v_e, v_path, v_note, v_asg, v_basis
    FROM public.commission_resolve_earner(v_row.funder_id, now(), true) r
   LIMIT 1;

  -- Same as self_support_pay_proxy_fee: no proxy agent means the fee is kept, not paid out.
  IF v_e IS NULL OR v_e = v_row.funder_id THEN
    UPDATE public.funder_offplatform_rent_payments
       SET status = 'confirmed',
           confirmed_at = COALESCE(confirmed_at, now()),
           confirmed_by = COALESCE(confirmed_by, auth.uid()),
           cover_fee_status = 'kept'
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'cover_fee_status', 'kept', 'reason', 'no_proxy_agent');
  END IF;

  v_bal := COALESCE(public.get_user_available_balance(v_row.funder_id), 0);
  IF v_bal < v_row.cover_fee_amount THEN
    UPDATE public.funder_offplatform_rent_payments
       SET status = 'confirmed',
           confirmed_at = COALESCE(confirmed_at, now()),
           confirmed_by = COALESCE(confirmed_by, auth.uid()),
           cover_fee_status = 'awaiting_topup'
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'cover_fee_status', 'awaiting_topup', 'available', v_bal, 'cover_fee_amount', v_row.cover_fee_amount);
  END IF;

  v_rate := round(v_row.cover_fee_amount / NULLIF(v_row.amount, 0), 4);
  v_label := 'Welile Cover from a direct or cash rent payment ' || p_id::text;

  -- Partner wallet down, proxy agent wallet up. Not a capital fund-in, so the
  -- fund-in commission gate has no row to pay a second time.
  -- Equal legs: the partner's wallet pays the proxy agent. This is not a capital
  -- fund-in, so commission_pay_fund_in has nothing to pay a second time.
  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_row.funder_id, 'amount', v_row.cover_fee_amount, 'direction', 'cash_out',
        'category', 'welile_cover_fee', 'ledger_scope', 'wallet', 'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
        'source_table', 'funder_offplatform_rent_payments', 'source_id', p_id::text,
        'reference_id', v_idem, 'linked_party', v_e::text,
        'description', 'Welile Cover: ' || v_label),
      jsonb_build_object(
        'user_id', v_e, 'amount', v_row.cover_fee_amount, 'direction', 'cash_in',
        'category', CASE WHEN v_path = 'managed_proxy' THEN 'partner_commission' ELSE 'agent_commission' END,
        'ledger_scope', 'wallet', 'recipient_type', 'user',
        'source_table', 'funder_offplatform_rent_payments', 'source_id', p_id::text,
        'reference_id', v_idem, 'linked_party', v_row.funder_id::text,
        'description', v_label)
    ),
    v_idem);

  UPDATE public.funder_offplatform_rent_payments
     SET status = 'confirmed',
         confirmed_at = COALESCE(confirmed_at, now()),
         confirmed_by = COALESCE(confirmed_by, auth.uid()),
         cover_fee_status = 'charged',
         cover_fee_charged_at = now(),
         proxy_agent_id = v_e,
         cover_fee_ledger_group_id = v_group
   WHERE id = p_id;

  IF v_path = 'managed_proxy' THEN
    INSERT INTO public.proxy_commission_queue
      (kind, agent_id, partner_id, assignment_id, base_amount, rate, amount, source_table, source_id,
       idempotency_key, status, auto_approved, decided_at, decision_note, ledger_group_id)
    SELECT 'portfolio_creation', v_e, v_row.funder_id, v_asg, v_row.amount, COALESCE(NULLIF(v_rate, 0), 0.02), v_row.cover_fee_amount,
           'funder_offplatform_rent_payments', p_id::text, v_idem, 'paid', true, now(), 'offplatform_cover', v_group
     WHERE NOT EXISTS (SELECT 1 FROM public.proxy_commission_queue q WHERE q.idempotency_key = v_idem);
  ELSE
    INSERT INTO public.promissory_commission_events
      (note_id, agent_id, partner_id, kind, base_amount, rate, amount, source_table, source_id,
       idempotency_key, ledger_group_id, status)
    SELECT v_note, v_e, v_row.funder_id, 'portfolio_creation', v_row.amount, COALESCE(NULLIF(v_rate, 0), 0.02), v_row.cover_fee_amount,
           'funder_offplatform_rent_payments', p_id::text, v_idem, v_group, 'paid'
     WHERE NOT EXISTS (SELECT 1 FROM public.promissory_commission_events e WHERE e.idempotency_key = v_idem);
  END IF;

  RETURN jsonb_build_object('ok', true, 'cover_fee_status', 'charged', 'proxy_agent_id', v_e,
                            'ledger_group_id', v_group, 'earner_path', v_path, 'basis', v_basis);
END;
$function$;
REVOKE ALL ON FUNCTION public._offplatform_cover_charge(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.staff_confirm_offplatform_rent_payment(p_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT public._offplatform_cover_staff_ok() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  UPDATE public.funder_offplatform_rent_payments
     SET confirm_note = COALESCE(NULLIF(btrim(p_note), ''), confirm_note)
   WHERE id = p_id AND status <> 'rejected';
  v_result := public._offplatform_cover_charge(p_id);
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.staff_confirm_offplatform_rent_payment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_confirm_offplatform_rent_payment(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.staff_retry_offplatform_cover_fee(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._offplatform_cover_staff_ok() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN public._offplatform_cover_charge(p_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.staff_retry_offplatform_cover_fee(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_retry_offplatform_cover_fee(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.staff_reject_offplatform_rent_payment(p_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
  v_fee_status text;
BEGIN
  IF NOT public._offplatform_cover_staff_ok() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT status, cover_fee_status INTO v_status, v_fee_status
    FROM public.funder_offplatform_rent_payments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_fee_status = 'charged' OR v_status = 'rejected' THEN
    RETURN jsonb_build_object('ok', false, 'code', CASE WHEN v_status = 'rejected' THEN 'already_rejected' ELSE 'already_charged' END);
  END IF;
  UPDATE public.funder_offplatform_rent_payments
     SET status = 'rejected',
         rejected_at = now(),
         rejected_by = auth.uid(),
         reject_note = NULLIF(btrim(p_note), ''),
         cover_fee_status = CASE WHEN cover_fee_status IN ('awaiting_confirmation', 'awaiting_topup') THEN 'waived' ELSE cover_fee_status END
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'status', 'rejected');
END;
$function$;
REVOKE ALL ON FUNCTION public.staff_reject_offplatform_rent_payment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_reject_offplatform_rent_payment(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.staff_list_offplatform_rent_payments(p_status text DEFAULT 'pending', p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._offplatform_cover_staff_ok() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(x) ORDER BY x.created_at DESC)
      FROM (
        SELECT p.id, p.funder_id, pf.full_name AS funder_name, p.rent_request_id, p.method, p.amount,
               p.provider, p.reference, p.paid_at, p.status, p.cover_fee_amount, p.cover_fee_status,
               p.cover_fee_charged_at, p.proxy_agent_id, p.created_at
          FROM public.funder_offplatform_rent_payments p
          LEFT JOIN public.profiles pf ON pf.id = p.funder_id
         WHERE p_status IS NULL OR p_status = 'all' OR p.status = p_status OR p.cover_fee_status = p_status
         ORDER BY p.created_at DESC
         LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
      ) x
  ), '[]'::jsonb);
END;
$function$;
REVOKE ALL ON FUNCTION public.staff_list_offplatform_rent_payments(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_list_offplatform_rent_payments(text, integer) TO authenticated, service_role;

-- welile_cover_fee: wallet custody only. cash_out debits L1 (the partner's withdrawable
-- balance falls). It is not partner_funding, so it is not capital and does not earn
-- Rent profit share. wallet_route_for_category is not replaced: this category is not
-- on the float or advance lists, so a cash_out falls through to withdrawable.
INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
SELECT 'wallet', 'welile_cover_fee', 'withdrawable', 'L1', 'cash_out',
       'Welile Cover taken from a partner withdrawable wallet when a direct or cash rent payment is confirmed. Not partner capital.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.ledger_account_map m
   WHERE m.ledger_scope = 'wallet' AND m.category = 'welile_cover_fee'
     AND m.wallet_bucket IS NOT DISTINCT FROM 'withdrawable'
);

-- Append to the live allowlist. Replacing the whole function would drop categories
-- added after the last copy in this repo.
DO $allow$
DECLARE
  v_src text;
  v_expr text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure;
  IF v_src ILIKE '%welile_cover_fee%' THEN
    RETURN;
  END IF;
  v_expr := regexp_replace(regexp_replace(v_src, '^\s*select\s+', '', 'i'), ';\s*$', '');
  EXECUTE format($f$CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
    RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'extensions', 'pg_temp' AS $body$
  SELECT (%s) || ARRAY['welile_cover_fee']::text[];
$body$ $f$, v_expr);
END
$allow$;

COMMENT ON FUNCTION public.staff_confirm_offplatform_rent_payment(uuid, text) IS
  'Confirms a direct or cash rent payment. Charges Welile Cover (welile_cover_fee, withdrawable L1, not partner capital) from the partner wallet to the proxy agent once. Short balance waits for a top-up. No wallet movement when the fee is zero, waived, or kept.';
