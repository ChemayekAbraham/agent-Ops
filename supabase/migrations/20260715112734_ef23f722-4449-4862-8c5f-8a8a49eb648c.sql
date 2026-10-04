
-- =========================================================================
-- 1. Rule 3: whitelist of Welile payout source accounts
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.welile_payout_source_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  msisdn text NOT NULL UNIQUE,
  provider text NOT NULL,
  label text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  notes text
);

GRANT SELECT ON public.welile_payout_source_accounts TO authenticated;
GRANT ALL ON public.welile_payout_source_accounts TO service_role;

ALTER TABLE public.welile_payout_source_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cfo/manager can read payout sources"
  ON public.welile_payout_source_accounts FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'super_admin')
    OR public.has_role(auth.uid(),'cfo')
    OR public.has_role(auth.uid(),'operations')
  );

CREATE POLICY "cfo/manager can write payout sources"
  ON public.welile_payout_source_accounts FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'cfo'))
  WITH CHECK (public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'cfo'));

-- =========================================================================
-- 2. Rule 1: reconciled TIDs skip list
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.ledger_reconciled_tids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tid_normalized text NOT NULL,
  source text NOT NULL,
  source_id uuid,
  amount numeric,
  user_id uuid,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tid_normalized)
);

CREATE INDEX IF NOT EXISTS idx_ledger_reconciled_tids_source
  ON public.ledger_reconciled_tids (source, source_id);

GRANT SELECT ON public.ledger_reconciled_tids TO authenticated;
GRANT ALL ON public.ledger_reconciled_tids TO service_role;

ALTER TABLE public.ledger_reconciled_tids ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cfo/ops can read reconciled tids"
  ON public.ledger_reconciled_tids FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'super_admin')
    OR public.has_role(auth.uid(),'cfo')
    OR public.has_role(auth.uid(),'operations')
  );

CREATE POLICY "cfo/ops can insert reconciled tids"
  ON public.ledger_reconciled_tids FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'super_admin')
    OR public.has_role(auth.uid(),'cfo')
    OR public.has_role(auth.uid(),'operations')
  );

-- =========================================================================
-- 3. Rule 1 (cont.): float_delivery_tid columns
-- =========================================================================
ALTER TABLE public.agent_float_funding
  ADD COLUMN IF NOT EXISTS float_delivery_tid text;

ALTER TABLE public.float_requests
  ADD COLUMN IF NOT EXISTS float_delivery_tid text;

CREATE INDEX IF NOT EXISTS idx_agent_float_funding_delivery_tid
  ON public.agent_float_funding (float_delivery_tid);

CREATE INDEX IF NOT EXISTS idx_float_requests_delivery_tid
  ON public.float_requests (float_delivery_tid);

CREATE OR REPLACE FUNCTION public.register_float_delivery_tid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_norm text;
  v_amt  numeric;
BEGIN
  IF NEW.float_delivery_tid IS NULL OR btrim(NEW.float_delivery_tid) = '' THEN
    RETURN NEW;
  END IF;
  v_norm := regexp_replace(upper(NEW.float_delivery_tid),'[^A-Z0-9]','','g');
  IF v_norm = '' THEN RETURN NEW; END IF;

  v_amt := COALESCE(
    NULLIF((to_jsonb(NEW)->>'amount'),'')::numeric,
    NULLIF((to_jsonb(NEW)->>'requested_amount'),'')::numeric
  );

  INSERT INTO public.ledger_reconciled_tids (tid_normalized, source, source_id, amount, user_id, notes)
  VALUES (
    v_norm,
    TG_ARGV[0],
    NEW.id,
    v_amt,
    NEW.agent_id,
    'auto-registered from ' || TG_ARGV[0]
  )
  ON CONFLICT (tid_normalized) DO NOTHING;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_reg_tid_agent_float_funding ON public.agent_float_funding;
CREATE TRIGGER trg_reg_tid_agent_float_funding
  AFTER INSERT OR UPDATE OF float_delivery_tid ON public.agent_float_funding
  FOR EACH ROW EXECUTE FUNCTION public.register_float_delivery_tid('float_delivery');

DROP TRIGGER IF EXISTS trg_reg_tid_float_requests ON public.float_requests;
CREATE TRIGGER trg_reg_tid_float_requests
  AFTER INSERT OR UPDATE OF float_delivery_tid ON public.float_requests
  FOR EACH ROW EXECUTE FUNCTION public.register_float_delivery_tid('float_delivery');

-- =========================================================================
-- 4. Helper: is_merchant_agent(uuid)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.is_merchant_agent(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.cashout_agents
    WHERE agent_id = p_user_id AND is_active IS TRUE
  );
$fn$;

