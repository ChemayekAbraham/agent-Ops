-- Special Advances: Pay from Wallet (CFO approval 12 Nov 2026).
-- A Welile-user borrower repays their own disbursed Special Advance from their wallet's available balance, in part or
-- in full. The Merchant Line route (the CFO records a mobile money / bank repayment) is unchanged.
--
-- Accounting (no new cash): the company already holds the borrower's wallet money (L1); paying from it settles the
-- receivable (A24). One ledger group, category 'special_advance_wallet_repayment':
--   wallet   cash_out, withdrawable -> DR L1 (the wallet falls by the amount paid)
--   platform cash_in                -> CR A24 (the receivable falls)
-- Not Money In (_cfo_received_category_for returns null); no A1 leg.
--
-- Changes:
--   1. special_advance_repayments: method 'wallet' allowed; a wallet repayment carries no proof file (the ledger group
--      is the evidence), every other method still requires one.
--   2. ledger_account_map: the two rows above; ledger_category_allowlist(): production's definition + this category.
--   3. _special_advance_apply_repayment: the allocation + settlement steps moved verbatim out of
--      special_advance_record_repayment, which now calls it (same behaviour; shared by both routes).
--   4. special_advance_pay_from_wallet: the borrower's payment (own advance only, balance-checked under the wallet lock,
--      stale-balance check, overpayment refused, idempotent per payer key).
--   5. special_advance_my_advances: the borrower's own advances and wallet balance.
--   6. special_advance_record_correction: a reversed wallet repayment goes back to the borrower's wallet (CR L1 / DR A24);
--      Merchant Line reversals unchanged.
-- Preflight: refuses unless the replaced functions are exactly production's of 12 Nov 2026.
-- Rollback: supabase/rollbacks/20261117140000_special_advance_pay_from_wallet.rollback.sql

DO $pre$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure)) <> '48c0d407fc784bdfebb59f7ed9364e14'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.special_advance_record_repayment(uuid,jsonb)'::regprocedure)) <> '72980eea5163e0b7de8dc4c24a0b91ed'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.special_advance_record_correction(uuid,jsonb)'::regprocedure)) <> 'adc9fea292474059aa12b112c9fe6def' THEN
    RAISE EXCEPTION 'precondition failed: a replaced function is no longer production''s definition of 12 Nov 2026; re-derive this migration';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_account_map WHERE category = 'special_advance_wallet_repayment')
     OR to_regprocedure('public.special_advance_pay_from_wallet(uuid,bigint,bigint,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: Pay from Wallet is already installed';
  END IF;
END $pre$;

-- 1. repayments: 'wallet' allowed; proof required for every method except 'wallet'
ALTER TABLE public.special_advance_repayments DROP CONSTRAINT special_advance_repayments_method_check;
ALTER TABLE public.special_advance_repayments ADD CONSTRAINT special_advance_repayments_method_check
  CHECK (method = ANY (ARRAY['mobile_money'::text, 'bank_transfer'::text, 'wallet'::text]));
ALTER TABLE public.special_advance_repayments ALTER COLUMN proof_path DROP NOT NULL;
ALTER TABLE public.special_advance_repayments DROP CONSTRAINT special_advance_repayments_proof_path_check;
ALTER TABLE public.special_advance_repayments ADD CONSTRAINT special_advance_repayments_proof_path_check
  CHECK ((method = 'wallet'::text AND proof_path IS NULL)
         OR (method <> 'wallet'::text AND proof_path IS NOT NULL AND proof_path ~ '^advances/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$'::text));

-- 2. accounting rule
INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes) VALUES
  ('wallet', 'special_advance_wallet_repayment', 'withdrawable', 'L1', 'cash_out',
   'Special Advance repaid from the borrower''s wallet: cash_out = DR L1 (custody owed to the borrower falls); a reversal posts cash_in = CR L1.'),
  ('platform', 'special_advance_wallet_repayment', NULL, 'A24', 'cash_out',
   'Special Advance repaid from the borrower''s wallet: cash_in = CR A24 (receivable falls); a reversal posts cash_out = DR A24.');

