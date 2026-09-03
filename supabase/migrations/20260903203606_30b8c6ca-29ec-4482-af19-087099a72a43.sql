-- ============================================================
-- Tenant self-repayment engine — Phase 1
-- Additive: the agent collection engine is untouched.
-- Money path: tenant deposit -> operational float -> rent settled
-- ============================================================

-- 1. Attribution columns -------------------------------------------------
ALTER TABLE public.repayments
  ADD COLUMN IF NOT EXISTS payment_method      text,
  ADD COLUMN IF NOT EXISTS paid_by             uuid,
  ADD COLUMN IF NOT EXISTS initiated_by        uuid,
  ADD COLUMN IF NOT EXISTS deposit_request_id  uuid REFERENCES public.deposit_requests(id),
  ADD COLUMN IF NOT EXISTS external_reference  text;

CREATE UNIQUE INDEX IF NOT EXISTS repayments_deposit_request_id_key
  ON public.repayments (deposit_request_id) WHERE deposit_request_id IS NOT NULL;

ALTER TABLE public.agent_collections
  ADD COLUMN IF NOT EXISTS collection_channel  text NOT NULL DEFAULT 'agent_float',
  ADD COLUMN IF NOT EXISTS initiated_by        uuid,
  ADD COLUMN IF NOT EXISTS deposit_request_id  uuid REFERENCES public.deposit_requests(id),
  ADD COLUMN IF NOT EXISTS performance_weight  numeric NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS agent_collections_deposit_request_id_key
  ON public.agent_collections (deposit_request_id) WHERE deposit_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_collections_channel_idx
  ON public.agent_collections (collection_channel, created_at DESC);

-- 2. Attempt log (every deposit the engine evaluated) --------------------
CREATE TABLE IF NOT EXISTS public.tenant_self_repayment_attempts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_request_id uuid NOT NULL UNIQUE REFERENCES public.deposit_requests(id),
  tenant_id          uuid,
  rent_request_id    uuid,
  agent_id           uuid,
  deposit_amount     numeric NOT NULL DEFAULT 0,
  applied_amount     numeric,
  surplus_amount     numeric,
  outcome            text NOT NULL,           -- settled | refused | error
  reason             text,
  paid_from_phone    text,
  transaction_group_id uuid,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.tenant_self_repayment_attempts TO authenticated;
GRANT ALL    ON public.tenant_self_repayment_attempts TO service_role;
ALTER TABLE public.tenant_self_repayment_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops read self-repayment attempts"
ON public.tenant_self_repayment_attempts FOR SELECT TO authenticated
USING (
  tenant_id = auth.uid()
  OR agent_id = auth.uid()
  OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'tenant_ops')
  OR public.has_role(auth.uid(), 'agent_ops')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'operations')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE TRIGGER trg_tsr_attempts_updated_at
  BEFORE UPDATE ON public.tenant_self_repayment_attempts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. SMS notice queue ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_self_repayment_notices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_request_id uuid NOT NULL REFERENCES public.deposit_requests(id),
  recipient_role     text NOT NULL,            -- tenant | agent
  recipient_user_id  uuid,
  phone              text,
  sms_text           text NOT NULL,
  sms_status         text NOT NULL DEFAULT 'pending',
  attempts           integer NOT NULL DEFAULT 0,
  last_error         text,
  sent_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deposit_request_id, recipient_role)
);

GRANT SELECT ON public.tenant_self_repayment_notices TO authenticated;
GRANT ALL    ON public.tenant_self_repayment_notices TO service_role;
ALTER TABLE public.tenant_self_repayment_notices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops read self-repayment notices"
ON public.tenant_self_repayment_notices FOR SELECT TO authenticated
USING (
  recipient_user_id = auth.uid()
  OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'tenant_ops')
  OR public.has_role(auth.uid(), 'operations')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE INDEX IF NOT EXISTS tsr_notices_pending_idx
  ON public.tenant_self_repayment_notices (sms_status, created_at)
  WHERE sms_status = 'pending';

