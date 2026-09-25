-- Make the contact location-capture bonus actually pay UGX 100.
--
-- `agent_capture_contact_location()` has always called
--   credit_agent_event_bonus(agent, 'contact_location_capture', target, 'loc:<target>')
-- but that key has never been in the function's price list, so it returned
--   {"status":"error","message":"Unknown event_type: contact_location_capture"}
-- which the caller stored in system_events.metadata.bonus and otherwise ignored.
--
-- Measured on 2026-09-25: 44 capture events since 2026-07-26 across 37 distinct
-- agent/contact pairs — 44 errored, 0 credited. Recent run-rate is 25 in the
-- last 30 days, so the forward cost is roughly UGX 2,500 a month.
--
-- Same class of defect as the three keys removed in
-- 20260925100000_phase1_commission_corrections.sql. The difference is that this
-- one is a bonus we intend to pay, so it is fixed rather than dropped.
--
-- The payment is bounded on both sides:
--   * `has_agent_contact_relationship(agent, target)` is asserted before any
--     work, so an agent can only capture for a contact they manage;
--   * the source id is 'loc:<target_id>', and credit_agent_event_bonus rejects
--     a duplicate (source_id, agent_id, event_type) before inserting, so the
--     pair pays once and only once, backed by the idempotency key
--     'agent_event_bonus:contact_location_capture:loc:<target_id>'.
--
-- Ledger impact: none beyond one more group of the shape the other five event
-- bonuses already post — wallet `agent_commission` (falls back to L1) against
-- platform `marketing_expense` (X1), so DR X1 100 / CR L1 100. No new account,
-- no new ledger_account_map row, no ledger_category_allowlist change, and no
-- balancedLedgerPost.ts caller is involved. The group carries no treasury
-- category, so trg_enforce_ledger_group_mapped_balance logs rather than raises.
--
-- NOT back-paid. The 37 historical pairs are left alone; paying them would be a
-- separate, deliberate credit.

CREATE OR REPLACE FUNCTION public.credit_agent_event_bonus(
  p_agent_id uuid,
  p_event_type text,
  p_tenant_id uuid DEFAULT NULL::uuid,
  p_source_id text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_amount NUMERIC;
  v_description TEXT;
  v_row_id UUID;
  v_now TIMESTAMPTZ := now();
  v_group_id UUID;
  v_idem TEXT;
BEGIN
  IF p_agent_id IS NULL THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_agent');
  END IF;

  v_amount := CASE p_event_type
    WHEN 'contact_location_capture'   THEN 100
    WHEN 'house_listed'               THEN 2000
    WHEN 'subagent_registration'      THEN 10000
    WHEN 'three_verified_houses'      THEN 10000
    WHEN 'tenant_placement'           THEN 10000
    WHEN 'service_centre_setup'       THEN 25000
    ELSE NULL
  END;

  IF v_amount IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Unknown event_type: ' || p_event_type);
  END IF;

  v_description := CASE p_event_type
    WHEN 'contact_location_capture'   THEN 'Bonus: Contact location captured'
    WHEN 'house_listed'               THEN 'Bonus: Empty house listed'
    WHEN 'subagent_registration'      THEN 'Bonus: Sub-agent registration'
    WHEN 'three_verified_houses'      THEN 'Bonus: Sub-agent listed 3 verified houses'
    WHEN 'tenant_placement'           THEN 'Bonus: Tenant placement'
    WHEN 'service_centre_setup'       THEN 'Bonus: Service Centre setup'
  END;

  IF p_source_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM commission_accrual_ledger
    WHERE source_id = p_source_id AND agent_id = p_agent_id AND event_type = p_event_type
  ) THEN
    RETURN jsonb_build_object('status', 'already_credited');
  END IF;

  INSERT INTO commission_accrual_ledger (
    agent_id, event_type, commission_role, source_type, tenant_id, source_id,
    amount, description, status, earned_at, created_at
  ) VALUES (
    p_agent_id, p_event_type, 'event_bonus', p_event_type, p_tenant_id, p_source_id,
    v_amount, v_description, 'pending', v_now, v_now
  )
  RETURNING id INTO v_row_id;

  v_idem := 'agent_event_bonus:' || p_event_type || ':' || COALESCE(p_source_id, v_row_id::text);

  BEGIN
    v_group_id := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', p_agent_id,
          'amount', v_amount,
          'direction', 'cash_in',
          'category', 'agent_commission',
          'ledger_scope', 'wallet',
          'recipient_type', 'user',
          'source_table', 'commission_accrual_ledger',
          'source_id', v_row_id::text,
          'description', v_description
        ),
        jsonb_build_object(
          'user_id', p_agent_id,
          'amount', v_amount,
          'direction', 'cash_out',
          'category', 'marketing_expense',
          'ledger_scope', 'platform',
          'source_table', 'commission_accrual_ledger',
          'source_id', v_row_id::text,
          'description', 'Marketing expense: ' || v_description
        )
      ),
      v_idem
    );
  EXCEPTION WHEN unique_violation THEN
    UPDATE commission_accrual_ledger
    SET status = 'credited', paid_at = v_now
    WHERE id = v_row_id;
    RETURN jsonb_build_object('status', 'already_credited', 'event_type', p_event_type);
  END;

  UPDATE commission_accrual_ledger
  SET status = 'credited', paid_at = v_now
  WHERE id = v_row_id;

  RETURN jsonb_build_object(
    'status', 'credited',
    'event_type', p_event_type,
    'amount', v_amount,
    'description', v_description,
    'transaction_group_id', v_group_id
  );
END;
$function$;