-- =========================================================================
-- 5. Rule 2 guardrail: block phantom auto-debit against merchant agents
-- =========================================================================
CREATE OR REPLACE FUNCTION public.enforce_no_merchant_agent_auto_debit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.classification IS DISTINCT FROM 'production' THEN RETURN NEW; END IF;
  IF NEW.ledger_scope    IS DISTINCT FROM 'wallet'     THEN RETURN NEW; END IF;
  IF NEW.direction       IS DISTINCT FROM 'cash_out'   THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;

  IF COALESCE(NEW.description,'') NOT LIKE '%Auto-debit (phone match)%'
     AND COALESCE(NEW.description,'') NOT LIKE '%Auto-debit (name match)%' THEN
    RETURN NEW;
  END IF;

  IF public.is_merchant_agent(NEW.user_id) THEN
    RAISE EXCEPTION
      'MERCHANT_AGENT_AUTO_DEBIT_BLOCKED: user % is a merchant agent — Gmail auto-debit against merchant float wallets is permanently disabled (Rule 2).',
      NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_block_merchant_agent_auto_debit ON public.general_ledger;
CREATE TRIGGER trg_block_merchant_agent_auto_debit
  BEFORE INSERT ON public.general_ledger
  FOR EACH ROW EXECUTE FUNCTION public.enforce_no_merchant_agent_auto_debit();

-- =========================================================================
-- 6. Reversal helpers
-- =========================================================================
CREATE OR REPLACE FUNCTION public.reverse_phantom_auto_debit_obligation(p_obligation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_ob        public.cfo_debit_obligations%ROWTYPE;
  v_wallet_id uuid;
  v_new_ref   text;
  v_entries   jsonb;
  v_group_id  uuid;
BEGIN
  SELECT * INTO v_ob FROM public.cfo_debit_obligations WHERE id = p_obligation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'error','obligation_not_found','id',p_obligation_id);
  END IF;
  IF v_ob.status <> 'open' THEN
    RETURN jsonb_build_object('ok',false,'error','not_open','id',p_obligation_id,'status',v_ob.status);
  END IF;

  SELECT wallet_id INTO v_wallet_id
  FROM public.general_ledger
  WHERE reference_id = v_ob.ledger_reference_id
    AND ledger_scope = 'wallet'
    AND direction    = 'cash_out'
    AND user_id      = v_ob.user_id
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_wallet_id IS NULL THEN
    SELECT id INTO v_wallet_id
    FROM public.wallets_physical
    WHERE user_id = v_ob.user_id
    LIMIT 1;
  END IF;

  IF v_wallet_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','wallet_not_found','user_id',v_ob.user_id);
  END IF;

  v_new_ref := 'REV-PHANTOM-' || substr(replace(p_obligation_id::text,'-',''),1,10);

  v_entries := jsonb_build_array(
    jsonb_build_object(
      'user_id',        v_ob.user_id,
      'wallet_id',      v_wallet_id,
      'amount',         v_ob.amount,
      'direction',      'cash_in',
      'category',       'system_balance_correction',
      'ledger_scope',   'wallet',
      'wallet_bucket',  'withdrawable',
      'recipient_type', 'user',
      'classification', 'admin_correction',
      'reference_id',   v_new_ref,
      'description',    'Phantom auto-debit reversal: ' || COALESCE(v_ob.reason,'(no reason)')
    ),
    jsonb_build_object(
      'user_id',        v_ob.user_id,
      'amount',         v_ob.amount,
      'direction',      'cash_out',
      'category',       'system_balance_correction',
      'ledger_scope',   'platform',
      'classification', 'admin_correction',
      'reference_id',   v_new_ref,
      'description',    'Platform → wallet: reversing phantom auto-debit obligation ' || p_obligation_id::text
    )
  );

  v_group_id := public.create_ledger_transaction(v_entries, 'rev-phantom-'||p_obligation_id::text, true);

  UPDATE public.cfo_debit_obligations
     SET status = 'voided_phantom',
         recovered_amount = amount,
         updated_at = now(),
         metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
           'voided_at', now(),
           'void_reason','phantom_auto_debit_gmail_engine',
           'reversal_reference', v_new_ref,
           'reversal_group_id', v_group_id
         )
   WHERE id = p_obligation_id;

  RETURN jsonb_build_object('ok',true,'obligation_id',p_obligation_id,'amount',v_ob.amount,'reversal_ref',v_new_ref);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.reverse_all_phantom_auto_debits()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  r record;
  v_ok int := 0;
  v_fail int := 0;
  v_sum numeric := 0;
  v_res jsonb;
BEGIN
  FOR r IN
    SELECT id, amount FROM public.cfo_debit_obligations
     WHERE status = 'open'
       AND reason ILIKE 'Auto-debit (phone match)%'
     ORDER BY created_at ASC
  LOOP
    BEGIN
      v_res := public.reverse_phantom_auto_debit_obligation(r.id);
      IF (v_res->>'ok')::boolean THEN
        v_ok := v_ok + 1;
        v_sum := v_sum + r.amount;
      ELSE
        v_fail := v_fail + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fail := v_fail + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('reversed_count',v_ok,'failed_count',v_fail,'reversed_total_ugx',v_sum);
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.reverse_phantom_auto_debit_obligation(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_all_phantom_auto_debits() TO service_role;
GRANT EXECUTE ON FUNCTION public.is_merchant_agent(uuid) TO authenticated, service_role;