-- production's allowlist of 12 Nov 2026 (md5 48c0d407...), reproduced verbatim; one entry added
CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$

  SELECT (((public.ledger_category_allowlist_base() || ARRAY[

    'staff_loan_charge_collected',

    'agent_advance_receivable_opening',

    'agent_access_fee_receivable_opening',

    'merchandise_recovery_receivable_opening',

    'bike_recovery_receivable_opening',

    'credit_draw_receivable_opening',

    'merchandise_credit_sale_receivable_opening',

    'service_centre_advance_receivable_opening',

    'service_centre_receivable_opening',

    'tenant_service_charge_receivable_opening',

    'business_advance_receivable_opening',

    'rent_plan_receivable_restatement',

    'receivable_restatement_equity',

    'merchandise_recovery_repayment',

    'bike_recovery_repayment',

    'credit_draw_repayment',

    'smartphone_advance_receivable',

    'agent_advance_disbursement',

    'agent_advance_access_fee_charged',

    'agent_advance_registration_fee_charged',

    'agent_advance_fee_revenue',

    'agent_advance_penalty_accrued',

    'agent_advance_penalty_unearned',

    'agent_advance_access_fee_collected',

    'agent_advance_registration_fee_collected',

    'agent_advance_written_off',

    'agent_advance_access_fee_written_off',

    'agent_advance_registration_fee_written_off',

    'agent_advance_reversed',

    'agent_advance_clawback',

    'agent_advance_late_fee_income',

    'agent_advance_access_fee_collected_external',

    'agent_advance_registration_fee_collected_external',

    'agent_advance_penalty_accrued_external',

    -- Landlord Float Pool (20260929160000, 20260929180000, 20260929240000)

    'landlord_pool_reserve_self_support',

    'landlord_pool_reserve_company_managed',

    'landlord_pool_reserve_source',

    'landlord_pool_topup_self_support',

    'landlord_pool_topup_company_managed',

    'landlord_pool_compound_self_support',

    'landlord_pool_compound_company_managed',

    'landlord_pool_deploy_self_support',

    'landlord_pool_deploy_company_managed',

    'landlord_pool_deploy_target',

    'landlord_pool_return_self_support',

    'landlord_pool_return_company_managed',

    'landlord_pool_return_source',

    'landlord_pool_release_self_support',

    'landlord_pool_release_company_managed',

    'landlord_pool_release_target'

  ]::text[]) || ARRAY['special_advance_credit', 'special_advance_receivable', 'special_advance_payout_cash',

                       'special_advance_fee_revenue', 'special_advance_repayment_received', 'special_advance_repayment']::text[]) || ARRAY['special_advance_impairment_charge', 'special_advance_impairment_allowance', 'special_advance_write_off',

                       'special_advance_write_off_loss', 'special_advance_recovery_received', 'special_advance_recovery_income']::text[]

    -- 2026-11-04 (CFO, merchandise phase 3): merchandise sales revenue (R1); offset of the advance shown on an agent's

    -- wallet for a phone bought by the company (L1 memo, not money owed to the agent)

    || ARRAY['merchandise_revenue', 'merchandise_advance_memo_offset', 'merchandise_payment_retained']::text[]

    || ARRAY['agent_advance_memo_offset']::text[]

    -- 2026-11-10 (CFO draft): platform-only reversal of a float restatement loss booked in error (X6)

    || ARRAY['float_restatement_correction']::text[]) || ARRAY['welile_cover_fee']::text[]

    -- 2026-11-11 (CFO): salary advances to employees (A27 Loans and Advances to Employees)

    || ARRAY['salary_advance_disbursed', 'salary_advance_cash_paid', 'salary_advance_recovered', 'salary_advance_recovery_expense']::text[]
    -- 2026-11-12 (CFO): Welile Homes landlord float paid to landlords settles the landlord payout obligation (L4)
    || ARRAY['wh_landlord_float_settled']::text[]
    -- 2026-11-12 (CFO): Special Advance repaid from the borrower's wallet (wallet L1 / platform A24)
    || ARRAY['special_advance_wallet_repayment']::text[];

