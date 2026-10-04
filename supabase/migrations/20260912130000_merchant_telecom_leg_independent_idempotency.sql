-- Merchant cash-out: telecom must be an independently-idempotent leg, not a
-- proportional guess or a casualty of "any float debit exists -> skip".
--
-- ── What's actually live right now (verified against production, not just
--    the migration files) ─────────────────────────────────────────────────
-- public.ensure_merchant_payout_float_debit() in production is STILL the
-- pre-2026-08-30 principal-only version: it debits
-- LEAST(available_float, withdrawal_amount) and calls
-- consume_merchant_float(..., consumed_telecom => 0, ...) unconditionally.
-- Migration 20260911180000, which was meant to make this function debit
-- principal+telecom together, exists in this repo but never actually
-- applied to the live database (supabase/migrations diverging from
-- production is a known, recurring issue here -- see CLAUDE.md). Confirmed
-- live via pg_get_functiondef 2026-09-12.
--
-- Concretely: NABBALE CLAIRE's UGX 1,500,000 payout (withdrawal
-- 80a7b8b4-eacf-4e66-9bb2-ee53dd83e538, processed 2026-09-11 15:08 UTC) has
-- a reservation recording consumed_telecom = 2,000, but general_ledger has
-- only the UGX 1,500,000 '-merchant-float-consume' leg -- no
-- '-merchant-telecom-charge' leg exists at all. This is not a one-off: every
-- merchant payout going through the DB guard today loses its telecom fee the
-- same way.
--
-- classify_merchant_payout_funding(), separately, IS live at its
-- 2026-09-04 version: it derives telecom's float coverage proportionally
-- from the principal's coverage ratio instead of reading a real ledger leg
-- (reasonably, since in production no such leg has ever existed to read).
--
-- ── The fix, in one migration since both functions must move together ──────
-- 1. ensure_merchant_payout_float_debit: debits principal and telecom from
--    one pool (principal first, remainder to telecom) when NEITHER leg
--    exists yet -- same allocation approve-withdrawal uses
--    (merchantFloatForPrincipal / merchantFloatForTelecom). But the
--    up-front gate no longer skips everything just because ANY leg exists:
--    principal-posted-but-telecom-missing now backfills ONLY the telecom
--    leg, under its own dedicated idempotency key
--    (`approve-withdrawal-merchant-telecom-charge-<id>`, the same key
--    approve-withdrawal's own read-back/catch-up already posts under, so
--    whichever writer gets there first the other is a safe no-op). Principal
--    is never re-touched once posted.
-- 2. sweep_merchant_payout_float_debits (the finance-invoked repair sweep):
--    same independent-leg check, so it can actually find and offer to fix a
--    principal-only row going forward -- today it structurally cannot, since
--    its candidate query excludes any row with ANY float leg at all.
-- 3. classify_merchant_payout_funding: reads the real '-merchant-telecom-
--    charge' leg for any payout processed at/after this migration (when one
--    will actually exist, per fix #1), instead of proportionally guessing.
--    Payouts processed before this migration keep the exact same proportional
--    approximation they always got -- no reclassification of history, no new
--    receivables raised retroactively. This mirrors the "no backfill" call
--    already made in 20260911180000 for the same class of historical gap.
--
-- Nothing here touches any already-posted ledger row. sweep's candidate
-- query and classify's real-leg read are both bounded by the same cutoff
-- below, so neither can reach into the pre-existing backlog of historical
-- principal-only payouts.