CREATE TRIGGER trg_tsr_notices_updated_at
  BEFORE UPDATE ON public.tenant_self_repayment_notices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4. Single resolver for the tenant's settle-able plan (DRY, one round trip)
CREATE OR REPLACE FUNCTION public.tenant_self_repayment_plan(p_tenant_id uuid)
RETURNS TABLE (
  rent_request_id  uuid,
  agent_id         uuid,
  landlord_id      uuid,
  landlord_name    text,
  total_repayment  numeric,
  amount_repaid    numeric,
  outstanding      numeric,
  daily_repayment  numeric,
  status           text,
  other_active_plans integer
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH active AS (
    SELECT rr.id, rr.agent_id, rr.landlord_id, rr.total_repayment,
           COALESCE(rr.amount_repaid, 0) AS amount_repaid,
           rr.daily_repayment, rr.status, rr.created_at
      FROM public.rent_requests rr
     WHERE rr.tenant_id = p_tenant_id
       AND rr.status IN ('repaying', 'disbursed', 'funded')
       AND COALESCE(rr.tenancy_status, 'active') <> 'ended'
       AND COALESCE(rr.amount_repaid, 0) < COALESCE(rr.total_repayment, 0)
  )
  SELECT a.id, a.agent_id, a.landlord_id, l.name,
         COALESCE(a.total_repayment, 0), a.amount_repaid,
         GREATEST(0, COALESCE(a.total_repayment, 0) - a.amount_repaid),
         COALESCE(a.daily_repayment, 0), a.status,
         (SELECT count(*)::int - 1 FROM active)
    FROM active a
    LEFT JOIN public.landlords l ON l.id = a.landlord_id
   ORDER BY a.created_at ASC
   LIMIT 1;
$$;

-- 5. Settlement -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_tenant_rent_from_deposit(p_deposit_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dep            record;
  v_plan           record;
  v_float          numeric := 0;
  v_applied        numeric := 0;
  v_surplus        numeric := 0;
  v_parent_id      uuid;
  v_whitelisted    boolean := false;
  v_comm_total     numeric := 0;
  v_comm_agent     numeric := 0;
  v_comm_parent    numeric := 0;
  v_legs           jsonb;
  v_group          uuid := gen_random_uuid();
  v_tracking       text;
  v_collection_id  uuid;
  v_repayment_id   uuid;
  v_new_status     text;
  v_is_agent_actor boolean := false;
  v_agent          record;
  v_reason         text;
  v_purpose        text;
BEGIN
  SELECT dr.id, dr.user_id, dr.amount, dr.status, dr.deposit_purpose::text AS purpose,
         dr.transaction_id, dr.provider, p.phone, p.full_name
    INTO v_dep
    FROM public.deposit_requests dr
    JOIN public.profiles p ON p.id = dr.user_id
   WHERE dr.id = p_deposit_request_id;

  IF NOT FOUND THEN
    -- D1: no profile (or no deposit) -> refuse, never silent
    INSERT INTO public.tenant_self_repayment_attempts (deposit_request_id, deposit_amount, outcome, reason)
    VALUES (p_deposit_request_id, 0, 'refused', 'no_profile_or_deposit')
    ON CONFLICT (deposit_request_id) DO UPDATE
      SET outcome = 'refused', reason = 'no_profile_or_deposit', updated_at = now();
    RETURN jsonb_build_object('success', false, 'reason', 'no_profile_or_deposit');
  END IF;

  IF v_dep.status <> 'approved' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'deposit_not_approved');
  END IF;

  IF EXISTS (SELECT 1 FROM public.repayments r WHERE r.deposit_request_id = p_deposit_request_id) THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true, 'reason', 'already_settled');
  END IF;

  v_purpose := lower(COALESCE(v_dep.purpose, ''));

  -- Agent-family depositors only self-settle when the purpose says so, so
  -- operational float top-ups keep behaving exactly as before.
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = v_dep.user_id
       AND ur.role IN ('agent', 'senior_agent', 'sub_agent')
       AND COALESCE(ur.enabled, true)
  ) INTO v_is_agent_actor;

  IF v_is_agent_actor AND v_purpose <> 'personal_rent_repayment' THEN
    v_reason := 'agent_float_deposit_not_rent_purpose';
  END IF;

  SELECT * INTO v_plan FROM public.tenant_self_repayment_plan(v_dep.user_id);

  IF v_reason IS NULL AND v_plan.rent_request_id IS NULL THEN
    v_reason := 'no_active_rent_plan';
  END IF;

  IF v_reason IS NULL THEN
    v_float   := GREATEST(0, COALESCE((public.get_user_wallet_view(v_dep.user_id) ->> 'float_balance')::numeric, 0));
    v_applied := round(LEAST(COALESCE(v_dep.amount, 0), v_plan.outstanding, v_float), 2);
    IF v_applied <= 0 THEN
      v_reason := CASE WHEN v_float <= 0 THEN 'no_operational_float' ELSE 'nothing_to_apply' END;
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.tenant_self_repayment_attempts (
      deposit_request_id, tenant_id, rent_request_id, agent_id,
      deposit_amount, applied_amount, outcome, reason, paid_from_phone, metadata
    ) VALUES (
      p_deposit_request_id, v_dep.user_id, v_plan.rent_request_id, v_plan.agent_id,
      COALESCE(v_dep.amount, 0), NULL, 'refused', v_reason, v_dep.phone,
      jsonb_build_object('deposit_purpose', v_purpose, 'float_balance', v_float)
    )
    ON CONFLICT (deposit_request_id) DO UPDATE
      SET outcome = 'refused', reason = v_reason, updated_at = now();
    RETURN jsonb_build_object('success', false, 'reason', v_reason);
  END IF;

  v_surplus := GREATEST(0, round(COALESCE(v_dep.amount, 0) - v_applied, 2));

  -- Commission: 10% total. Sub-agent 8% + verified parent 2%, unless whitelisted.
  IF v_plan.agent_id IS NOT NULL THEN
    v_comm_total := round(v_applied * 0.10, 2);

    SELECT sa.parent_agent_id INTO v_parent_id
      FROM public.agent_subagents sa
     WHERE sa.sub_agent_id = v_plan.agent_id
       AND sa.status IN ('verified', 'approved', 'accepted')
       AND sa.parent_agent_id <> sa.sub_agent_id
     LIMIT 1;

    v_whitelisted := public.is_subagent_commission_whitelisted(v_plan.agent_id);

    IF v_parent_id IS NOT NULL AND NOT v_whitelisted THEN
      v_comm_agent  := round(v_applied * 0.08, 2);
      v_comm_parent := v_comm_total - v_comm_agent;
    ELSE
      v_comm_agent  := v_comm_total;
      v_comm_parent := 0;
    END IF;
  END IF;

  v_tracking := 'TSP-' || substr(v_group::text, 1, 8);

  -- Balanced ledger group: operational float settles the rent.
  v_legs := jsonb_build_array(
    jsonb_build_object(
      'user_id', v_dep.user_id,
      'amount', v_applied,
      'direction', 'cash_out',
      'category', 'tenant_repayment',
      'ledger_scope', 'wallet',
      'classification', 'production',
      'description', 'Tenant self-repayment settled from operational float',
      'recipient_type', 'operational_wallet',
      'wallet_bucket', 'float',
      'linked_party', v_plan.landlord_id,
      'source_table', 'agent_collections',
      'source_id', v_plan.rent_request_id,
      'metadata', jsonb_build_object('deposit_request_id', p_deposit_request_id, 'channel', 'tenant_deposit_auto')
    ),
    jsonb_build_object(
      'user_id', v_dep.user_id,
      'amount', v_applied,
      'direction', 'cash_in',
      'category', 'rent_receivable_created',
      'ledger_scope', 'bridge',
      'classification', 'production',
      'description', format('Tenant self-repayment for landlord %s', COALESCE(v_plan.landlord_name, 'Unknown')),
      'linked_party', v_plan.landlord_id,
      'source_table', 'agent_collections',
      'source_id', v_plan.rent_request_id,
      'metadata', jsonb_build_object('deposit_request_id', p_deposit_request_id, 'channel', 'tenant_deposit_auto')
    )
  );

  IF v_comm_total > 0 THEN
    v_legs := v_legs || jsonb_build_array(
      jsonb_build_object(
        'user_id', v_plan.agent_id,
        'amount', v_comm_agent,
        'direction', 'cash_in',
        'category', 'agent_commission_earned',
        'ledger_scope', 'wallet',
        'classification', 'production',
        'description', CASE WHEN v_comm_parent > 0
                            THEN '8% commission on tenant self-repayment'
                            ELSE '10% commission on tenant self-repayment' END,
        'recipient_type', 'user',
        'source_table', 'agent_collections',
        'source_id', v_plan.rent_request_id,
        'metadata', jsonb_build_object('deposit_request_id', p_deposit_request_id, 'channel', 'tenant_deposit_auto')
      ),
      jsonb_build_object(
        'user_id', v_plan.agent_id,
        'amount', v_comm_total,
        'direction', 'cash_out',
        'category', 'agent_commission_payable',
        'ledger_scope', 'platform',
        'classification', 'production',
        'description', 'Platform commission payout on tenant self-repayment',
        'source_table', 'agent_collections',
        'source_id', v_plan.rent_request_id,
        'metadata', jsonb_build_object('deposit_request_id', p_deposit_request_id, 'channel', 'tenant_deposit_auto')
      )
    );

    IF v_comm_parent > 0 THEN
      v_legs := v_legs || jsonb_build_array(
        jsonb_build_object(
          'user_id', v_parent_id,
          'amount', v_comm_parent,
          'direction', 'cash_in',
          'category', 'agent_commission_earned',
          'ledger_scope', 'wallet',
          'classification', 'production',
          'description', '2% parent override on tenant self-repayment',
          'recipient_type', 'user',
          'source_table', 'agent_collections',
          'source_id', v_plan.rent_request_id,
          'metadata', jsonb_build_object('deposit_request_id', p_deposit_request_id, 'channel', 'tenant_deposit_auto')
        )
      );
    END IF;
  END IF;

  PERFORM public.create_ledger_transaction(
    v_legs,
    format('tenant_self_repayment:%s', p_deposit_request_id)
  );

  -- Collection row first: the widened guard shape needs it in-transaction.
  INSERT INTO public.agent_collections (
    agent_id, tenant_id, rent_request_id, amount, payment_method,
    float_before, float_after, tracking_id, notes,
    collection_channel, initiated_by, deposit_request_id, performance_weight,
    expected_amount, shortfall_amount, is_partial
  ) VALUES (
    v_plan.agent_id, v_dep.user_id, v_plan.rent_request_id, v_applied, 'in_app_wallet'::collection_payment_method,
    v_float, v_float, v_tracking, 'Tenant self-repayment from own deposit',
    'tenant_deposit_auto', v_dep.user_id, p_deposit_request_id, 2,
    NULLIF(v_plan.daily_repayment, 0),
    GREATEST(0, COALESCE(v_plan.daily_repayment, 0) - v_applied),
    COALESCE(v_plan.daily_repayment, 0) > v_applied
  )
  RETURNING id INTO v_collection_id;

  UPDATE public.rent_requests
     SET amount_repaid = COALESCE(amount_repaid, 0) + v_applied,
         status = CASE
                    WHEN COALESCE(amount_repaid, 0) + v_applied >= COALESCE(total_repayment, 0) THEN 'completed'
                    WHEN status IN ('disbursed', 'funded', 'approved') THEN 'repaying'
                    ELSE status
                  END,
         last_payment_amount = v_applied,
         updated_at = now()
   WHERE id = v_plan.rent_request_id
  RETURNING status INTO v_new_status;

  INSERT INTO public.repayments (
    tenant_id, rent_request_id, amount,
    payment_method, paid_by, initiated_by, deposit_request_id, external_reference
  ) VALUES (
    v_dep.user_id, v_plan.rent_request_id, v_applied,
    'in_app_wallet', v_dep.user_id, v_dep.user_id, p_deposit_request_id,
    COALESCE(v_dep.transaction_id, v_tracking)
  )
  RETURNING id INTO v_repayment_id;

  INSERT INTO public.tenant_self_repayment_attempts (
    deposit_request_id, tenant_id, rent_request_id, agent_id,
    deposit_amount, applied_amount, surplus_amount, outcome, reason,
    paid_from_phone, transaction_group_id, metadata
  ) VALUES (
    p_deposit_request_id, v_dep.user_id, v_plan.rent_request_id, v_plan.agent_id,
    COALESCE(v_dep.amount, 0), v_applied, v_surplus, 'settled', NULL,
    v_dep.phone, v_group,
    jsonb_build_object(
      'collection_id', v_collection_id,
      'repayment_id', v_repayment_id,
      'tracking_id', v_tracking,
      'commission_total', v_comm_total,
      'commission_agent', v_comm_agent,
      'commission_parent', v_comm_parent,
      'parent_agent_id', v_parent_id,
      'other_active_plans', v_plan.other_active_plans,
      'performance_weight', 2,
      'new_status', v_new_status,
      'outstanding_after', GREATEST(0, v_plan.outstanding - v_applied)
    )
  )
  ON CONFLICT (deposit_request_id) DO UPDATE
    SET outcome = 'settled', reason = NULL, applied_amount = EXCLUDED.applied_amount,
        surplus_amount = EXCLUDED.surplus_amount, metadata = EXCLUDED.metadata,
        transaction_group_id = EXCLUDED.transaction_group_id, updated_at = now();

  -- SMS queue (tenant + agent), drained by the notices worker.
  INSERT INTO public.tenant_self_repayment_notices (
    deposit_request_id, recipient_role, recipient_user_id, phone, sms_text
  ) VALUES (
    p_deposit_request_id, 'tenant', v_dep.user_id, v_dep.phone,
    format(
      'Welile: Rent payment received. UGX %s applied to your Rent Plan%s. Remaining balance: UGX %s. Plan status: %s.',
      to_char(v_applied, 'FM999,999,999'),
      CASE WHEN v_surplus > 0 THEN format(', UGX %s kept for your next payment', to_char(v_surplus, 'FM999,999,999')) ELSE '' END,
      to_char(GREATEST(0, v_plan.outstanding - v_applied), 'FM999,999,999'),
      COALESCE(v_new_status, 'repaying')
    )
  )
  ON CONFLICT (deposit_request_id, recipient_role) DO NOTHING;

  IF v_plan.agent_id IS NOT NULL THEN
    SELECT p.phone, p.full_name INTO v_agent FROM public.profiles p WHERE p.id = v_plan.agent_id;
    INSERT INTO public.tenant_self_repayment_notices (
      deposit_request_id, recipient_role, recipient_user_id, phone, sms_text
    ) VALUES (
      p_deposit_request_id, 'agent', v_plan.agent_id, v_agent.phone,
      format(
        'Welile: %s paid their own rent. UGX %s recorded, your commission UGX %s. Remaining balance: UGX %s.',
        COALESCE(v_dep.full_name, 'Your tenant'),
        to_char(v_applied, 'FM999,999,999'),
        to_char(v_comm_agent, 'FM999,999,999'),
        to_char(GREATEST(0, v_plan.outstanding - v_applied), 'FM999,999,999')
      )
    )
    ON CONFLICT (deposit_request_id, recipient_role) DO NOTHING;
  END IF;

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, description, metadata)
  VALUES (
    'payment_made', v_dep.user_id, 'rent_requests', v_plan.rent_request_id,
    'Tenant self-repayment settled from operational float',
    jsonb_build_object(
      'deposit_request_id', p_deposit_request_id,
      'channel', 'tenant_deposit_auto',
      'applied_amount', v_applied,
      'surplus_amount', v_surplus,
      'commission_total', v_comm_total,
      'agent_id', v_plan.agent_id,
      'performance_weight', 2
    )
  );

  BEGIN
    PERFORM public.capture_trust_signal(v_dep.user_id, 'rent_payment', NULL, NULL, NULL, NULL, NULL,
      'Tenant self-repayment');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'rent_request_id', v_plan.rent_request_id,
    'applied_amount', v_applied,
    'surplus_amount', v_surplus,
    'outstanding_after', GREATEST(0, v_plan.outstanding - v_applied),
    'commission_total', v_comm_total,
    'commission_agent', v_comm_agent,
    'commission_parent', v_comm_parent,
    'collection_id', v_collection_id,
    'repayment_id', v_repayment_id,
    'tracking_id', v_tracking,
    'new_status', v_new_status,
    'performance_weight', 2
  );
