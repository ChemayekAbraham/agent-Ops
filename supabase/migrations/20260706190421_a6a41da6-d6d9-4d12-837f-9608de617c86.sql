
-- =========================================================================
-- 1. Extend welile_homes_subscriptions for the agent-collection model
-- =========================================================================
ALTER TABLE public.welile_homes_subscriptions
  ADD COLUMN IF NOT EXISTS agent_id uuid,
  ADD COLUMN IF NOT EXISTS enrolled_by uuid,
  ADD COLUMN IF NOT EXISTS has_smartphone boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS landlord_uses_wallet boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payout_day integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS monthly_landlord_fee numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS receivable_total numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outstanding_balance numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_due_date date,
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'savings',
  ADD COLUMN IF NOT EXISTS landlord_name text,
  ADD COLUMN IF NOT EXISTS landlord_phone text;

CREATE INDEX IF NOT EXISTS idx_whs_agent ON public.welile_homes_subscriptions (agent_id);
CREATE INDEX IF NOT EXISTS idx_whs_mode ON public.welile_homes_subscriptions (mode);

-- Agents can view subscriptions they manage
DROP POLICY IF EXISTS "Agents view their managed subscriptions" ON public.welile_homes_subscriptions;
CREATE POLICY "Agents view their managed subscriptions"
  ON public.welile_homes_subscriptions FOR SELECT
  TO authenticated
  USING (agent_id = auth.uid());