-- ── 1. The guard: independent principal/telecom idempotency ───────────────
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
  v_principal_posted numeric := 0;
  v_telecom_posted numeric := 0;
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

  -- Principal and telecom checked as two INDEPENDENT legs by their own
  -- reference_id, not one "any float debit exists" gate. Under the old gate
  -- a principal-only debit (float ran out exactly between principal and
  -- telecom, or the shared idempotency key got pre-empted) permanently
  -- blocked the telecom leg from ever posting, here or via the finance sweep.
  SELECT
    COALESCE(SUM(g.amount) FILTER (WHERE g.reference_id = v_wr.id::text || '-merchant-float-consume'), 0),
    COALESCE(SUM(g.amount) FILTER (WHERE g.reference_id = v_wr.id::text || '-merchant-telecom-charge'), 0)
  INTO v_principal_posted, v_telecom_posted
  FROM public.general_ledger g
  WHERE g.source_table = 'withdrawal_requests'
    AND g.source_id = v_wr.id
    AND g.ledger_scope = 'wallet'
    AND g.wallet_bucket = 'float'
    AND g.direction = 'cash_out'
    AND g.user_id = v_agent
    AND g.reference_id IN (
      v_wr.id::text || '-merchant-float-consume',
      v_wr.id::text || '-merchant-telecom-charge'
    );

  v_telecom := public.merchant_telecom_sending_charge(v_wr.amount);

  IF v_principal_posted > 0 AND (v_telecom_posted > 0 OR v_telecom <= 0) THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'float_debit_already_posted');
  END IF;

  v_pos := public.get_merchant_float_position(v_agent);
  v_available := GREATEST(COALESCE((v_pos->>'available_float')::numeric, 0), 0);

  IF v_principal_posted > 0 THEN
    -- Principal already landed (elsewhere); this call's only job is the
    -- missing telecom leg. Principal is never re-touched or reposted.
    v_telecom_debit := round(LEAST(v_available, GREATEST(v_telecom - v_telecom_posted, 0)));

    IF v_telecom_debit <= 0 THEN
      BEGIN
        PERFORM public.classify_merchant_payout_funding(v_wr.id, 'float_debit_guard');
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
      RETURN jsonb_build_object('action', 'no_telecom_float_available', 'agent_id', v_agent,
        'principal_already_posted', v_principal_posted, 'telecom_expected', v_telecom);
    END IF;

    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_agent, 'ledger_scope', 'wallet', 'direction', 'cash_out',
          'amount', v_telecom_debit, 'category', 'agent_float_settlement',
          'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
          'source_table', 'withdrawal_requests', 'source_id', v_wr.id,
          'description', format('Telecom sending charge for merchant cash-out %s (guard catch-up)', v_wr.id),
          'currency', 'UGX',
          'reference_id', v_wr.id::text || '-merchant-telecom-charge',
          'transaction_date', v_now
        ),
        jsonb_build_object(
          'user_id', v_agent, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_telecom_debit, 'category', 'agent_float_settlement',
          'source_table', 'withdrawal_requests', 'source_id', v_wr.id,
          'description', format('Telecom sending charge recovered from merchant float for withdrawal %s (guard catch-up)', v_wr.id),
          'currency', 'UGX',
          'reference_id', v_wr.id::text || '-merchant-telecom-charge',
          'transaction_date', v_now
        )
      ),
      -- Same key approve-withdrawal's own read-back/catch-up posts under --
      -- whichever writer gets there first, the other is a safe no-op.
      'approve-withdrawal-merchant-telecom-charge-' || v_wr.id::text,
      false
    );

    BEGIN
      PERFORM public.classify_merchant_payout_funding(v_wr.id, 'float_debit_guard');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    RETURN jsonb_build_object(
      'action', 'telecom_leg_backfilled',
      'agent_id', v_agent,
      'withdrawal_id', v_wr.id,
      'telecom_debited', v_telecom_debit,
      'telecom_expected', v_telecom,
      'principal_already_posted', v_principal_posted
    );
  END IF;

  -- Neither leg posted yet: principal first, then telecom, from one pool --
  -- the same allocation approve-withdrawal uses.
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


