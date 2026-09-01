-- Settlement must enforce the evidence gate itself, not trust the caller.
--
-- WHY. Since 20260829140000, EVERY auto-classified own-cash claim is filed
-- straight into `pending_reimbursement` the moment a payout is classified --
-- evidenced or not. Whether a claim is actually book-supported is decided by
-- `v_merchant_oop_evidence` (`is_evidenced` / `evidenced_amount`), which only
-- `useMerchantSettlementDebts` on the client ever reads. `settle_merchant_out_
-- of_pocket` -- the only RPC that actually moves money -- never looked at
-- evidence at all: it settled ANY row with `status = 'pending_reimbursement'`
-- and credited the raw `shortfall_amount`. Two consequences, both live today:
--
--   1. A direct RPC call (Postman, stale bundle, a future UI regression) can
--      settle a claim from the "books disagree" bucket -- there is no
--      server-side check stopping it, only a client-side filter.
--   2. Even a claim the UI correctly routes as "evidenced" can be UNDER-
--      evidenced: `is_evidenced` is boolean (true for ANY negative float
--      position, however small), while `evidenced_amount` is capped at what
--      the books actually support and can be far smaller than
--      `shortfall_amount`. The dialog displays `evidencedAmount` in its
--      payable total, but `sendToWallet` only passes advance ids -- so the
--      RPC pays the full claimed `shortfall_amount` regardless, which can be
--      many times the evidenced sliver the operator actually saw and approved.
--
-- WHAT CHANGES. The RPC now re-derives the same evidence used by
-- `v_merchant_oop_evidence` inline (finance-attested, or the desk's ledger
-- position at the payout's own timestamp) and:
--   - refuses to settle a claim unless it is FULLY evidenced -- the books (or
--     an explicit Finance attestation) support the entire `shortfall_amount`,
--     not just part of it. A partially-evidenced claim is skipped with a
--     reason rather than silently paid in full or silently paid short of what
--     was claimed; Finance can close the gap with an explicit attestation
--     (`review`/evidence basis), which is already the documented escape valve
--     for obligations the ledger cannot prove.
--   - an estimated telecom charge (no provider reference, not finance-
--     attested) is never settleable, matching the dialog's "not yet
--     claimable" label.
--   - credits `v_evidenced_amount` (which, once the full-evidence check
--     passes, equals `shortfall_amount`) rather than the raw column, so the
--     amount actually moved can never exceed what the books support even if
--     the evidence formula changes again later.
--
-- Nothing else about the RPC changes: same role gate (cfo/financial_ops/
-- super_admin), same self-settlement block, same per-agent batching, same
-- idempotency via `merchant_oop_settlements.advance_id UNIQUE`, same ledger
-- legs and audit trail.

CREATE OR REPLACE FUNCTION public.settle_merchant_out_of_pocket(
  p_advance_ids uuid[],
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_batch_id uuid := gen_random_uuid();
  v_agent uuid;
  v_advance_id uuid;
  v_row record;
  v_finance_attested boolean;
  v_is_estimate boolean;
  v_is_evidenced boolean;
  v_evidenced_amount numeric;
  v_total numeric;
  v_settled_ids uuid[];
  v_ref text;
  v_group_id uuid;
  v_now timestamptz := now();
  v_entries jsonb;
  v_settled jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'cfo')
    OR public.has_role(v_actor, 'financial_ops')
    OR public.has_role(v_actor, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'MERCHANT_OOP_SETTLEMENT_NOT_AUTHORIZED: only the CFO, Financial Ops or a super admin can settle agent own-money claims'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_advance_ids IS NULL OR array_length(p_advance_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'settled', '[]'::jsonb, 'skipped', '[]'::jsonb, 'batch_id', v_batch_id);
  END IF;

  FOR v_agent IN
    SELECT DISTINCT o.agent_id
    FROM public.merchant_out_of_pocket_advances o
    WHERE o.id = ANY(p_advance_ids)
  LOOP
    -- Self-settlement block: skip this agent's rows in the batch, do not
    -- fail the whole call (other agents in the same batch still settle).
    IF v_agent = v_actor THEN
      FOR v_advance_id IN
        SELECT o.id FROM public.merchant_out_of_pocket_advances o
        WHERE o.id = ANY(p_advance_ids) AND o.agent_id = v_agent
      LOOP
        v_skipped := v_skipped || jsonb_build_object(
          'advance_id', v_advance_id, 'reason', 'MERCHANT_OOP_SETTLEMENT_SELF_BLOCKED'
        );
      END LOOP;
      CONTINUE;
    END IF;

    v_total := 0;
    v_settled_ids := ARRAY[]::uuid[];

    -- Evidence is re-derived here, row by row, exactly as
    -- `v_merchant_oop_evidence` computes it -- the RPC never trusts a
    -- client-filtered id list as proof a claim is payable.
    FOR v_row IN
      SELECT o.*,
             COALESCE(w.processed_at, w.updated_at, o.created_at) AS payout_at,
             public.merchant_float_position_at(
               o.agent_id, COALESCE(w.processed_at, w.updated_at, o.created_at)
             ) AS float_position_at_payout
      FROM public.merchant_out_of_pocket_advances o
      LEFT JOIN public.withdrawal_requests w ON w.id = o.withdrawal_id
      WHERE o.id = ANY(p_advance_ids) AND o.agent_id = v_agent
      FOR UPDATE OF o
    LOOP
      IF v_row.status <> 'pending_reimbursement' THEN
        v_skipped := v_skipped || jsonb_build_object(
          'advance_id', v_row.id,
          'reason', CASE WHEN v_row.status = 'reimbursed' THEN 'already_reimbursed' ELSE 'not_confirmed_yet' END
        );
        CONTINUE;
      END IF;

      v_finance_attested := COALESCE(v_row.evidence ->> 'finance_attested', '') = 'true';
      v_is_estimate := v_row.kind = 'telecom'
        AND COALESCE(v_row.evidence ->> 'telecom_charge_ref', '') = ''
        AND NOT v_finance_attested;
      v_is_evidenced := v_finance_attested OR v_row.float_position_at_payout < 0;
      v_evidenced_amount := CASE
        WHEN v_finance_attested THEN v_row.shortfall_amount
        ELSE LEAST(v_row.shortfall_amount, GREATEST(0, -v_row.float_position_at_payout))
      END;

      IF v_is_estimate THEN
        v_skipped := v_skipped || jsonb_build_object(
          'advance_id', v_row.id, 'reason', 'estimated_telecom_charge_not_claimable'
        );
        CONTINUE;
      END IF;

      IF NOT v_is_evidenced OR v_evidenced_amount < v_row.shortfall_amount THEN
        v_skipped := v_skipped || jsonb_build_object(
          'advance_id', v_row.id,
          'reason', CASE WHEN NOT v_is_evidenced THEN 'not_evidenced_by_books' ELSE 'partially_evidenced_only' END,
          'shortfall_amount', v_row.shortfall_amount,
          'evidenced_amount', v_evidenced_amount
        );
        CONTINUE;
      END IF;

      BEGIN
        INSERT INTO public.merchant_oop_settlements (advance_id, agent_id, amount, batch_id, settled_by, note)
        VALUES (v_row.id, v_agent, v_evidenced_amount, v_batch_id, v_actor, p_note);
      EXCEPTION WHEN unique_violation THEN
        v_skipped := v_skipped || jsonb_build_object('advance_id', v_row.id, 'reason', 'already_reimbursed');
        CONTINUE;
      END;

      v_total := v_total + v_evidenced_amount;
      v_settled_ids := v_settled_ids || v_row.id;
    END LOOP;

    IF v_total > 0 THEN
      v_ref := v_agent::text || '-oop-settlement-' || v_batch_id::text;

      v_entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_agent, 'ledger_scope', 'platform', 'direction', 'cash_out',
          'amount', v_total, 'category', 'merchant_oop_reimbursement',
          'source_table', 'merchant_out_of_pocket_advances', 'source_id', v_settled_ids[1],
          'description', 'Reimbursement of own money fronted for company payouts (' ||
                          array_length(v_settled_ids, 1)::text || ' claim(s))',
          'currency', 'UGX', 'reference_id', v_ref, 'transaction_date', v_now
        ),
        jsonb_build_object(
          'user_id', v_agent, 'ledger_scope', 'wallet', 'direction', 'cash_in',
          'amount', v_total, 'category', 'merchant_oop_reimbursement',
          'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
          'source_table', 'merchant_out_of_pocket_advances', 'source_id', v_settled_ids[1],
          'description', 'Settlement of own money fronted for company payouts (' ||
                          array_length(v_settled_ids, 1)::text || ' claim(s))',
          'currency', 'UGX', 'reference_id', v_ref, 'transaction_date', v_now
        )
      );

      v_group_id := public.create_ledger_transaction(
        v_entries,
        'finops-oop-settlement-' || v_batch_id::text || '-' || v_agent::text,
        false
      );

      UPDATE public.merchant_oop_settlements
         SET ledger_group_id = v_group_id
       WHERE advance_id = ANY(v_settled_ids);

      UPDATE public.merchant_out_of_pocket_advances
         SET status = 'reimbursed',
             reimbursed_at = v_now,
             reimbursed_by = v_actor,
             updated_at = v_now
       WHERE id = ANY(v_settled_ids);

      INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
      VALUES (
        v_actor, 'merchant_oop_settled', 'merchant_out_of_pocket_advances', v_settled_ids[1],
        'Settled ' || array_length(v_settled_ids, 1)::text || ' own-money claim(s), UGX ' ||
          trim(to_char(v_total, 'FM999,999,999')) || ', paid to wallet.',
        jsonb_build_object(
          'agent_id', v_agent, 'advance_ids', to_jsonb(v_settled_ids), 'total_amount', v_total,
          'ledger_group_id', v_group_id, 'batch_id', v_batch_id, 'note', p_note
        )
      );

      v_settled := v_settled || jsonb_build_object(
        'agent_id', v_agent, 'amount', v_total,
        'advance_ids', to_jsonb(v_settled_ids), 'ledger_group_id', v_group_id
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'settled', v_settled, 'skipped', v_skipped, 'batch_id', v_batch_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.settle_merchant_out_of_pocket(uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_merchant_out_of_pocket(uuid[], text) TO authenticated, service_role;
