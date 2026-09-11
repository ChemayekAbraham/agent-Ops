-- Merchant cash-out: stop losing the telecom sending charge, and stop the
-- settlement classifier flagging every payout since 2026-08-31 as unsettled.
--
-- ── 1. The telecom leg was silently dropped on ~75% of merchant payouts ──────
-- approve-withdrawal flips the withdrawal to `completed` (~line 2614) BEFORE it
-- posts the merchant float debit (~line 3176). That status change fires
-- trg_merchant_payout_float_guard -> ensure_merchant_payout_float_debit, which
-- posted a PRINCIPAL-ONLY float debit under the idempotency key
-- `approve-withdrawal-merchant-float-consume-<id>`.
--
-- On 2026-08-30 approve-withdrawal moved the telecom leg into that same key
-- (one atomic principal+telecom transaction). From then on, whenever the guard
-- got there first, approve-withdrawal's combined call hit the existing key,
-- create_ledger_transaction returned the guard's group id with no error, and
-- the telecom pair was never written. Before 2026-08-30 telecom had its own key,
-- so the guard winning the race did not matter.
--
-- Measured live 2026-09-11: every guard-posted float debit since 2026-08-31
-- (~770 payouts) has zero telecom legs; the rows approve-withdrawal wrote itself
-- mostly do. Example: withdrawal 3f27ab5d, float 299,125 -> 99,125 on a 200,000
-- payout carrying a 1,000 fee. The fee was charged to nobody, merchant float
-- reads high by the fee, and withdrawal_settlement_status flags the row forever.
--
-- Fix: the guard now debits principal AND telecom the same way approve-withdrawal
-- does (principal first, then the fee, from one pool of available float), with
-- the two distinct reference_ids the classifier and daily reconciliation read.
-- Whichever writer wins the key, both legs land. Any part float cannot cover is
-- passed to consume_merchant_float as out-of-pocket, exactly as before.
--
-- No backfill here: the ~770 historical payouts are left as they are. Posting
-- their fees now would debit float that later "set to" adjustments may already
-- have trued up against the merchants' MoMo statements (see
-- project_float_set_to_vs_add_overcredit). That is a Finance decision.
CREATE OR REPLACE FUNCTION public.ensure_merchant_payout_float_debit(p_withdrawal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wr record;
  v_agent uuid;
  v_pos jsonb;
  v_available numeric := 0;
  v_telecom numeric := 0;
  v_debit numeric := 0;
  v_principal numeric := 0;
  v_telecom_debit numeric := 0;
  v_entries jsonb;
  v_now timestamptz := now();
BEGIN
  SELECT w.id, w.amount, w.status, w.reason, w.assigned_cashout_agent_id, w.user_id
    INTO v_wr
  FROM public.withdrawal_requests w
  WHERE w.id = p_withdrawal_id;

  IF v_wr.id IS NULL OR v_wr.status <> 'completed' OR COALESCE(v_wr.amount, 0) <= 0 THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'not_a_completed_payout');
  END IF;

  IF v_wr.assigned_cashout_agent_id IS NULL THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'no_merchant_desk');
  END IF;

  -- Landlord float payouts already deducted their money in agent_landlord_float.
  IF COALESCE(v_wr.reason, '') ILIKE 'Landlord float payout%' THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'landlord_float_payout');
  END IF;

  SELECT ca.agent_id INTO v_agent
  FROM public.cashout_agents ca
  WHERE ca.id = v_wr.assigned_cashout_agent_id;

  IF v_agent IS NULL THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'desk_has_no_agent');
  END IF;

  -- Already has ANY float debit leg for this payout (consume, telecom, pool proxy)? nothing to do.
  IF EXISTS (
    SELECT 1 FROM public.general_ledger g
    WHERE g.source_table = 'withdrawal_requests'
      AND g.source_id = v_wr.id
      AND g.ledger_scope = 'wallet'
      AND g.wallet_bucket = 'float'
      AND g.direction = 'cash_out'
      AND g.user_id = v_agent
  ) THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'float_debit_already_posted');
  END IF;

  v_pos := public.get_merchant_float_position(v_agent);
  v_available := GREATEST(COALESCE((v_pos->>'available_float')::numeric, 0), 0);
  v_telecom := public.merchant_telecom_sending_charge(v_wr.amount);

  -- Principal first, then the telecom fee, from one pool -- the same allocation
  -- approve-withdrawal uses (merchantFloatForPrincipal / merchantFloatForTelecom).
  v_debit := round(LEAST(v_available, COALESCE(v_wr.amount, 0) + v_telecom));
  v_principal := LEAST(v_debit, round(COALESCE(v_wr.amount, 0)));
  v_telecom_debit := GREATEST(v_debit - v_principal, 0);

  IF v_debit <= 0 THEN
    -- Agent held no company float: the payout genuinely came off their own line.
    BEGIN
      PERFORM public.classify_merchant_payout_funding(v_wr.id, 'float_debit_guard');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN jsonb_build_object('action', 'no_float_available', 'agent_id', v_agent);
  END IF;

  v_entries := jsonb_build_array(
    jsonb_build_object(
      'user_id', v_agent, 'ledger_scope', 'wallet', 'direction', 'cash_out',
      'amount', v_principal, 'category', 'agent_float_settlement',
      'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
      'source_table', 'withdrawal_requests', 'source_id', v_wr.id,
      'description', format('Company float used to settle customer cash-out %s (guard)', v_wr.id),
      'currency', 'UGX',
      'reference_id', v_wr.id::text || '-merchant-float-consume',
      'transaction_date', v_now
    ),
    jsonb_build_object(
      'user_id', v_agent, 'ledger_scope', 'platform', 'direction', 'cash_in',
      'amount', v_principal, 'category', 'agent_float_settlement',
      'source_table', 'withdrawal_requests', 'source_id', v_wr.id,
      'description', format('Merchant float settled to customer for withdrawal %s (guard)', v_wr.id),
      'currency', 'UGX',
      'reference_id', v_wr.id::text || '-merchant-float-consume',
      'transaction_date', v_now
    )
  );

  IF v_telecom_debit > 0 THEN
    v_entries := v_entries || jsonb_build_array(
      jsonb_build_object(
        'user_id', v_agent, 'ledger_scope', 'wallet', 'direction', 'cash_out',
        'amount', v_telecom_debit, 'category', 'agent_float_settlement',
        'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
        'source_table', 'withdrawal_requests', 'source_id', v_wr.id,
        'description', format('Telecom sending charge for merchant cash-out %s (guard)', v_wr.id),
        'currency', 'UGX',
        'reference_id', v_wr.id::text || '-merchant-telecom-charge',
        'transaction_date', v_now
      ),
      jsonb_build_object(
        'user_id', v_agent, 'ledger_scope', 'platform', 'direction', 'cash_in',
        'amount', v_telecom_debit, 'category', 'agent_float_settlement',
        'source_table', 'withdrawal_requests', 'source_id', v_wr.id,
        'description', format('Telecom sending charge recovered from merchant float for withdrawal %s (guard)', v_wr.id),
        'currency', 'UGX',
        'reference_id', v_wr.id::text || '-merchant-telecom-charge',
        'transaction_date', v_now
      )
    );
  END IF;

  -- Same key approve-withdrawal uses, so exactly one of the two writers posts.
  PERFORM public.create_ledger_transaction(
    v_entries,
    'approve-withdrawal-merchant-float-consume-' || v_wr.id::text,
    false
  );

  BEGIN
    PERFORM public.consume_merchant_float(
      v_wr.id, v_agent, v_principal, v_telecom_debit,
      GREATEST(round(COALESCE(v_wr.amount, 0)) - v_principal, 0)
        + GREATEST(v_telecom - v_telecom_debit, 0)
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    PERFORM public.classify_merchant_payout_funding(v_wr.id, 'float_debit_guard');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'action', 'float_debited',
    'agent_id', v_agent,
    'withdrawal_id', v_wr.id,
    'amount', COALESCE(v_wr.amount, 0),
    'float_debited', v_debit,
    'principal_debited', v_principal,
    'telecom_debited', v_telecom_debit,
    'telecom_expected', v_telecom,
    'available_before', v_available
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ensure_merchant_payout_float_debit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_merchant_payout_float_debit(uuid) TO service_role;


-- ── 2. withdrawal_settlement_status: three false-positive sources ───────────
-- Since 2026-08-31 not one completed withdrawal has been classified `settled`
-- (2,531 `unsettled`, UGX ~2.0B). Beyond the real telecom gap above, the
-- classifier itself was wrong in three ways:
--
--   a. customer_wallet_debit required the debit leg's user_id to equal
--      withdrawal_requests.user_id. Proxy payouts debit the proxy agent's
--      withdrawable wallet instead (the beneficiary is the request's user), so
--      ~440 correctly-debited payouts read "missing". Now: any non-float wallet
--      cash_out posted against the withdrawal counts.
--   b. Landlord float payouts have no customer-wallet leg by design -- the rent
--      was booked as a company rent_disbursement when the Rent Plan was funded,
--      and the merchant who pays the landlord holds an out-of-pocket receivable.
--      29 such payouts since 2026-08-31 read "customer_wallet_debit missing".
--   c. merchant_telecom_charge ignored telecom shortfalls filed as
--      merchant_out_of_pocket_advances(kind='telecom'), and was demanded of
--      pool-funded payouts that never touch merchant float.
--
-- The merchant is also now taken from who actually settled the payout
-- (processed_by, when that is a cash-out agent) or the funding classifier's
-- record, not processing_started_by -- which is whoever opened the row.
--
-- Lookups switched from `reference_id LIKE '<id>-%'` to equality on the three
-- known references so idx_general_ledger_reference_id is used.
CREATE OR REPLACE FUNCTION public.withdrawal_settlement_status(p_withdrawal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  w record;
  v_merchant uuid;
  v_wallet_debit int := 0;
  v_float numeric := 0;
  v_telecom numeric := 0;
  v_comm numeric := 0;
  v_oop numeric := 0;
  v_oop_telecom numeric := 0;
  v_telecom_expected numeric := 0;
  v_missing jsonb := '[]'::jsonb;
  v_legacy boolean := false;
  v_landlord boolean := false;
  v_pool boolean := false;
  -- Merchant float / telecom / commission legs only began being posted here.
  v_cutoff timestamptz := '2026-07-16 00:00:00+00';
BEGIN
  SELECT * INTO w FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF w IS NULL THEN
    RETURN jsonb_build_object('settled', false, 'missing', to_jsonb(ARRAY['withdrawal_not_found']));
  END IF;

  v_legacy := coalesce(w.processed_at, w.created_at) < v_cutoff;
  v_landlord := w.landlord_payout_id IS NOT NULL
             OR coalesce(w.reason, '') ILIKE 'Landlord float payout%';
  v_pool := coalesce(w.pool_funded, false);

  IF w.processed_by IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.cashout_agents ca WHERE ca.agent_id = w.processed_by) THEN
      v_merchant := w.processed_by;
    ELSE
      SELECT f.agent_id INTO v_merchant
      FROM public.merchant_payout_funding f
      WHERE f.withdrawal_id = p_withdrawal_id
      LIMIT 1;
    END IF;
  ELSE
    v_merchant := coalesce(
      w.dispatch_claimed_by,
      (SELECT ca.agent_id FROM public.cashout_agents ca WHERE ca.id = w.assigned_cashout_agent_id)
    );
  END IF;

  -- Customer side: the withdrawable debit, on whichever wallet funded it
  -- (the requester, or the proxy agent for proxy payouts). Merchant float legs
  -- are excluded -- they are the merchant's side, checked below.
  SELECT count(*) INTO v_wallet_debit
  FROM public.general_ledger
  WHERE source_table = 'withdrawal_requests'
    AND source_id = p_withdrawal_id
    AND ledger_scope = 'wallet'
    AND direction = 'cash_out'
    AND category <> 'agent_float_settlement'
    AND coalesce(wallet_bucket, '') <> 'float';

  SELECT coalesce(sum(amount) FILTER (WHERE reference_id = p_withdrawal_id::text || '-merchant-float-consume'), 0),
         coalesce(sum(amount) FILTER (WHERE reference_id = p_withdrawal_id::text || '-merchant-telecom-charge'), 0),
         coalesce(sum(amount) FILTER (WHERE reference_id = p_withdrawal_id::text || '-cashout-commission'), 0)
    INTO v_float, v_telecom, v_comm
  FROM public.general_ledger
  WHERE reference_id IN (
          p_withdrawal_id::text || '-merchant-float-consume',
          p_withdrawal_id::text || '-merchant-telecom-charge',
          p_withdrawal_id::text || '-cashout-commission')
    AND ledger_scope = 'wallet';

  SELECT coalesce(sum(shortfall_amount) FILTER (WHERE kind IS DISTINCT FROM 'telecom'), 0),
         coalesce(sum(shortfall_amount) FILTER (WHERE kind = 'telecom'), 0)
    INTO v_oop, v_oop_telecom
  FROM public.merchant_out_of_pocket_advances
  WHERE withdrawal_id = p_withdrawal_id;

  IF v_wallet_debit = 0 AND NOT v_landlord THEN
    v_missing := v_missing || to_jsonb('customer_wallet_debit'::text);
  END IF;

  IF v_merchant IS NOT NULL AND NOT v_legacy THEN
    IF NOT v_pool THEN
      IF v_float <= 0 AND v_oop <= 0 THEN
        v_missing := v_missing || to_jsonb('merchant_float_or_out_of_pocket'::text);
      END IF;
      v_telecom_expected := public.merchant_telecom_sending_charge(w.amount);
      IF v_telecom_expected > 0 AND v_telecom <= 0 AND v_oop_telecom <= 0 THEN
        v_missing := v_missing || to_jsonb('merchant_telecom_charge'::text);
      END IF;
    END IF;
    IF v_comm <= 0 THEN
      v_missing := v_missing || to_jsonb('merchant_commission'::text);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'withdrawal_id', p_withdrawal_id,
    'settled', jsonb_array_length(v_missing) = 0,
    'legacy', v_legacy,
    'landlord_payout', v_landlord,
    'pool_funded', v_pool,
    'missing', v_missing,
    'merchant_id', v_merchant,
    'customer_wallet_debit_legs', v_wallet_debit,
    'float_consumed', v_float,
    'out_of_pocket', v_oop,
    'telecom_charge', v_telecom,
    'telecom_out_of_pocket', v_oop_telecom,
    'telecom_expected', v_telecom_expected,
    'commission', v_comm
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.withdrawal_settlement_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.withdrawal_settlement_status(uuid) TO authenticated, service_role;