END;
$$;

REVOKE ALL ON FUNCTION public.settle_tenant_rent_from_deposit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_tenant_rent_from_deposit(uuid) TO service_role;

-- 6. Auto-hook: one place, every approval path -----------------------------
CREATE OR REPLACE FUNCTION public.tg_tenant_self_repayment_on_deposit_approved()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'approved' AND COALESCE(OLD.status, '') <> 'approved' THEN
    BEGIN
      PERFORM public.settle_tenant_rent_from_deposit(NEW.id);
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        INSERT INTO public.tenant_self_repayment_attempts (
          deposit_request_id, tenant_id, deposit_amount, outcome, reason
        ) VALUES (NEW.id, NEW.user_id, COALESCE(NEW.amount, 0), 'error', left(SQLERRM, 400))
        ON CONFLICT (deposit_request_id) DO UPDATE
          SET outcome = 'error', reason = left(SQLERRM, 400), updated_at = now();
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenant_self_repayment_on_approval ON public.deposit_requests;
CREATE TRIGGER trg_tenant_self_repayment_on_approval
  AFTER UPDATE OF status ON public.deposit_requests
  FOR EACH ROW EXECUTE FUNCTION public.tg_tenant_self_repayment_on_deposit_approved();

-- 7. Widen the agent rent-repayment guard: one extra legal shape ----------
CREATE OR REPLACE FUNCTION public.guard_rent_request_agent_updates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_repayment_delta numeric := COALESCE(NEW.amount_repaid, 0) - COALESCE(OLD.amount_repaid, 0);
  v_current_tx_float_debit numeric := 0;
  v_tenant_paid_debit numeric := 0;
  v_trusted_allocation boolean := false;
  v_expected_status text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.is_sensitive_field_editor(v_uid)
     OR public.has_role(v_uid, 'manager'::app_role) THEN
    RETURN NEW;
  END IF;

  IF NOT (public.has_role(v_uid, 'agent'::app_role)
          OR public.has_role(v_uid, 'senior_agent'::app_role)
          OR public.has_role(v_uid, 'sub_agent'::app_role)) THEN
    RETURN NEW;
  END IF;

  IF v_repayment_delta > 0
     AND OLD.agent_id = v_uid
     AND NEW.agent_id = OLD.agent_id
     AND NEW.tenant_id = OLD.tenant_id
     AND NEW.total_repayment = OLD.total_repayment THEN
    -- Shape 1: the agent advanced their own float.
    SELECT COALESCE(sum(gl.amount), 0)
      INTO v_current_tx_float_debit
      FROM public.general_ledger gl
     WHERE gl.source_table = 'agent_collections'
       AND gl.source_id = OLD.id
       AND gl.user_id = v_uid
       AND gl.category = 'agent_float_used_for_rent'
       AND gl.direction = 'cash_out'
       AND gl.ledger_scope = 'wallet'
       AND gl.wallet_bucket = 'float'
       AND gl.recipient_type = 'operational_wallet'
       AND gl.xmin::text::bigint = txid_current();

    -- Shape 2 (tenant self-repayment): a same-amount tenant_repayment debit on
    -- the operational wallet, float bucket, backed by a non-agent_float
    -- collection row carrying a deposit reference and float_before = float_after.
    SELECT COALESCE(sum(gl.amount), 0)
      INTO v_tenant_paid_debit
      FROM public.general_ledger gl
     WHERE gl.source_table = 'agent_collections'
       AND gl.source_id = OLD.id
       AND gl.category = 'tenant_repayment'
       AND gl.direction = 'cash_out'
       AND gl.ledger_scope = 'wallet'
       AND gl.wallet_bucket = 'float'
       AND gl.recipient_type = 'operational_wallet'
       AND gl.xmin::text::bigint = txid_current()
       AND EXISTS (
         SELECT 1 FROM public.agent_collections ac
          WHERE ac.rent_request_id = OLD.id
            AND ac.amount = gl.amount
            AND ac.collection_channel <> 'agent_float'
            AND ac.deposit_request_id IS NOT NULL
            AND ac.float_before = ac.float_after
       );

    v_expected_status := CASE
      WHEN COALESCE(NEW.amount_repaid, 0) >= COALESCE(NEW.total_repayment, 0)
        THEN 'completed'
      WHEN OLD.status IN ('disbursed', 'funded', 'approved')
        THEN 'repaying'
      ELSE OLD.status
    END;

    v_trusted_allocation :=
      (v_current_tx_float_debit = v_repayment_delta OR v_tenant_paid_debit = v_repayment_delta)
      AND COALESCE(NEW.amount_repaid, 0) <= COALESCE(NEW.total_repayment, 0)
      AND NEW.status = v_expected_status;
  END IF;

  NEW.approved_by := OLD.approved_by;
  NEW.approved_at := OLD.approved_at;
  NEW.funded_at := OLD.funded_at;
  NEW.disbursed_at := OLD.disbursed_at;
  NEW.fund_routed_at := OLD.fund_routed_at;
  NEW.fund_recipient_id := OLD.fund_recipient_id;
  NEW.fund_recipient_type := OLD.fund_recipient_type;
  NEW.fund_recipient_name := OLD.fund_recipient_name;
  NEW.manager_verified := OLD.manager_verified;
  NEW.manager_verified_at := OLD.manager_verified_at;
  NEW.manager_verified_by := OLD.manager_verified_by;

  IF NOT v_trusted_allocation THEN
    NEW.amount_repaid := OLD.amount_repaid;
    NEW.last_payment_amount := OLD.last_payment_amount;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND OLD.status = 'rejected'
     AND OLD.agent_id = v_uid
     AND NEW.status <> 'repaying'
     AND NEW.status <> 'deleted_by_agent' THEN
    NEW.status := 'pending';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      v_trusted_allocation
      OR NEW.status IN ('pending', 'rejected', 'deleted_by_agent')
      OR (OLD.status = 'rejected' AND NEW.status = 'repaying')
    ) THEN
      RAISE EXCEPTION 'Agents cannot move a rent request from % to %', OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 8. Traceability: one canonical view + weighted performance view ----------
