-- One-off ops correction (2026-09-28), requested by Josh Wanda.
--
-- 1. Unlink sub-agent Katusiime Promise (1eaa4087-...) from parent
--    PROMROSE KATUSIIME (ffadf3bf-...), agent_subagents row e528ddfa-....
--    Mirrors admin_unlink_subagent: archive the link, delete it, cancel pending
--    tenant transfers, lift parent-imposed listing blocks, audit. Tenants stay
--    with the sub-agent.
-- 2. Refund the UGX 4,000 parent-agent 3-strike penalty charged to the parent
--    on 2026-09-28 09:10 UTC (general_ledger d66edca5-..., listing 566bb564-...).
--    Same shape as the 2026-07-22 KANUNA KEITH refund (20260722094752):
--    CR parent withdrawable via system_balance_correction, reverse the platform
--    listing_rejection_recovery leg.
--
-- The sub-agent's own UGX 4,000 rejection charge (bc0c9490-...) is NOT touched.
-- Idempotent: safe if Lovable re-applies this file after a manual run.

DO $$
DECLARE
  c_link    constant uuid := 'e528ddfa-06eb-49fc-ab61-417a8d8a400d';
  c_parent  constant uuid := 'ffadf3bf-8ec7-46b0-b347-a8da55a443a7';
  c_sub     constant uuid := '1eaa4087-a367-463a-8bb0-aba1ed59524f';
  c_penalty constant uuid := 'd66edca5-34b6-4ed3-b5ff-eaa22bd7f346';
  c_reason  constant text := 'Ops correction 2026-09-28: sub-agent unlinked and parent 3-strike penalty refunded on request of Josh Wanda';
  v_amt       numeric;
  v_links     int := 0;
  v_cancelled int := 0;
  v_refunded  boolean := false;
BEGIN
  -- ── 1. Unlink ────────────────────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM public.agent_subagents
              WHERE id = c_link AND parent_agent_id = c_parent AND sub_agent_id = c_sub) THEN

    WITH cx AS (
      UPDATE public.subagent_tenant_transfers
         SET status = 'rejected', decided_at = now(),
             decision_reason = 'Auto-cancelled: sub-agent made independent by operations'
       WHERE parent_agent_id = c_parent AND status = 'pending'
         AND (from_sub_agent_id = c_sub OR to_sub_agent_id = c_sub)
      RETURNING 1)
    SELECT count(*) INTO v_cancelled FROM cx;

    UPDATE public.agent_listing_blocks
       SET active = false, unblocked_at = now(),
           unblock_reason = 'Operations made the sub-agent independent'
     WHERE agent_id = c_sub AND active AND blocked_by = c_parent
       AND COALESCE(auto_blocked, false) = false;

    WITH gone AS (
      DELETE FROM public.agent_subagents
       WHERE parent_agent_id = c_parent AND sub_agent_id = c_sub
      RETURNING id, parent_agent_id, sub_agent_id, source, status, created_at
    ), archived AS (
      INSERT INTO public.agent_subagent_link_archive
        (original_id, parent_agent_id, sub_agent_id, source, status,
         original_created_at, archive_reason, archived_by)
      SELECT g.id, g.parent_agent_id, g.sub_agent_id, g.source, g.status,
             g.created_at, c_reason, NULL
      FROM gone g
      RETURNING original_id)
    SELECT count(*) INTO v_links FROM archived;

    INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
    VALUES ('subagent_made_independent', 'agent_subagents', c_link::text, NULL,
            jsonb_build_object('parent_agent_id', c_parent, 'sub_agent_id', c_sub,
                               'links_removed', v_links, 'transfers_cancelled', v_cancelled,
                               'actor_kind', 'operations_migration', 'reason', c_reason));
  END IF;

  -- ── 2. Refund the parent penalty ────────────────────────────────────────
  SELECT amount INTO v_amt FROM public.general_ledger
   WHERE id = c_penalty AND user_id = c_parent
     AND category = 'listing_rejection_penalty' AND direction = 'cash_out';

  IF v_amt IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.general_ledger
        WHERE idempotency_key = 'refund_parent_rejection_penalty:' || c_penalty::text) THEN
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', c_parent, 'amount', v_amt, 'direction', 'cash_in',
          'category', 'system_balance_correction', 'ledger_scope', 'wallet',
          'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
          'source_table', 'general_ledger', 'source_id', c_penalty::text,
          'description', 'Refund: parent-agent listing rejection penalty (Katusiime Promise) — sub-agent unlinked',
          'currency', 'UGX'),
        jsonb_build_object(
          'amount', v_amt, 'direction', 'cash_out',
          'category', 'listing_rejection_recovery', 'ledger_scope', 'platform',
          'source_table', 'general_ledger', 'source_id', c_penalty::text,
          'description', 'Reversal of parent-agent rejection penalty for Katusiime Promise',
          'currency', 'UGX')
      ),
      'refund_parent_rejection_penalty:' || c_penalty::text,
      true
    );
    v_refunded := true;

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (c_parent, 'parent_rejection_penalty_refund', 'general_ledger', c_penalty::text,
            jsonb_build_object('refunded_amount_ugx', v_amt, 'sub_agent', 'Katusiime Promise',
                               'sub_agent_id', c_sub, 'reason', c_reason));
  END IF;

  RAISE NOTICE 'links_removed=% transfers_cancelled=% refunded=%', v_links, v_cancelled, v_refunded;