-- Ops/finance roles can view all subscriptions
DROP POLICY IF EXISTS "Ops view all subscriptions" ON public.welile_homes_subscriptions;
CREATE POLICY "Ops view all subscriptions"
  ON public.welile_homes_subscriptions FOR SELECT
  TO authenticated
  USING (public.is_ops_role(auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.welile_homes_subscriptions TO authenticated;
GRANT ALL ON public.welile_homes_subscriptions TO service_role;

-- =========================================================================
-- 2. Monthly dues schedule (receivable x 12)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.welile_homes_monthly_dues (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES public.welile_homes_subscriptions(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  landlord_id uuid,
  agent_id uuid,
  period_month date NOT NULL,
  payout_date date NOT NULL,
  amount_due numeric NOT NULL DEFAULT 0,
  amount_collected numeric NOT NULL DEFAULT 0,
  landlord_fee numeric NOT NULL DEFAULT 0,       -- 10%
  agent_commission numeric NOT NULL DEFAULT 0,   -- 2%
  welile_net numeric NOT NULL DEFAULT 0,         -- 8%
  landlord_net numeric NOT NULL DEFAULT 0,       -- 90%
  collection_status text NOT NULL DEFAULT 'pending',  -- pending | partial | collected
  payout_status text NOT NULL DEFAULT 'unpaid',       -- unpaid | paid_wallet | paid_float
  ledger_transaction_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, period_month),
  CONSTRAINT whmd_collection_status_check CHECK (collection_status IN ('pending','partial','collected')),
  CONSTRAINT whmd_payout_status_check CHECK (payout_status IN ('unpaid','paid_wallet','paid_float'))
);

CREATE INDEX IF NOT EXISTS idx_whmd_subscription ON public.welile_homes_monthly_dues (subscription_id);
CREATE INDEX IF NOT EXISTS idx_whmd_agent ON public.welile_homes_monthly_dues (agent_id);
CREATE INDEX IF NOT EXISTS idx_whmd_tenant ON public.welile_homes_monthly_dues (tenant_id);
CREATE INDEX IF NOT EXISTS idx_whmd_payout ON public.welile_homes_monthly_dues (payout_status, payout_date);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.welile_homes_monthly_dues TO authenticated;
GRANT ALL ON public.welile_homes_monthly_dues TO service_role;

ALTER TABLE public.welile_homes_monthly_dues ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Agents view own dues" ON public.welile_homes_monthly_dues;
CREATE POLICY "Agents view own dues"
  ON public.welile_homes_monthly_dues FOR SELECT
  TO authenticated
  USING (agent_id = auth.uid());

DROP POLICY IF EXISTS "Tenants view own dues" ON public.welile_homes_monthly_dues;
CREATE POLICY "Tenants view own dues"
  ON public.welile_homes_monthly_dues FOR SELECT
  TO authenticated
  USING (tenant_id = auth.uid());

DROP POLICY IF EXISTS "Ops view all dues" ON public.welile_homes_monthly_dues;
CREATE POLICY "Ops view all dues"
  ON public.welile_homes_monthly_dues FOR SELECT
  TO authenticated
  USING (public.is_ops_role(auth.uid()));

DROP TRIGGER IF EXISTS update_whmd_updated_at ON public.welile_homes_monthly_dues;
CREATE TRIGGER update_whmd_updated_at BEFORE UPDATE ON public.welile_homes_monthly_dues
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =========================================================================
-- 3. enroll_welile_home_tenant  (transactional)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.enroll_welile_home_tenant(
  p_tenant_id uuid,
  p_agent_id uuid,
  p_monthly_rent numeric,
  p_payout_day integer DEFAULT 5,
  p_has_smartphone boolean DEFAULT true,
  p_landlord_uses_wallet boolean DEFAULT false,
  p_landlord_id uuid DEFAULT NULL,
  p_landlord_name text DEFAULT NULL,
  p_landlord_phone text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_sub_id uuid;
  v_fee numeric;
  v_agent_comm numeric;
  v_welile_net numeric;
  v_landlord_net numeric;
  v_receivable numeric;
  v_payout_day int;
  v_period date;
  v_collected numeric;
  i int;
BEGIN
  IF p_monthly_rent IS NULL OR p_monthly_rent <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Monthly rent must be greater than zero');
  END IF;
  IF p_tenant_id IS NULL OR p_agent_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tenant and agent are required');
  END IF;

  v_payout_day    := LEAST(GREATEST(COALESCE(p_payout_day, 5), 1), 28);
  v_fee           := round(p_monthly_rent * 0.10, 2);
  v_agent_comm    := round(p_monthly_rent * 0.02, 2);
  v_welile_net    := v_fee - v_agent_comm;
  v_landlord_net  := p_monthly_rent - v_fee;
  v_receivable    := round(p_monthly_rent * 12, 2);

  INSERT INTO public.welile_homes_subscriptions (
    tenant_id, landlord_id, monthly_rent, subscription_status,
    agent_id, enrolled_by, has_smartphone, landlord_uses_wallet, payout_day,
    monthly_landlord_fee, receivable_total, outstanding_balance,
    mode, landlord_name, landlord_phone, notes
  ) VALUES (
    p_tenant_id,
    CASE WHEN p_landlord_uses_wallet THEN p_landlord_id ELSE NULL END,
    p_monthly_rent, 'active',
    p_agent_id, p_agent_id, p_has_smartphone, p_landlord_uses_wallet, v_payout_day,
    v_fee, v_receivable, v_receivable,
    'agent_collection', p_landlord_name, p_landlord_phone, p_notes
  )
  ON CONFLICT (tenant_id) DO UPDATE SET
    landlord_id          = EXCLUDED.landlord_id,
    monthly_rent         = EXCLUDED.monthly_rent,
    subscription_status  = 'active',
    agent_id             = EXCLUDED.agent_id,
    has_smartphone       = EXCLUDED.has_smartphone,
    landlord_uses_wallet = EXCLUDED.landlord_uses_wallet,
    payout_day           = EXCLUDED.payout_day,
    monthly_landlord_fee = EXCLUDED.monthly_landlord_fee,
    receivable_total     = EXCLUDED.receivable_total,
    mode                 = 'agent_collection',
    landlord_name        = EXCLUDED.landlord_name,
    landlord_phone       = EXCLUDED.landlord_phone,
    notes                = EXCLUDED.notes,
    updated_at           = now()
  RETURNING id INTO v_sub_id;

  -- Generate the 12-month receivable schedule (idempotent)
  FOR i IN 0..11 LOOP
    v_period := (date_trunc('month', current_date) + (i || ' months')::interval)::date;
    INSERT INTO public.welile_homes_monthly_dues (
      subscription_id, tenant_id, landlord_id, agent_id,
      period_month, payout_date,
      amount_due, landlord_fee, agent_commission, welile_net, landlord_net
    ) VALUES (
      v_sub_id, p_tenant_id,
      CASE WHEN p_landlord_uses_wallet THEN p_landlord_id ELSE NULL END,
      p_agent_id,
      v_period, (v_period + (v_payout_day - 1)),
      p_monthly_rent, v_fee, v_agent_comm, v_welile_net, v_landlord_net
    )
    ON CONFLICT (subscription_id, period_month) DO NOTHING;
  END LOOP;

  -- Recompute outstanding from schedule minus what's already collected
  SELECT COALESCE(sum(amount_collected), 0) INTO v_collected
  FROM public.welile_homes_monthly_dues WHERE subscription_id = v_sub_id;

  UPDATE public.welile_homes_subscriptions
  SET outstanding_balance = GREATEST(0, v_receivable - v_collected),
      next_due_date = (SELECT min(payout_date) FROM public.welile_homes_monthly_dues
                       WHERE subscription_id = v_sub_id AND collection_status <> 'collected'),
      updated_at = now()
  WHERE id = v_sub_id;

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES ('agent_collection', p_agent_id, 'welile_homes_subscription', v_sub_id,
      jsonb_build_object('action','enroll','tenant_id',p_tenant_id,'monthly_rent',p_monthly_rent,'receivable_total',v_receivable));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'subscription_id', v_sub_id,
    'monthly_rent', p_monthly_rent,
    'receivable_total', v_receivable,
    'monthly_landlord_fee', v_fee,
    'agent_commission_per_month', v_agent_comm,
    'landlord_net_per_month', v_landlord_net
  );
END;
$function$;

-- =========================================================================
-- 4. welile_home_record_collection
-- =========================================================================
CREATE OR REPLACE FUNCTION public.welile_home_record_collection(
  p_subscription_id uuid,
  p_amount numeric,
  p_source text DEFAULT 'tenant_wallet',   -- tenant_wallet | agent_allocation
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id uuid;
  v_agent_id uuid;
  v_landlord_id uuid;
  v_outstanding numeric;
  v_monthly_rent numeric;
  v_cap numeric;
  v_agent_comm numeric;
  v_remaining numeric;
  v_take numeric;
  v_room numeric;
  v_due record;
  v_legs jsonb;
  v_txn uuid;
  v_key text;
  v_strict_float numeric := 0;
  v_tenant_avail numeric := 0;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;
  IF p_source NOT IN ('tenant_wallet','agent_allocation') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid source');
  END IF;

  SELECT tenant_id, agent_id, landlord_id, outstanding_balance, monthly_rent
  INTO v_tenant_id, v_agent_id, v_landlord_id, v_outstanding, v_monthly_rent
  FROM public.welile_homes_subscriptions
  WHERE id = p_subscription_id AND mode = 'agent_collection';

  IF v_tenant_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Welile Homes subscription not found');
  END IF;
  IF COALESCE(v_outstanding, 0) <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'No outstanding balance to collect');
  END IF;

  v_cap := LEAST(p_amount, v_outstanding);

  -- Source-specific balance guards
  IF p_source = 'tenant_wallet' THEN
    SELECT GREATEST(0, COALESCE(total_visible, 0)) INTO v_tenant_avail
    FROM public.v_user_wallet_strict WHERE user_id = v_tenant_id;
    IF v_tenant_avail < v_cap THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'INSUFFICIENT_TENANT_BALANCE',
        'error', format('Tenant wallet balance (%s) is less than the amount to collect (%s)', v_tenant_avail, v_cap));
    END IF;
  ELSE
    IF v_agent_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'No managing agent for allocation');
    END IF;
    SELECT GREATEST(0, COALESCE(float_balance, 0)) INTO v_strict_float
    FROM public.v_user_wallet_strict WHERE user_id = v_agent_id;
    IF v_strict_float < v_cap THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'INSUFFICIENT_FLOAT',
        'error', format('Agent float (%s) is less than the amount to allocate (%s)', v_strict_float, v_cap));
    END IF;
  END IF;

  v_agent_comm := round(v_cap * 0.02, 2);

  v_key := format('welile_home_collect:%s:%s:%s:%s:%s',
    p_subscription_id, p_source, v_cap, extract(epoch from clock_timestamp())::text, gen_random_uuid()::text);

  IF p_source = 'tenant_wallet' THEN
    v_legs := jsonb_build_array(
      jsonb_build_object('user_id',v_tenant_id,'amount',v_cap,'direction','cash_out','category','rent_repayment','ledger_scope','wallet','classification','production','description','Welile Homes rent collected from tenant wallet','linked_party',v_landlord_id,'source_table','welile_homes_monthly_dues','source_id',p_subscription_id),
      jsonb_build_object('user_id',v_tenant_id,'amount',v_cap,'direction','cash_in','category','rent_repayment','ledger_scope','platform','classification','production','description','Welile Homes rent received','linked_party',v_landlord_id,'source_table','welile_homes_subscriptions','source_id',p_subscription_id)
    );
  ELSE
    v_legs := jsonb_build_array(
      jsonb_build_object('user_id',v_agent_id,'amount',v_cap,'direction','cash_out','category','rent_payment_for_tenant','ledger_scope','wallet','classification','production','description','Welile Homes rent allocated from agent float','linked_party',v_landlord_id,'recipient_type','operational_wallet','source_table','welile_homes_monthly_dues','source_id',p_subscription_id),
      jsonb_build_object('user_id',v_agent_id,'amount',v_cap,'direction','cash_in','category','rent_repayment','ledger_scope','platform','classification','production','description','Welile Homes rent received (agent-allocated)','linked_party',v_landlord_id,'source_table','welile_homes_subscriptions','source_id',p_subscription_id)
    );
  END IF;

  -- Agent 2% commission (out of Welile's 10%)
  IF v_agent_id IS NOT NULL AND v_agent_comm > 0 THEN
    v_legs := v_legs || jsonb_build_array(
      jsonb_build_object('user_id',v_agent_id,'amount',v_agent_comm,'direction','cash_out','category','agent_commission_payable','ledger_scope','platform','classification','production','description','Welile Homes 2% agent commission (platform)','source_table','welile_homes_subscriptions','source_id',p_subscription_id),
      jsonb_build_object('user_id',v_agent_id,'amount',v_agent_comm,'direction','cash_in','category','agent_commission_earned','ledger_scope','wallet','classification','production','description','Welile Homes 2% agent commission','recipient_type','user','source_table','welile_homes_subscriptions','source_id',p_subscription_id)
    );
  END IF;

  v_txn := public.create_ledger_transaction(v_legs, v_key, true);

  -- Apply collected amount to earliest open dues (FIFO)
  v_remaining := v_cap;
  FOR v_due IN
    SELECT id, amount_due, amount_collected
    FROM public.welile_homes_monthly_dues
    WHERE subscription_id = p_subscription_id AND collection_status <> 'collected'
    ORDER BY period_month
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_room := v_due.amount_due - v_due.amount_collected;
    IF v_room <= 0 THEN CONTINUE; END IF;
    v_take := LEAST(v_remaining, v_room);
    UPDATE public.welile_homes_monthly_dues
    SET amount_collected = amount_collected + v_take,
        collection_status = CASE WHEN amount_collected + v_take >= amount_due THEN 'collected' ELSE 'partial' END,
        ledger_transaction_id = COALESCE(ledger_transaction_id, v_txn),
        updated_at = now()
    WHERE id = v_due.id;
    v_remaining := v_remaining - v_take;
  END LOOP;

  UPDATE public.welile_homes_subscriptions
  SET outstanding_balance = GREATEST(0, outstanding_balance - v_cap),
      next_due_date = (SELECT min(payout_date) FROM public.welile_homes_monthly_dues
                       WHERE subscription_id = p_subscription_id AND collection_status <> 'collected'),
      updated_at = now()
  WHERE id = p_subscription_id;

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES ('payment_made', v_tenant_id, 'welile_homes_subscription', p_subscription_id,
      jsonb_build_object('action','collection','source',p_source,'amount',v_cap,'agent_commission',v_agent_comm,'txn',v_txn));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_group', v_txn,
    'amount_collected', v_cap,
    'agent_commission', v_agent_comm,
    'source', p_source
  );