$function$
;

-- 3. the shared allocation core, and the CFO repayment calling it
CREATE OR REPLACE FUNCTION public._special_advance_apply_repayment(p_advance_id uuid, p_repayment_id uuid, p_amount bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- Allocates one recorded repayment across the instalments and settles the advance when nothing is outstanding.
-- Moved verbatim out of special_advance_record_repayment (production, 12 Nov 2026) so the CFO's Merchant Line
-- recording and the borrower's Pay from Wallet share ONE allocation rule. The caller holds the advance row lock.
DECLARE
  v_left bigint := p_amount;
  i record;
  v_split jsonb;
BEGIN
  FOR i IN
    -- one access fee per instalment (CFO decision 2026-11-03); allocations never record a registration fee
    SELECT x.number,
           x.access_fee + x.registration_fee - COALESCE(s.a, 0) AS access_fee,
           x.principal - COALESCE(s.p, 0) AS principal
      FROM public.special_advance_instalments x
      LEFT JOIN (SELECT al.instalment_number, sum(al.access_fee + al.registration_fee) a, sum(al.principal) p
                   FROM public.special_advance_repayment_allocations al
                   JOIN public.special_advance_repayments r ON r.id = al.repayment_id AND r.reversed_by_correction IS NULL
                  WHERE al.advance_id = p_advance_id GROUP BY al.instalment_number) s
        ON s.instalment_number = x.number
     WHERE x.advance_id = p_advance_id
     ORDER BY x.number
  LOOP
    EXIT WHEN v_left = 0;
    CONTINUE WHEN i.access_fee + i.principal = 0;
    v_split := public._special_advance_allocate(jsonb_build_object('late_fee', 0, 'access_fee', i.access_fee,
                 'registration_fee', 0, 'principal', i.principal), v_left);
    INSERT INTO public.special_advance_repayment_allocations (repayment_id, advance_id, instalment_number, access_fee, registration_fee, principal)
    VALUES (p_repayment_id, p_advance_id, i.number, (v_split ->> 'access_fee')::bigint, 0, (v_split ->> 'principal')::bigint);
    v_left := (v_split ->> 'excess')::bigint;
  END LOOP;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_ALLOCATION_MISMATCH' USING ERRCODE = '23514';
  END IF;

  IF (public._special_advance_position(p_advance_id) ->> 'outstanding')::bigint = 0 THEN
    UPDATE public.special_advances SET status = 'settled', settled_at = clock_timestamp() WHERE id = p_advance_id;
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.special_advance_record_repayment(p_id uuid, p_repayment jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_today date := public._special_advance_kampala_today();
  v_key text := btrim(COALESCE(p_repayment ->> 'idempotency_key', ''));
  v_amount numeric;
  v_date date;
  v_method text := p_repayment ->> 'method';
  v_ref text := NULLIF(btrim(COALESCE(p_repayment ->> 'reference', '')), '');
  v_note text := NULLIF(btrim(COALESCE(p_repayment ->> 'note', '')), '');
  v_proof text := NULLIF(btrim(COALESCE(p_repayment ->> 'proof_path', '')), '');
  a public.special_advances%ROWTYPE;
  e public.special_advance_repayments%ROWTYPE;
  v_errs text[] := '{}';
  v_pos jsonb;
  v_rep uuid := gen_random_uuid();
  v_group uuid;
BEGIN
  PERFORM public._special_advance_require_mfa();
  IF length(v_key) NOT BETWEEN 16 AND 100 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:repayment:' || v_key, 0));
  SELECT * INTO e FROM public.special_advance_repayments WHERE idempotency_key = v_key;
  IF e.id IS NOT NULL THEN
    IF e.advance_id = p_id AND e.recorded_by = v_actor AND COALESCE(p_repayment ->> 'amount', '') ~ '^[0-9]+$'
       AND e.amount = (p_repayment ->> 'amount')::bigint
       AND e.reference = v_ref AND e.method = v_method AND e.proof_path IS NOT DISTINCT FROM v_proof THEN
      RETURN public._special_advance_json(p_id) || jsonb_build_object('position', public._special_advance_position(p_id), 'replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO a FROM public.special_advances WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF a.status <> 'disbursed' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_REPAYABLE' USING ERRCODE = '22023', DETAIL = a.status;
  END IF;

  BEGIN v_amount := (p_repayment ->> 'amount')::numeric; EXCEPTION WHEN others THEN v_amount := NULL; END;
  BEGIN v_date := (p_repayment ->> 'received_date')::date; EXCEPTION WHEN others THEN v_date := NULL; END;
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount <> trunc(v_amount) THEN v_errs := v_errs || 'amount'::text; END IF;
  IF v_date IS NULL OR v_date > v_today OR v_date < a.payout_date THEN v_errs := v_errs || 'received_date'::text; END IF;
  IF v_method IS NULL OR v_method NOT IN ('mobile_money', 'bank_transfer') THEN v_errs := v_errs || 'method'::text; END IF;
  IF v_ref IS NULL OR length(v_ref) NOT BETWEEN 3 AND 100 THEN v_errs := v_errs || 'reference'::text; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN v_errs := v_errs || 'note'::text; END IF;
  IF cardinality(v_errs) > 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = to_jsonb(v_errs)::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.special_advance_repayments r
              WHERE r.method = v_method AND upper(btrim(r.reference)) = upper(v_ref) AND r.reversed_by_correction IS NULL) THEN
    RAISE EXCEPTION 'REPAYMENT_REFERENCE_ALREADY_RECORDED' USING ERRCODE = '23505';
  END IF;
  v_proof := public._special_advance_check_proof(a.id, v_proof);  -- D2: the archived receipt / statement of the repayment

  v_pos := public._special_advance_position(a.id);
  IF v_amount > (v_pos ->> 'outstanding')::bigint THEN
    RAISE EXCEPTION 'OVERPAYMENT_REFUSED' USING ERRCODE = '22023',
      DETAIL = jsonb_build_object('outstanding', (v_pos ->> 'outstanding')::bigint)::text;
  END IF;

  v_group := public.create_ledger_transaction(jsonb_build_array(
    jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', v_amount::bigint,
                       'category', 'special_advance_repayment_received', 'source_table', 'special_advance_repayments', 'source_id', v_rep,
                       'reference_id', a.reference, 'currency', 'UGX', 'transaction_date', (v_date::timestamp AT TIME ZONE 'Africa/Kampala'),
                       'description', format('Special Advance %s repayment by %s, ref %s', a.reference, replace(v_method, '_', ' '), v_ref)),
    jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', v_amount::bigint,
                       'category', 'special_advance_repayment', 'source_table', 'special_advance_repayments', 'source_id', v_rep,
                       'reference_id', a.reference, 'currency', 'UGX', 'transaction_date', (v_date::timestamp AT TIME ZONE 'Africa/Kampala'),
                       'description', format('Special Advance %s receivable reduced', a.reference))),
    'special_advance:repayment:' || v_key, false);

  INSERT INTO public.special_advance_repayments (id, advance_id, amount, received_date, method, reference, note, idempotency_key,
                                                 ledger_group_id, recorded_by, proof_path)
  VALUES (v_rep, a.id, v_amount::bigint, v_date, v_method, v_ref, v_note, v_key, v_group, v_actor, v_proof);

  -- allocation (late fee, access fee, principal; instalment order) and settlement: shared with Pay from Wallet
  PERFORM public._special_advance_apply_repayment(a.id, v_rep, v_amount::bigint);
  RETURN public._special_advance_json(a.id) || jsonb_build_object('position', public._special_advance_position(a.id), 'replayed', false);