CREATE OR REPLACE VIEW public.v_tenant_self_repayments
WITH (security_invoker = on) AS
SELECT
  a.id                                   AS attempt_id,
  a.created_at                            AS paid_at,
  a.tenant_id,
  tp.full_name                            AS tenant_name,
  a.paid_from_phone,
  a.deposit_request_id,
  dr.amount                               AS amount_deposited,
  dr.provider,
  dr.transaction_id                       AS external_reference,
  a.applied_amount,
  a.surplus_amount,
  a.outcome,
  a.reason                                AS refusal_reason,
  a.rent_request_id,
  rr.total_repayment,
  rr.amount_repaid,
  GREATEST(0, COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0)) AS outstanding_after,
  rr.status                               AS plan_status,
  a.agent_id,
  ap.full_name                            AS agent_name,
  (a.metadata ->> 'commission_agent')::numeric  AS commission_agent,
  (a.metadata ->> 'commission_parent')::numeric AS commission_parent,
  (a.metadata ->> 'commission_total')::numeric  AS commission_total,
  (a.metadata ->> 'parent_agent_id')::uuid      AS parent_agent_id,
  a.transaction_group_id,
  ac.tracking_id,
  ac.collection_channel,
  ac.performance_weight
FROM public.tenant_self_repayment_attempts a
LEFT JOIN public.profiles tp        ON tp.id = a.tenant_id
LEFT JOIN public.profiles ap        ON ap.id = a.agent_id
LEFT JOIN public.deposit_requests dr ON dr.id = a.deposit_request_id
LEFT JOIN public.rent_requests rr    ON rr.id = a.rent_request_id
LEFT JOIN public.agent_collections ac ON ac.deposit_request_id = a.deposit_request_id;