END $$;

-- 3. Added the same day after Josh's follow-up: refund the sub-agent's OWN
--    UGX 4,000 rejection charge on the same listing (general_ledger bc0c9490-...).
DO $$
DECLARE
  c_sub     constant uuid := '1eaa4087-a367-463a-8bb0-aba1ed59524f';
  c_penalty constant uuid := 'bc0c9490-1d87-4da0-8b07-36a1611d1a08';
  v_amt numeric;
BEGIN
  SELECT amount INTO v_amt FROM public.general_ledger
   WHERE id = c_penalty AND user_id = c_sub
     AND category = 'listing_rejection_penalty' AND direction = 'cash_out';

  IF v_amt IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.general_ledger
        WHERE idempotency_key = 'refund_listing_rejection_penalty:' || c_penalty::text) THEN
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', c_sub, 'amount', v_amt, 'direction', 'cash_in',
          'category', 'system_balance_correction', 'ledger_scope', 'wallet',
          'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
          'source_table', 'general_ledger', 'source_id', c_penalty::text,
          'description', 'Refund: listing rejection charge reversed by operations',
          'currency', 'UGX'),
        jsonb_build_object(
          'amount', v_amt, 'direction', 'cash_out',
          'category', 'listing_rejection_recovery', 'ledger_scope', 'platform',
          'source_table', 'general_ledger', 'source_id', c_penalty::text,
          'description', 'Reversal of listing rejection charge for Katusiime Promise',
          'currency', 'UGX')
      ),
      'refund_listing_rejection_penalty:' || c_penalty::text,
      true
    );
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (c_sub, 'listing_rejection_penalty_refund', 'general_ledger', c_penalty::text,
            jsonb_build_object('refunded_amount_ugx', v_amt, 'listing_id', '566bb564-a5e2-48bd-b9b3-2b85241e0873',
                               'reason', 'Ops correction 2026-09-28 on request of Josh Wanda'));
  END IF;
END $$;

-- 4. Make both refunds actually reach the wallets. enforce_correction_classification
--    force-classifies every system_balance_correction leg as 'admin_correction', and
--    wallet_strict_for_user ignores admin_correction CREDITS (it counts only its debits).
--    So the refund credits in steps 2 and 3 were in the ledger but never in the wallet
--    balance (PROMROSE showed 20,000 instead of 24,000). Re-post each credit as a
--    production listing_rejection_offset (the category already used 1,878x to give back
--    rejection charges). Pair it with a platform system_balance_correction cash_out that
--    cancels the invisible admin_correction credit. The group is a correction group:
--    production legs net 0 across all four groups, and admin_correction legs net 0.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('ffadf3bf-8ec7-46b0-b347-a8da55a443a7'::uuid, 'd66edca5-34b6-4ed3-b5ff-eaa22bd7f346'::uuid, '1015f902-30c2-43be-bd93-4b34b09c332b'::uuid, 'parent-agent penalty (Katusiime Promise)'),
    ('1eaa4087-a367-463a-8bb0-aba1ed59524f'::uuid, 'bc0c9490-1d87-4da0-8b07-36a1611d1a08'::uuid, 'd08358b4-f8df-48e3-85e2-0d9629d5cf29'::uuid, 'listing rejection charge')
  ) v(user_id, penalty_id, invisible_credit_id, what)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM general_ledger WHERE idempotency_key = 'refund_visible_fix:' || r.penalty_id::text) THEN
      PERFORM public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object(
            'user_id', r.user_id, 'amount', 4000, 'direction', 'cash_in',
            'category', 'listing_rejection_offset', 'ledger_scope', 'wallet',
            'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
            'source_table', 'general_ledger', 'source_id', r.penalty_id::text,
            'description', 'Refund: ' || r.what || ' reversed by operations',
            'currency', 'UGX'),
          jsonb_build_object(
            'amount', 4000, 'direction', 'cash_out',
            'category', 'system_balance_correction', 'ledger_scope', 'platform',
            'source_table', 'general_ledger', 'source_id', r.invisible_credit_id::text,
            'description', 'Neutralise admin_correction refund credit ' || r.invisible_credit_id::text || ' (excluded from wallet balance); re-posted as listing_rejection_offset',
            'currency', 'UGX')
        ),
        'refund_visible_fix:' || r.penalty_id::text,
        true
      );
      INSERT INTO audit_logs (user_id, action_type, table_name, record_id, metadata)
      VALUES (r.user_id, 'listing_rejection_refund_made_visible', 'general_ledger', r.penalty_id::text,
        jsonb_build_object('amount_ugx', 4000, 'invisible_credit_id', r.invisible_credit_id,
          'reason', 'system_balance_correction cash_in is force-classified admin_correction and excluded by wallet_strict_for_user; re-posted as production listing_rejection_offset'));
    END IF;
    PERFORM public.refresh_wallet_projection_for(r.user_id);
  END LOOP;
END $$;