END;
$function$;

-- =========================================================================
-- 5. welile_home_run_landlord_payouts  (idempotent, cron-driven)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.welile_home_run_landlord_payouts(
  p_as_of date DEFAULT current_date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_due record;
  v_uses_wallet boolean;
  v_landlord_id uuid;
  v_landlord_name text;
  v_landlord_phone text;
  v_agent_id uuid;
  v_tenant_id uuid;
  v_legs jsonb;
  v_txn uuid;
  v_key text;
  v_paid_count int := 0;
  v_paid_total numeric := 0;
BEGIN
  FOR v_due IN
    SELECT d.id, d.subscription_id, d.landlord_net, d.tenant_id,
           s.landlord_uses_wallet, s.landlord_id, s.landlord_name, s.landlord_phone, s.agent_id
    FROM public.welile_homes_monthly_dues d
    JOIN public.welile_homes_subscriptions s ON s.id = d.subscription_id
    WHERE d.collection_status = 'collected'
      AND d.payout_status = 'unpaid'
      AND d.payout_date <= p_as_of
      AND d.landlord_net > 0
    ORDER BY d.payout_date
  LOOP
    v_uses_wallet    := v_due.landlord_uses_wallet;
    v_landlord_id    := v_due.landlord_id;
    v_landlord_name  := v_due.landlord_name;
    v_landlord_phone := v_due.landlord_phone;
    v_agent_id       := v_due.agent_id;
    v_tenant_id      := v_due.tenant_id;

    v_key := format('welile_home_payout:%s:%s', v_due.id, gen_random_uuid()::text);

    IF v_uses_wallet AND v_landlord_id IS NOT NULL THEN
      v_legs := jsonb_build_array(
        jsonb_build_object('user_id',v_landlord_id,'amount',v_due.landlord_net,'direction','cash_out','category','rent_disbursement','ledger_scope','platform','classification','production','description','Welile Homes landlord payout','source_table','welile_homes_monthly_dues','source_id',v_due.id),
        jsonb_build_object('user_id',v_landlord_id,'amount',v_due.landlord_net,'direction','cash_in','category','landlord_rent_payment','ledger_scope','wallet','classification','production','description','Welile Homes rent received (90%)','recipient_type','user','source_table','welile_homes_monthly_dues','source_id',v_due.id)
      );
      v_txn := public.create_ledger_transaction(v_legs, v_key, true);

      UPDATE public.welile_homes_monthly_dues
      SET payout_status = 'paid_wallet', ledger_transaction_id = COALESCE(ledger_transaction_id, v_txn), updated_at = now()
      WHERE id = v_due.id;

    ELSIF v_agent_id IS NOT NULL THEN
      -- Credit the managing agent's landlord-float so they can withdraw and hand over
      v_legs := jsonb_build_array(
        jsonb_build_object('user_id',v_agent_id,'amount',v_due.landlord_net,'direction','cash_out','category','rent_disbursement','ledger_scope','platform','classification','production','description','Welile Homes landlord payout via agent float','source_table','welile_homes_monthly_dues','source_id',v_due.id),
        jsonb_build_object('user_id',v_agent_id,'amount',v_due.landlord_net,'direction','cash_in','category','agent_landlord_payout','ledger_scope','wallet','classification','production','description','Welile Homes landlord float (to hand to landlord)','recipient_type','operational_wallet','source_table','welile_homes_monthly_dues','source_id',v_due.id)
      );
      v_txn := public.create_ledger_transaction(v_legs, v_key, true);

      -- Track a per-landlord obligation the agent must settle
      INSERT INTO public.agent_landlord_float_allocations (
        agent_id, tenant_id, landlord_id, landlord_name, landlord_phone,
        allocated_amount, status, source, notes
      ) VALUES (
        v_agent_id, v_tenant_id, v_landlord_id, COALESCE(v_landlord_name, 'Welile Homes landlord'), v_landlord_phone,
        v_due.landlord_net, 'open', 'welile_homes_payout', 'Welile Homes monthly landlord payout'
      );

      UPDATE public.welile_homes_monthly_dues
      SET payout_status = 'paid_float', ledger_transaction_id = COALESCE(ledger_transaction_id, v_txn), updated_at = now()
      WHERE id = v_due.id;
    ELSE
      CONTINUE; -- no route available; leave unpaid
    END IF;

    v_paid_count := v_paid_count + 1;
    v_paid_total := v_paid_total + v_due.landlord_net;

    BEGIN
      INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
      VALUES ('rent_disbursed', COALESCE(v_landlord_id, v_agent_id), 'welile_homes_monthly_dues', v_due.id,
        jsonb_build_object('action','landlord_payout','amount',v_due.landlord_net,'via', CASE WHEN v_uses_wallet AND v_landlord_id IS NOT NULL THEN 'wallet' ELSE 'agent_float' END,'txn',v_txn));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'payouts', v_paid_count, 'total_paid', v_paid_total, 'as_of', p_as_of);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.enroll_welile_home_tenant(uuid,uuid,numeric,integer,boolean,boolean,uuid,text,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.welile_home_record_collection(uuid,numeric,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.welile_home_run_landlord_payouts(date) TO authenticated, service_role;