GRANT SELECT ON public.v_tenant_self_repayments TO authenticated, service_role;

CREATE OR REPLACE VIEW public.v_agent_collection_performance
WITH (security_invoker = on) AS
SELECT
  ac.agent_id,
  date_trunc('day', ac.created_at)::date        AS collection_day,
  ac.collection_channel,
  count(*)                                      AS collections,
  sum(ac.amount)                                AS amount_collected,
  sum(ac.amount * COALESCE(ac.performance_weight, 1)) AS weighted_amount,
  sum(COALESCE(ac.performance_weight, 1))       AS weighted_count
FROM public.agent_collections ac
GROUP BY 1, 2, 3;

GRANT SELECT ON public.v_agent_collection_performance TO authenticated, service_role;

-- Role-gated reader for the Financial Ops / CFO / Tenant Ops surfaces.
CREATE OR REPLACE FUNCTION public.get_tenant_self_repayments(
  p_from timestamptz DEFAULT (now() - interval '30 days'),
  p_to   timestamptz DEFAULT now(),
  p_outcome text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_limit int DEFAULT 100,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rows jsonb;
  v_total bigint;
  v_totals jsonb;
BEGIN
  IF NOT (
    public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'tenant_ops') OR public.has_role(v_uid, 'agent_ops')
    OR public.has_role(v_uid, 'coo') OR public.has_role(v_uid, 'ceo')
    OR public.has_role(v_uid, 'operations') OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  WITH base AS (
    SELECT * FROM public.tenant_self_repayment_attempts a
     WHERE a.created_at >= p_from AND a.created_at <= p_to
       AND (p_outcome IS NULL OR a.outcome = p_outcome)
  ), joined AS (
    SELECT v.* FROM public.v_tenant_self_repayments v
     JOIN base b ON b.id = v.attempt_id
     WHERE p_search IS NULL OR p_search = ''
       OR v.tenant_name ILIKE '%' || p_search || '%'
       OR v.agent_name ILIKE '%' || p_search || '%'
       OR v.paid_from_phone ILIKE '%' || p_search || '%'
       OR COALESCE(v.external_reference, '') ILIKE '%' || p_search || '%'
       OR COALESCE(v.tracking_id, '') ILIKE '%' || p_search || '%'
  )
  SELECT
    COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.paid_at DESC), '[]'::jsonb),
    (SELECT count(*) FROM joined),
    (SELECT jsonb_build_object(
        'settled_count', count(*) FILTER (WHERE outcome = 'settled'),
        'refused_count', count(*) FILTER (WHERE outcome <> 'settled'),
        'total_applied', COALESCE(sum(applied_amount), 0),
        'total_surplus', COALESCE(sum(surplus_amount), 0),
        'total_commission', COALESCE(sum(commission_total), 0)
      ) FROM joined)
  INTO v_rows, v_total, v_totals
  FROM (
    SELECT * FROM joined ORDER BY paid_at DESC LIMIT GREATEST(1, LEAST(p_limit, 500)) OFFSET GREATEST(0, p_offset)
  ) t;

  RETURN jsonb_build_object('rows', v_rows, 'total', v_total, 'totals', v_totals);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_self_repayments(timestamptz, timestamptz, text, text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_self_repayment_plan(uuid) TO authenticated, service_role;