-- ── 2. classify_merchant_payout_funding: read the real telecom leg ────────
-- forward from this migration; keep the proportional approximation for
-- anything processed before it so no historical row is reclassified.
CREATE OR REPLACE FUNCTION public.classify_merchant_payout_funding(p_withdrawal_id uuid, p_via text DEFAULT 'manual'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  w record;
  v_agent uuid;
  v_amount numeric := 0;
  v_telecom numeric := 0;
  v_float_principal numeric := 0;
  v_float_telecom numeric := 0;
  v_own_principal numeric := 0;
  v_own_telecom numeric := 0;
  v_source text;
  v_receivable numeric := 0;
  v_completed boolean := false;
  v_has_reservation boolean := false;
  v_note text := NULL;
  -- Before this timestamp, no payout ever received an independent telecom
  -- ledger leg (the guard was principal-only in production); the real-leg
  -- read below would just read "0" for every one of them. Payouts at/after
  -- this point actually get a telecom leg when float covers it (fix
  -- shipped in 20260912130000).
  v_telecom_leg_cutoff CONSTANT timestamptz := '2026-09-12 13:00:00+00';
BEGIN
  SELECT * INTO w FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF w.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'withdrawal_not_found');
  END IF;

  SELECT r.agent_id INTO v_agent
  FROM public.merchant_float_reservations r
  WHERE r.withdrawal_id = p_withdrawal_id
  LIMIT 1;
  v_has_reservation := v_agent IS NOT NULL;

  IF v_agent IS NULL THEN
    SELECT ca.agent_id INTO v_agent
    FROM public.cashout_agents ca
    WHERE ca.is_active = true
      AND ca.agent_id IN (w.dispatch_claimed_by, w.processed_by, w.processing_started_by)
    LIMIT 1;
  END IF;

  IF v_agent IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'not_a_merchant_payout');
  END IF;

  v_completed := COALESCE(w.status, '') IN ('paid', 'completed');
  v_amount := GREATEST(0, COALESCE(w.amount, 0));
  v_telecom := public.telecom_sending_charge(v_amount);

  SELECT COALESCE(SUM(gl.amount), 0) INTO v_float_principal
  FROM public.general_ledger gl
  WHERE gl.reference_id = p_withdrawal_id::text || '-merchant-float-consume'
    AND gl.ledger_scope = 'wallet' AND gl.direction = 'cash_out';

  v_float_principal := LEAST(v_float_principal, v_amount);

  IF COALESCE(w.processed_at, w.updated_at, w.created_at) >= v_telecom_leg_cutoff THEN
    -- Telecom now genuinely gets its own ledger leg -- read it directly.
    SELECT COALESCE(SUM(gl.amount), 0) INTO v_float_telecom
    FROM public.general_ledger gl
    WHERE gl.reference_id = p_withdrawal_id::text || '-merchant-telecom-charge'
      AND gl.ledger_scope = 'wallet' AND gl.direction = 'cash_out';
    v_float_telecom := LEAST(v_float_telecom, v_telecom);
  ELSIF v_amount > 0 THEN
    -- Legacy payouts: no independent leg was ever posted for these: derive
    -- telecom coverage from the principal's coverage ratio, same as before
    -- (2026-09-04). Finance already decided not to reclassify this backlog.
    v_float_telecom := LEAST(v_telecom, ROUND(v_telecom * v_float_principal / v_amount));
  ELSE
    v_float_telecom := 0;
  END IF;

  v_own_principal := GREATEST(0, v_amount - v_float_principal);
  v_own_telecom := GREATEST(0, v_telecom - v_float_telecom);

  IF NOT v_completed OR (NOT v_has_reservation AND v_float_principal + v_float_telecom = 0) THEN
    v_source := CASE WHEN NOT v_completed THEN 'unknown' ELSE 'needs_review' END;
    v_note := CASE
      WHEN NOT v_completed
        THEN 'Payout not completed (status=' || COALESCE(w.status,'null') || '); funding source undecided.'
      ELSE 'No float reservation and no float movement on this payout: funding source cannot be proven from the books. Needs finance review before any receivable is raised.'
    END;

    DELETE FROM public.merchant_out_of_pocket_advances
    WHERE withdrawal_id = p_withdrawal_id
      AND status IN ('pending_reimbursement', 'needs_review')
      AND attested_at IS NULL
      AND reviewed_at IS NULL
      AND note LIKE 'Phase 6 classification:%';

    SELECT COALESCE(SUM(shortfall_amount), 0) INTO v_receivable
    FROM public.merchant_out_of_pocket_advances
    WHERE withdrawal_id = p_withdrawal_id;

    INSERT INTO public.merchant_payout_funding
      (withdrawal_id, agent_id, payout_amount, telecom_charge_expected,
       float_consumed_principal, float_consumed_telecom, own_cash_principal,
       own_cash_telecom, receivable_recorded, funding_source, classified_via, notes)
    VALUES (p_withdrawal_id, v_agent, v_amount, v_telecom, v_float_principal,
            v_float_telecom, 0, 0, v_receivable, v_source, p_via, v_note)
    ON CONFLICT (withdrawal_id) DO UPDATE
      SET agent_id = EXCLUDED.agent_id,
          payout_amount = EXCLUDED.payout_amount,
          telecom_charge_expected = EXCLUDED.telecom_charge_expected,
          float_consumed_principal = EXCLUDED.float_consumed_principal,
          float_consumed_telecom = EXCLUDED.float_consumed_telecom,
          own_cash_principal = 0,
          own_cash_telecom = 0,
          receivable_recorded = EXCLUDED.receivable_recorded,
          funding_source = EXCLUDED.funding_source,
          classified_via = EXCLUDED.classified_via,
          notes = EXCLUDED.notes,
          classified_at = now(),
          updated_at = now();

    RETURN jsonb_build_object('ok', true, 'withdrawal_id', p_withdrawal_id,
      'agent_id', v_agent, 'funding_source', v_source, 'status', w.status,
      'float_consumed_principal', v_float_principal,
      'own_cash_principal', 0, 'own_cash_telecom', 0,
      'receivable_recorded', v_receivable, 'note', v_note);
  END IF;

  v_source := CASE
    WHEN v_amount = 0 THEN 'none'
    WHEN v_float_principal + v_float_telecom = 0 THEN 'own_cash'
    WHEN v_own_principal + v_own_telecom = 0 THEN 'float'
    ELSE 'mixed'
  END;

  IF v_own_principal > 0 THEN
    INSERT INTO public.merchant_out_of_pocket_advances
      (agent_id, withdrawal_id, kind, payout_amount, telecom_charge, float_used,
       shortfall_amount, status, note)
    VALUES (v_agent, p_withdrawal_id, 'payout', v_amount, v_telecom,
            v_float_principal, ROUND(v_own_principal), 'pending_reimbursement',
            'Phase 6 classification: company float covered UGX ' ||
            ROUND(v_float_principal)::text || ' of UGX ' || ROUND(v_amount)::text ||
            '; UGX ' || ROUND(v_own_principal)::text ||
            ' fronted by the merchant from their own phone and recorded as money the company owes them.')
    ON CONFLICT (withdrawal_id, kind) DO UPDATE
      SET float_used = EXCLUDED.float_used,
          telecom_charge = EXCLUDED.telecom_charge,
          payout_amount = EXCLUDED.payout_amount,
          shortfall_amount = EXCLUDED.shortfall_amount,
          status = EXCLUDED.status,
          note = EXCLUDED.note,
          updated_at = now()
      WHERE public.merchant_out_of_pocket_advances.status IN ('pending_reimbursement', 'needs_review')
        AND public.merchant_out_of_pocket_advances.attested_at IS NULL
        AND public.merchant_out_of_pocket_advances.reviewed_at IS NULL;
  ELSE
    DELETE FROM public.merchant_out_of_pocket_advances
    WHERE withdrawal_id = p_withdrawal_id AND kind = 'payout'
      AND status IN ('pending_reimbursement', 'needs_review')
      AND attested_at IS NULL
      AND reviewed_at IS NULL;
  END IF;

  IF v_own_telecom > 0 THEN
    INSERT INTO public.merchant_out_of_pocket_advances
      (agent_id, withdrawal_id, kind, payout_amount, telecom_charge, float_used,
       shortfall_amount, status, note)
    VALUES (v_agent, p_withdrawal_id, 'telecom', v_amount, v_telecom,
            v_float_telecom, ROUND(v_own_telecom), 'pending_reimbursement',
            'Phase 6 classification: telecom fee is reserved/debited in the same breath as the principal; company float covered UGX ' ||
            ROUND(v_float_telecom)::text || ' of UGX ' || ROUND(v_telecom)::text ||
            ' (same coverage ratio as the principal). UGX ' || ROUND(v_own_telecom)::text ||
            ' fronted by the merchant from their own phone and recorded as money the company owes them.')
    ON CONFLICT (withdrawal_id, kind) DO UPDATE
      SET float_used = EXCLUDED.float_used,
          telecom_charge = EXCLUDED.telecom_charge,
          payout_amount = EXCLUDED.payout_amount,
          shortfall_amount = EXCLUDED.shortfall_amount,
          status = EXCLUDED.status,
          note = EXCLUDED.note,
          updated_at = now()
      WHERE public.merchant_out_of_pocket_advances.status IN ('pending_reimbursement', 'needs_review')
        AND public.merchant_out_of_pocket_advances.attested_at IS NULL
        AND public.merchant_out_of_pocket_advances.reviewed_at IS NULL;
  ELSE
    DELETE FROM public.merchant_out_of_pocket_advances
    WHERE withdrawal_id = p_withdrawal_id AND kind = 'telecom'
      AND status IN ('pending_reimbursement', 'needs_review')
      AND attested_at IS NULL
      AND reviewed_at IS NULL;
  END IF;

  SELECT COALESCE(SUM(shortfall_amount), 0) INTO v_receivable
  FROM public.merchant_out_of_pocket_advances
  WHERE withdrawal_id = p_withdrawal_id;

  INSERT INTO public.merchant_payout_funding
    (withdrawal_id, agent_id, payout_amount, telecom_charge_expected,
     float_consumed_principal, float_consumed_telecom, own_cash_principal,
     own_cash_telecom, receivable_recorded, funding_source, classified_via, notes)
  VALUES (p_withdrawal_id, v_agent, v_amount, v_telecom, v_float_principal,
          v_float_telecom, ROUND(v_own_principal), ROUND(v_own_telecom),
          v_receivable, v_source, p_via, NULL)
  ON CONFLICT (withdrawal_id) DO UPDATE
    SET agent_id = EXCLUDED.agent_id,
        payout_amount = EXCLUDED.payout_amount,
        telecom_charge_expected = EXCLUDED.telecom_charge_expected,
        float_consumed_principal = EXCLUDED.float_consumed_principal,
        float_consumed_telecom = EXCLUDED.float_consumed_telecom,
        own_cash_principal = EXCLUDED.own_cash_principal,
        own_cash_telecom = EXCLUDED.own_cash_telecom,
        receivable_recorded = EXCLUDED.receivable_recorded,
        funding_source = EXCLUDED.funding_source,
        classified_via = EXCLUDED.classified_via,
        notes = NULL,
        classified_at = now(),
        updated_at = now();

  UPDATE public.merchant_float_reservations
     SET consumed_float = v_float_principal,
         consumed_telecom = v_float_telecom,
         out_of_pocket_amount = ROUND(v_own_principal + v_own_telecom),
         updated_at = now()
   WHERE withdrawal_id = p_withdrawal_id;

  RETURN jsonb_build_object(
    'ok', true, 'withdrawal_id', p_withdrawal_id, 'agent_id', v_agent,
    'funding_source', v_source, 'payout_amount', v_amount,
    'telecom_charge_expected', v_telecom,
    'float_consumed_principal', v_float_principal,
    'float_consumed_telecom', v_float_telecom,
    'own_cash_principal', ROUND(v_own_principal),
    'own_cash_telecom', ROUND(v_own_telecom),
    'receivable_recorded', v_receivable);
