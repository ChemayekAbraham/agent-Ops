-- Merchant own-money settlement: Financial Ops has never had a way to
-- actually PAY an agent back for money they fronted out of pocket once
-- their company float ran to zero. `merchant_out_of_pocket_advances` already
-- tracks the debt (needs_review -> pending_reimbursement via
-- review_merchant_out_of_pocket), but nothing anywhere ever set
-- status='reimbursed' or touched reimbursed_at/reimbursed_by — confirmed by
-- exhaustive search. `MerchantDebtSettlementDialog` was explicitly
-- read-only (PDF export only). This migration adds the missing execution
-- step: a settlement RPC that credits the agent's WITHDRAWABLE wallet
-- directly, under a category distinct from commission so it is never
-- conflated with it in any report or statement.

-- ── 1. Chart-of-accounts entry for this expense, distinct from commission ──
INSERT INTO public.ledger_account_catalog (code, label, section, nature, sort_order)
VALUES ('X5', 'Reimbursement of Agent-Fronted Payouts', 'expense', 'expense', 50)
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when)
VALUES ('platform', 'merchant_oop_reimbursement', NULL, 'X5', 'cash_out')
ON CONFLICT (ledger_scope, category, COALESCE(wallet_bucket, '*')) DO NOTHING;
-- The wallet-scope leg (withdrawable bucket, cash_in) needs no explicit row:
-- sofp_ledger_legs already falls a wallet-scope withdrawable leg through to
-- L1 "Wallet Custody Payable" by default — the same as agent_commission_earned,
-- which also has no wallet-scope map row.

INSERT INTO public.cash_flow_line_map (account_code, category, section, group_label, group_sort, line_label, line_sort, display_only)
VALUES (NULL, 'merchant_oop_reimbursement', 'operating', 'Agent Products and Services', 20, 'Reimbursement of agent-fronted payouts', 16, false);

-- ── 2. Idempotency + audit table (mirrors merchant_commission_awards) ──────
-- One row per advance, ever — the UNIQUE constraint is what makes
-- double-settling a single claim impossible even under concurrent calls,
-- independent of the ledger's own idempotency key.
CREATE TABLE IF NOT EXISTS public.merchant_oop_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id uuid NOT NULL UNIQUE REFERENCES public.merchant_out_of_pocket_advances(id),
  agent_id uuid NOT NULL,
  amount numeric NOT NULL,
  batch_id uuid NOT NULL,
  ledger_group_id uuid,
  settled_by uuid NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT now(),
  note text
);

GRANT SELECT ON public.merchant_oop_settlements TO authenticated;
GRANT ALL ON public.merchant_oop_settlements TO service_role;

ALTER TABLE public.merchant_oop_settlements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent reads own settlements"
ON public.merchant_oop_settlements FOR SELECT TO authenticated
USING (agent_id = auth.uid());

CREATE POLICY "finance reads all settlements"
ON public.merchant_oop_settlements FOR SELECT TO authenticated
USING (
  public.is_ops_role(auth.uid())
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE INDEX idx_merchant_oop_settlements_agent ON public.merchant_oop_settlements (agent_id, settled_at DESC);
CREATE INDEX idx_merchant_oop_settlements_batch ON public.merchant_oop_settlements (batch_id);

-- ── 3. The settlement RPC ──────────────────────────────────────────────────
-- Role-gated NARROWER than review_merchant_out_of_pocket (cfo/financial_ops/
-- super_admin only, no 'manager') because this moves real money, not just
-- confirms a claim — matches the narrower gate guard_agent_landlord_float_
-- correction uses for actual float corrections. Self-block mirrors
-- FLOAT_CORRECTION_SELF_BLOCKED: a Financial Ops user cannot settle their own
-- claim. Only status='pending_reimbursement' rows are eligible — needs_review
-- claims must go through review_merchant_out_of_pocket first, unchanged.
-- Groups the input ids by agent so each agent gets exactly one ledger pair
-- for their share of the batch. Safe to retry: already-settled ids are
-- skipped, not double-credited.
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

    FOR v_row IN
      SELECT * FROM public.merchant_out_of_pocket_advances o
      WHERE o.id = ANY(p_advance_ids) AND o.agent_id = v_agent
      FOR UPDATE
    LOOP
      IF v_row.status <> 'pending_reimbursement' THEN
        v_skipped := v_skipped || jsonb_build_object(
          'advance_id', v_row.id,
          'reason', CASE WHEN v_row.status = 'reimbursed' THEN 'already_reimbursed' ELSE 'not_confirmed_yet' END
        );
        CONTINUE;
      END IF;

      BEGIN
        INSERT INTO public.merchant_oop_settlements (advance_id, agent_id, amount, batch_id, settled_by, note)
        VALUES (v_row.id, v_agent, v_row.shortfall_amount, v_batch_id, v_actor, p_note);
      EXCEPTION WHEN unique_violation THEN
        v_skipped := v_skipped || jsonb_build_object('advance_id', v_row.id, 'reason', 'already_reimbursed');
        CONTINUE;
      END;

      v_total := v_total + v_row.shortfall_amount;
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