END $function$
;

-- 4. the borrower pays from the wallet
CREATE OR REPLACE FUNCTION public._special_advance_wallet_receipt(p_repayment_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- what the borrower sees after paying: the receipt, how it was applied, and the balances now
  SELECT jsonb_build_object(
    'repayment_id', r.id, 'receipt_reference', r.reference, 'advance_id', a.id, 'advance_reference', a.reference,
    'amount', r.amount, 'paid_on', r.received_date, 'recorded_at', r.recorded_at,
    'applied_to_access_fee', COALESCE((SELECT sum(x.access_fee + x.registration_fee) FROM public.special_advance_repayment_allocations x WHERE x.repayment_id = r.id), 0),
    'applied_to_principal', COALESCE((SELECT sum(x.principal) FROM public.special_advance_repayment_allocations x WHERE x.repayment_id = r.id), 0),
    'status', a.status,
    'outstanding', (public._special_advance_position(a.id) ->> 'outstanding')::bigint,
    'wallet_available', public.get_user_available_balance__impl(r.recorded_by))
  FROM public.special_advance_repayments r JOIN public.special_advances a ON a.id = r.advance_id
  WHERE r.id = p_repayment_id;
$function$;

CREATE OR REPLACE FUNCTION public.special_advance_pay_from_wallet(p_id uuid, p_amount bigint, p_expected_outstanding bigint, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- The borrower repays their own Special Advance from their Welile wallet, in ONE transaction:
--   the wallet leg (DR L1) and the receivable leg (CR A24) post as one ledger group, the repayment is recorded and
--   allocated by the same rule as a Merchant Line repayment, and the advance settles when nothing is left.
-- Any error rolls everything back, so a failed payment never leaves the wallet debited.
DECLARE
  v_uid uuid := auth.uid();
  v_today date := public._special_advance_kampala_today();
  v_client_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_key text;
  a public.special_advances%ROWTYPE;
  e public.special_advance_repayments%ROWTYPE;
  v_outstanding bigint;
  v_available numeric;
  v_rep uuid := gen_random_uuid();
  v_ref text;
  v_group uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF length(v_client_key) NOT BETWEEN 16 AND 60 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  -- scoped to the payer, so one person's key can never replay or block another person's payment
  v_key := 'w:' || v_uid::text || ':' || v_client_key;
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:repayment:' || v_key, 0));
  SELECT * INTO e FROM public.special_advance_repayments WHERE idempotency_key = v_key;
  IF e.id IS NOT NULL THEN
    IF e.advance_id = p_id AND e.method = 'wallet' AND e.recorded_by = v_uid AND e.amount = p_amount THEN
      RETURN public._special_advance_wallet_receipt(e.id) || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;

  -- only the borrower's own advance; anything else reads as not found
  SELECT * INTO a FROM public.special_advances
   WHERE id = p_id AND borrower_kind = 'welile_user' AND borrower_user_id = v_uid
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF a.status <> 'disbursed' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_REPAYABLE' USING ERRCODE = '22023', DETAIL = a.status;
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["amount"]';
  END IF;

  v_outstanding := (public._special_advance_position(a.id) ->> 'outstanding')::bigint;
  -- the payer confirmed against this balance; if it moved (another payment, a correction) they must look again
  IF p_expected_outstanding IS DISTINCT FROM v_outstanding THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_STATE_CHANGED' USING ERRCODE = '22023',
      DETAIL = jsonb_build_object('outstanding', v_outstanding)::text;
  END IF;
  IF p_amount > v_outstanding THEN
    RAISE EXCEPTION 'OVERPAYMENT_REFUSED' USING ERRCODE = '22023',
      DETAIL = jsonb_build_object('outstanding', v_outstanding)::text;
  END IF;

  -- Serialise with every other movement on this wallet: each wallet posting rewrites the owner's projection row and
  -- holds it until commit. After this lock the balance below is the committed one, and no other posting can change
  -- it until this payment commits or rolls back.
  PERFORM 1 FROM public.wallet_balances_projection WHERE user_id = v_uid FOR UPDATE;
  v_available := public.get_user_available_balance__impl(v_uid);
  IF COALESCE(v_available, 0) < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_WALLET_BALANCE' USING ERRCODE = '22023',
      DETAIL = jsonb_build_object('available', COALESCE(v_available, 0))::text;
  END IF;

  v_ref := 'WALLET-' || upper(substr(replace(v_rep::text, '-', ''), 1, 12));
  v_group := public.create_ledger_transaction(jsonb_build_array(
    jsonb_build_object('ledger_scope', 'wallet', 'direction', 'cash_out', 'amount', p_amount,
                       'category', 'special_advance_wallet_repayment', 'user_id', v_uid, 'wallet_bucket', 'withdrawable',
                       'recipient_type', 'user', 'source_table', 'special_advance_repayments', 'source_id', v_rep,
                       'reference_id', a.reference, 'currency', 'UGX',
                       'description', format('Special Advance %s repayment from your wallet, ref %s', a.reference, v_ref)),
    jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', p_amount,
                       'category', 'special_advance_wallet_repayment', 'source_table', 'special_advance_repayments', 'source_id', v_rep,
                       'reference_id', a.reference, 'currency', 'UGX',
                       'description', format('Special Advance %s receivable reduced (paid from the borrower''s wallet, ref %s)', a.reference, v_ref))),
    'special_advance:repayment:' || v_key, false);

  INSERT INTO public.special_advance_repayments (id, advance_id, amount, received_date, method, reference, note, idempotency_key,
                                                 ledger_group_id, recorded_by, proof_path)
  VALUES (v_rep, a.id, p_amount, v_today, 'wallet', v_ref, NULL, v_key, v_group, v_uid, NULL);
  PERFORM public._special_advance_apply_repayment(a.id, v_rep, p_amount);

  RETURN public._special_advance_wallet_receipt(v_rep) || jsonb_build_object('replayed', false);
END $function$;

-- 5. the borrower's own advances
CREATE OR REPLACE FUNCTION public.special_advance_my_advances()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- The signed-in borrower's own paid-out Special Advances, with what is owed, the schedule, their repayments and the
-- wallet balance they can pay from. Nothing about anyone else, no proof files, no staff names.
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'wallet_available', public.get_user_available_balance__impl(v_uid),
    'advances', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', a.id, 'reference', a.reference, 'status', a.status, 'principal', a.principal,
        'access_fee', a.access_fee + a.registration_fee, 'total_repayable', a.total_repayable,
        'payout_date', a.payout_date, 'settled_at', a.settled_at,
        'position', public._special_advance_position(a.id),
        'repayments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', r.id, 'amount', r.amount, 'paid_on', r.received_date, 'method', r.method, 'reference', r.reference,
            'reversed', r.reversed_by_correction IS NOT NULL) ORDER BY r.recorded_at DESC)
          FROM public.special_advance_repayments r WHERE r.advance_id = a.id), '[]'::jsonb))
        ORDER BY a.created_at DESC)
      FROM public.special_advances a
      WHERE a.borrower_kind = 'welile_user' AND a.borrower_user_id = v_uid AND a.status IN ('disbursed', 'settled')), '[]'::jsonb));