END;
$function$;

REVOKE ALL ON FUNCTION public.classify_merchant_payout_funding(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.classify_merchant_payout_funding(uuid, text) TO service_role;


-- ── 3. Finance repair sweep: same independent-leg detection ────────────────
-- Bounded by the same cutoff as classify's real-leg read, so this can never
-- reach into the pre-existing historical backlog (Finance already decided
-- not to touch that -- see 20260911180000).
CREATE OR REPLACE FUNCTION public.sweep_merchant_payout_float_debits(
  p_days integer DEFAULT 7,
  p_dry_run boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_days integer := greatest(1, least(120, coalesce(p_days, 7)));
  v_cutoff CONSTANT timestamptz := '2026-09-12 13:00:00+00';
  v_rows jsonb := '[]'::jsonb;
  v_r record;
  v_res jsonb;
  v_total numeric := 0;
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo') OR has_role(auth.uid(), 'financial_ops')
          OR has_role(auth.uid(), 'manager') OR has_role(auth.uid(), 'super_admin')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  FOR v_r IN
    SELECT w.id, w.amount, ca.agent_id, COALESCE(p.full_name, 'Unknown') AS agent_name
    FROM public.withdrawal_requests w
    JOIN public.cashout_agents ca ON ca.id = w.assigned_cashout_agent_id
    LEFT JOIN public.profiles p ON p.id = ca.agent_id
    WHERE w.status = 'completed'
      AND COALESCE(w.processed_at, w.updated_at) >= GREATEST(now() - (v_days || ' days')::interval, v_cutoff)
      AND COALESCE(w.reason, '') NOT ILIKE 'Landlord float payout%'
      AND COALESCE((public.get_merchant_float_position(ca.agent_id)->>'available_float')::numeric, 0) > 0
      AND (
        NOT EXISTS (
          SELECT 1 FROM public.general_ledger g
          WHERE g.source_table = 'withdrawal_requests' AND g.source_id = w.id
            AND g.ledger_scope = 'wallet' AND g.wallet_bucket = 'float'
            AND g.direction = 'cash_out' AND g.user_id = ca.agent_id
            AND g.reference_id = w.id::text || '-merchant-float-consume'
        )
        OR (
          public.merchant_telecom_sending_charge(w.amount) > 0
          AND NOT EXISTS (
            SELECT 1 FROM public.general_ledger g
            WHERE g.source_table = 'withdrawal_requests' AND g.source_id = w.id
              AND g.ledger_scope = 'wallet' AND g.wallet_bucket = 'float'
              AND g.direction = 'cash_out' AND g.user_id = ca.agent_id
              AND g.reference_id = w.id::text || '-merchant-telecom-charge'
          )
        )
      )
    ORDER BY COALESCE(w.processed_at, w.updated_at) DESC
    LIMIT 500
  LOOP
    IF p_dry_run THEN
      v_res := jsonb_build_object('action', 'would_debit', 'withdrawal_id', v_r.id,
                                  'agent_name', v_r.agent_name, 'amount', v_r.amount);
    ELSE
      v_res := public.ensure_merchant_payout_float_debit(v_r.id)
               || jsonb_build_object('agent_name', v_r.agent_name);
      v_total := v_total + COALESCE((v_res->>'float_debited')::numeric, 0)
                          + COALESCE((v_res->>'telecom_debited')::numeric, 0);
    END IF;
    v_rows := v_rows || v_res;
  END LOOP;

  RETURN jsonb_build_object('days', v_days, 'dry_run', p_dry_run, 'cutoff', v_cutoff,
                            'candidates', jsonb_array_length(v_rows),
                            'float_debited_total', v_total, 'rows', v_rows);
END;
$function$;

REVOKE ALL ON FUNCTION public.sweep_merchant_payout_float_debits(integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sweep_merchant_payout_float_debits(integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_merchant_payout_float_debits(integer, boolean) TO service_role;
