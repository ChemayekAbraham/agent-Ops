
-- 1. Profile columns for the pending merchant-agent lock-in
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS pending_merchant_agent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS merchant_agent_referrer_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_pending_merchant_agent
  ON public.profiles (pending_merchant_agent) WHERE pending_merchant_agent = true;
CREATE INDEX IF NOT EXISTS idx_profiles_merchant_agent_referrer
  ON public.profiles (merchant_agent_referrer_id) WHERE merchant_agent_referrer_id IS NOT NULL;

-- 2. Tracking table
CREATE TABLE IF NOT EXISTS public.merchant_agent_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  invitee_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  cashout_agent_id uuid REFERENCES public.cashout_agents(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','rejected')),
  bonus_amount numeric NOT NULL DEFAULT 50000,
  ledger_txn_id uuid,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchant_agent_referrals_no_self CHECK (referrer_id <> invitee_id),
  CONSTRAINT merchant_agent_referrals_invitee_unique UNIQUE (invitee_id)
);

CREATE INDEX IF NOT EXISTS idx_merchant_agent_referrals_referrer
  ON public.merchant_agent_referrals (referrer_id, created_at DESC);

GRANT SELECT ON public.merchant_agent_referrals TO authenticated;
GRANT ALL ON public.merchant_agent_referrals TO service_role;
ALTER TABLE public.merchant_agent_referrals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Referrer and invitee can view own merchant referral"
  ON public.merchant_agent_referrals FOR SELECT
  TO authenticated
  USING (
    auth.uid() = referrer_id
    OR auth.uid() = invitee_id
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

CREATE POLICY "Staff manage merchant referrals"
  ON public.merchant_agent_referrals FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'manager'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'manager'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role));

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.tg_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_touch_merchant_agent_referrals ON public.merchant_agent_referrals;
CREATE TRIGGER trg_touch_merchant_agent_referrals
  BEFORE UPDATE ON public.merchant_agent_referrals
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- 3. Extend handle_new_user to capture merchant-agent referrer metadata
--    (patches existing function preamble; keeps all other behavior intact by
--    adding a small post-INSERT UPDATE after the main body runs — implemented
--    as a SEPARATE AFTER trigger to avoid rewriting the large existing function)
CREATE OR REPLACE FUNCTION public.apply_merchant_agent_referral_metadata()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_meta jsonb;
  v_mref_raw text;
  v_mref uuid;
  v_referrer_ok boolean := false;
BEGIN
  SELECT raw_user_meta_data INTO v_meta FROM auth.users WHERE id = NEW.id;
  IF v_meta IS NULL THEN RETURN NEW; END IF;

  v_mref_raw := NULLIF(v_meta->>'merchant_agent_ref', '');
  IF v_mref_raw IS NULL THEN RETURN NEW; END IF;

  BEGIN v_mref := v_mref_raw::uuid; EXCEPTION WHEN OTHERS THEN RETURN NEW; END;
  IF v_mref = NEW.id THEN RETURN NEW; END IF;

  -- Referrer must be an ACTIVE merchant agent
  SELECT EXISTS (
    SELECT 1 FROM public.cashout_agents
    WHERE agent_id = v_mref AND is_active = true
  ) INTO v_referrer_ok;

  IF NOT v_referrer_ok THEN RETURN NEW; END IF;

  UPDATE public.profiles
    SET pending_merchant_agent = true,
        merchant_agent_referrer_id = v_mref
    WHERE id = NEW.id;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_apply_merchant_agent_referral_metadata ON public.profiles;
CREATE TRIGGER trg_apply_merchant_agent_referral_metadata
  AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.apply_merchant_agent_referral_metadata();

-- 4. Pay UGX 50,000 when the invited merchant agent becomes active
CREATE OR REPLACE FUNCTION public.pay_merchant_agent_referral_bonus()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_referrer uuid;
  v_bonus numeric := 50000;
  v_existing uuid;
  v_ref_row_id uuid;
  v_txn uuid;
  v_entries jsonb;
BEGIN
  IF NEW.is_active IS NOT TRUE THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_active = true THEN RETURN NEW; END IF;

  SELECT merchant_agent_referrer_id INTO v_referrer
  FROM public.profiles WHERE id = NEW.agent_id;
  IF v_referrer IS NULL OR v_referrer = NEW.agent_id THEN RETURN NEW; END IF;

  -- Idempotency: already paid?
  SELECT id INTO v_existing
  FROM public.merchant_agent_referrals
  WHERE invitee_id = NEW.agent_id AND status = 'paid';
  IF v_existing IS NOT NULL THEN RETURN NEW; END IF;

  -- Upsert referral row
  INSERT INTO public.merchant_agent_referrals (referrer_id, invitee_id, cashout_agent_id, status, bonus_amount)
  VALUES (v_referrer, NEW.agent_id, NEW.id, 'approved', v_bonus)
  ON CONFLICT (invitee_id) DO UPDATE
    SET status = CASE WHEN merchant_agent_referrals.status = 'paid'
                       THEN merchant_agent_referrals.status
                       ELSE 'approved' END,
        cashout_agent_id = EXCLUDED.cashout_agent_id
  RETURNING id INTO v_ref_row_id;

  -- Post double-entry ledger
  v_entries := jsonb_build_array(
    jsonb_build_object(
      'user_id', v_referrer,
      'amount', v_bonus,
      'direction', 'cash_in',
      'category', 'referral_bonus',
      'ledger_scope', 'wallet',
      'recipient_type', 'user',
      'description', 'Merchant Agent Referral Bonus'
    ),
    jsonb_build_object(
      'user_id', v_referrer,
      'amount', v_bonus,
      'direction', 'cash_out',
      'category', 'marketing_expense',
      'ledger_scope', 'platform',
      'description', 'Merchant Agent Referral Bonus payout'
    )
  );

  v_txn := public.create_ledger_transaction(
    v_entries,
    'merchant_agent_referral:' || NEW.agent_id::text
  );

  UPDATE public.merchant_agent_referrals
    SET status = 'paid', paid_at = now(), ledger_txn_id = v_txn
    WHERE id = v_ref_row_id;

  -- Clear the pending flag on the newly-active merchant agent
  UPDATE public.profiles
    SET pending_merchant_agent = false
    WHERE id = NEW.agent_id;

  -- In-app notification (best-effort)
  BEGIN
    INSERT INTO public.notifications (user_id, type, title, message, data)
    VALUES (
      v_referrer,
      'merchant_agent_referral_paid',
      'Referral bonus credited',
      'Your invited Merchant Agent has been approved. UGX 50,000 has been credited to your wallet.',
      jsonb_build_object('invitee_id', NEW.agent_id, 'amount', v_bonus, 'ledger_txn_id', v_txn)
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pay_merchant_agent_referral_bonus ON public.cashout_agents;
CREATE TRIGGER trg_pay_merchant_agent_referral_bonus
  AFTER INSERT OR UPDATE OF is_active ON public.cashout_agents
  FOR EACH ROW EXECUTE FUNCTION public.pay_merchant_agent_referral_bonus();