END $function$;

-- 6. corrections: a wallet repayment is reversed back to the wallet
CREATE OR REPLACE FUNCTION public.special_advance_record_correction(p_id uuid, p_request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_key text := btrim(COALESCE(p_request ->> 'idempotency_key', ''));
  v_kind text := p_request ->> 'kind';
  v_reason text := NULLIF(btrim(COALESCE(p_request ->> 'reason', '')), '');
  v_proof text := NULLIF(btrim(COALESCE(p_request ->> 'proof_path', '')), '');
  v_rep_id uuid;
  a public.special_advances%ROWTYPE;
  r public.special_advance_repayments%ROWTYPE;
  e public.special_advance_corrections%ROWTYPE;
  v_amount bigint;
  v_id uuid := gen_random_uuid();
  v_ref text;
  v_today date := public._special_advance_kampala_today();
  v_src jsonb;
  v_legs jsonb;
  v_desc text;
  v_group uuid;
BEGIN
  PERFORM public._special_advance_require_mfa();
  IF length(v_key) NOT BETWEEN 16 AND 100 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  BEGIN v_rep_id := NULLIF(p_request ->> 'repayment_id', '')::uuid; EXCEPTION WHEN others THEN v_rep_id := NULL; END;
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:correction:' || v_key, 0));
  SELECT * INTO e FROM public.special_advance_corrections WHERE idempotency_key = v_key;
  IF e.id IS NOT NULL THEN
    IF e.advance_id = p_id AND e.recorded_by = v_actor AND e.kind = v_kind AND e.repayment_id IS NOT DISTINCT FROM v_rep_id
       AND e.proof_path = v_proof AND e.reason = v_reason THEN
      RETURN public._special_advance_correction_json(e.id) || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO a FROM public.special_advances WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF a.borrower_user_id = v_actor THEN
    RAISE EXCEPTION 'SELF_ADVANCE' USING ERRCODE = '42501';
  END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('repayment_reversal', 'payout_reversal') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["kind"]';
  END IF;
  IF v_reason IS NULL OR length(v_reason) NOT BETWEEN 20 AND 1000 THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023', DETAIL = 'Explain the error in 20 to 1000 characters';
  END IF;

  IF v_kind = 'repayment_reversal' THEN
    SELECT * INTO r FROM public.special_advance_repayments WHERE id = v_rep_id AND advance_id = a.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'REPAYMENT_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF r.reversed_by_correction IS NOT NULL THEN
      RAISE EXCEPTION 'REPAYMENT_ALREADY_REVERSED' USING ERRCODE = '22023';
    END IF;
    IF a.status NOT IN ('disbursed', 'settled') THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_CORRECTABLE' USING ERRCODE = '22023', DETAIL = a.status;
    END IF;
    IF a.status = 'settled' AND a.borrower_user_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.special_advances o WHERE o.borrower_user_id = a.borrower_user_id AND o.id <> a.id
                    AND o.status IN ('pending_approval', 'approved', 'disbursed')) THEN
      RAISE EXCEPTION 'BORROWER_HAS_OPEN_ADVANCE' USING ERRCODE = '22023',
        DETAIL = 'Reopening this advance would give the borrower two open Special Advances';
    END IF;
    v_amount := r.amount;
  ELSE
    IF a.borrower_kind <> 'external' THEN  -- D11c: a wallet payout is not reversed here
      RAISE EXCEPTION 'PAYOUT_REVERSAL_NOT_SUPPORTED' USING ERRCODE = '22023',
        DETAIL = 'A payout to a Welile wallet cannot be reversed; only an external payout recorded in error';
    END IF;
    IF a.status <> 'disbursed' THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_CORRECTABLE' USING ERRCODE = '22023', DETAIL = a.status;
    END IF;
    IF EXISTS (SELECT 1 FROM public.special_advance_repayments x WHERE x.advance_id = a.id AND x.reversed_by_correction IS NULL) THEN
      RAISE EXCEPTION 'REPAYMENTS_MUST_BE_REVERSED_FIRST' USING ERRCODE = '22023';
    END IF;
    v_amount := a.total_repayable;
  END IF;
  v_proof := public._special_advance_check_proof(a.id, v_proof);  -- D11d

  v_ref := 'SAC-' || lpad(nextval('public.special_advance_correction_seq')::text, 6, '0');
  v_desc := format('Special Advance %s correction %s', a.reference, v_ref);
  v_src := jsonb_build_object('ledger_scope', 'platform', 'source_table', 'special_advance_corrections', 'source_id', v_id,
                              'reference_id', a.reference, 'currency', 'UGX',
                              'transaction_date', (v_today::timestamp AT TIME ZONE 'Africa/Kampala'));
  IF v_kind = 'repayment_reversal' AND r.method = 'wallet' THEN
    -- paid from the borrower's wallet: the money goes back to that wallet (CR L1) and the receivable is restored (DR A24)
    v_legs := jsonb_build_array(
      v_src || jsonb_build_object('direction', 'cash_out', 'amount', r.amount, 'category', 'special_advance_wallet_repayment',
                                  'description', format('%s: wallet repayment ref %s reversed (receivable restored)', v_desc, r.reference)),
      v_src || jsonb_build_object('ledger_scope', 'wallet', 'direction', 'cash_in', 'amount', r.amount, 'category', 'special_advance_wallet_repayment',
                                  'user_id', a.borrower_user_id, 'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
                                  'description', format('%s: wallet repayment ref %s returned to the borrower''s wallet', v_desc, r.reference)));
  ELSIF v_kind = 'repayment_reversal' THEN
    v_legs := jsonb_build_array(
      v_src || jsonb_build_object('direction', 'cash_out', 'amount', r.amount, 'category', 'special_advance_repayment_received',
                                  'description', format('%s: repayment ref %s reversed (company cash)', v_desc, r.reference)),
      v_src || jsonb_build_object('direction', 'cash_in', 'amount', r.amount, 'category', 'special_advance_repayment',
                                  'description', format('%s: repayment ref %s reversed (receivable restored)', v_desc, r.reference)));
  ELSE
    v_legs := jsonb_build_array(
      v_src || jsonb_build_object('direction', 'cash_out', 'amount', a.principal, 'category', 'special_advance_payout_cash',
                                  'description', format('%s: payout ref %s reversed (company cash)', v_desc, a.payout_reference)),
      v_src || jsonb_build_object('direction', 'cash_in', 'amount', a.principal, 'category', 'special_advance_receivable',
                                  'description', v_desc || ': principal receivable reversed'));
    -- one access fee (CFO decision 2026-11-03), as posted at payout
    IF a.access_fee + a.registration_fee > 0 THEN
      v_legs := v_legs
        || (v_src || jsonb_build_object('direction', 'cash_out', 'amount', a.access_fee + a.registration_fee, 'category', 'special_advance_fee_revenue',
                                        'description', v_desc || ': access fee reversed'))
        || (v_src || jsonb_build_object('direction', 'cash_in', 'amount', a.access_fee + a.registration_fee, 'category', 'special_advance_receivable',
                                        'description', v_desc || ': access fee receivable reversed'));
    END IF;
  END IF;

  -- one key per correction: it can post only once
  v_group := public.create_ledger_transaction(v_legs, 'special_advance:correction:' || v_id::text, false);

  INSERT INTO public.special_advance_corrections (id, reference, advance_id, kind, repayment_id, amount, reason, proof_path,
                                                  idempotency_key, ledger_group_id, recorded_by)
  VALUES (v_id, v_ref, a.id, v_kind, CASE WHEN v_kind = 'repayment_reversal' THEN r.id END, v_amount, v_reason, v_proof,
          v_key, v_group, v_actor);
  INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
  VALUES (a.id, 'correction_posted', a.status, a.status, v_actor, v_reason,
          jsonb_build_object('correction_id', v_id, 'kind', v_kind, 'amount', v_amount, 'repayment_id', r.id,
                             'ledger_group_id', v_group));

  PERFORM set_config('special_advance.correction', v_id::text, true);
  IF v_kind = 'repayment_reversal' THEN
    UPDATE public.special_advance_repayments SET reversed_by_correction = v_id WHERE id = r.id;
    IF a.status = 'settled' THEN
      UPDATE public.special_advances SET status = 'disbursed', settled_at = NULL WHERE id = a.id;
    END IF;
  ELSE
    UPDATE public.special_advances SET status = 'reversed' WHERE id = a.id;
  END IF;
  PERFORM set_config('special_advance.correction', '', true);

  RETURN public._special_advance_correction_json(v_id) || jsonb_build_object('replayed', false);
END $function$
;

-- grants: the two borrower functions are callable by signed-in users (each checks the caller itself);
-- the helpers are internal
REVOKE ALL ON FUNCTION public._special_advance_apply_repayment(uuid, uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_wallet_receipt(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.special_advance_pay_from_wallet(uuid, bigint, bigint, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_my_advances() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._special_advance_apply_repayment(uuid, uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public._special_advance_wallet_receipt(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.special_advance_pay_from_wallet(uuid, bigint, bigint, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.special_advance_my_advances() TO authenticated, service_role;
