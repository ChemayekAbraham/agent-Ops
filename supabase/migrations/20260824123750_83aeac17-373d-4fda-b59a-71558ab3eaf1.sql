-- 1. Extend merchant_agent_referrals for multi-beneficiary tiers
ALTER TABLE public.merchant_agent_referrals
  ADD COLUMN IF NOT EXISTS beneficiary_id uuid,
  ADD COLUMN IF NOT EXISTS tier text;

-- Backfill historical rows (single direct beneficiary each)
UPDATE public.merchant_agent_referrals
  SET beneficiary_id = COALESCE(beneficiary_id, referrer_id),
      tier = COALESCE(tier, 'direct');

ALTER TABLE public.merchant_agent_referrals
  ALTER COLUMN beneficiary_id SET NOT NULL,
  ALTER COLUMN tier SET DEFAULT 'direct',
  ALTER COLUMN tier SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.merchant_agent_referrals'::regclass
      AND conname = 'merchant_agent_referrals_tier_check'
  ) THEN
    ALTER TABLE public.merchant_agent_referrals
      ADD CONSTRAINT merchant_agent_referrals_tier_check CHECK (tier IN ('direct','upline'));
  END IF;
END $$;

-- Drop the single-beneficiary uniqueness (constraint or index form)
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.merchant_agent_referrals'::regclass
      AND contype = 'u'
      AND (SELECT array_agg(a.attname ORDER BY a.attname)
           FROM unnest(conkey) k JOIN pg_attribute a
             ON a.attrelid = conrelid AND a.attnum = k) = ARRAY['invitee_id']::name[]
  LOOP
    EXECUTE format('ALTER TABLE public.merchant_agent_referrals DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT indexrelid::regclass::text AS idx
    FROM pg_index
    WHERE indrelid = 'public.merchant_agent_referrals'::regclass
      AND indisunique
      AND NOT indisprimary
      AND array_length(indkey::int2[], 1) = 1
      AND (SELECT attname FROM pg_attribute
           WHERE attrelid = indrelid AND attnum = indkey[0]) = 'invitee_id'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %s', r.idx);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS merchant_agent_referrals_invitee_beneficiary_key
  ON public.merchant_agent_referrals (invitee_id, beneficiary_id);

-- 2. Shared payout engine: two-generation split of a UGX 10,000 pool
CREATE OR REPLACE FUNCTION public.pay_merchant_agent_referral_generations(
  p_invitee_id uuid,
  p_cashout_agent_id uuid DEFAULT NULL,
  p_proof_ref text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pool numeric := 10000;
  v_parent uuid;
  v_grandparent uuid;
  v_beneficiaries jsonb := '[]'::jsonb;
  v_b jsonb;
  v_bid uuid;
  v_amount numeric;
  v_tier text;
  v_row_id uuid;
  v_txn uuid;
  v_paid jsonb := '[]'::jsonb;
BEGIN
  IF p_invitee_id IS NULL THEN RETURN jsonb_build_object('paid', v_paid); END IF;

  SELECT merchant_agent_referrer_id INTO v_parent
  FROM public.profiles WHERE id = p_invitee_id;

  IF v_parent IS NULL OR v_parent = p_invitee_id THEN
    RETURN jsonb_build_object('paid', v_paid, 'reason', 'no_referrer');
  END IF;

  SELECT merchant_agent_referrer_id INTO v_grandparent
  FROM public.profiles WHERE id = v_parent;

  IF v_grandparent = v_parent OR v_grandparent = p_invitee_id THEN
    v_grandparent := NULL;
  END IF;

  IF v_grandparent IS NOT NULL THEN
    v_beneficiaries := jsonb_build_array(
      jsonb_build_object('id', v_grandparent, 'amount', 6000, 'tier', 'upline'),
      jsonb_build_object('id', v_parent, 'amount', 4000, 'tier', 'direct')
    );
  ELSE
    v_beneficiaries := jsonb_build_array(
      jsonb_build_object('id', v_parent, 'amount', v_pool, 'tier', 'direct')
    );
  END IF;

  FOR v_b IN SELECT * FROM jsonb_array_elements(v_beneficiaries)
  LOOP
    v_bid := (v_b->>'id')::uuid;
    v_amount := (v_b->>'amount')::numeric;
    v_tier := v_b->>'tier';

    -- Idempotency per (invitee, beneficiary)
    IF EXISTS (
      SELECT 1 FROM public.merchant_agent_referrals
      WHERE invitee_id = p_invitee_id AND beneficiary_id = v_bid AND status = 'paid'
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.merchant_agent_referrals
      (referrer_id, invitee_id, beneficiary_id, tier, cashout_agent_id, status, bonus_amount)
    VALUES (v_parent, p_invitee_id, v_bid, v_tier, p_cashout_agent_id, 'approved', v_amount)
    ON CONFLICT (invitee_id, beneficiary_id) DO UPDATE
      SET status = CASE WHEN merchant_agent_referrals.status = 'paid'
                        THEN merchant_agent_referrals.status ELSE 'approved' END,
          tier = EXCLUDED.tier,
          bonus_amount = CASE WHEN merchant_agent_referrals.status = 'paid'
                        THEN merchant_agent_referrals.bonus_amount ELSE EXCLUDED.bonus_amount END,
          cashout_agent_id = COALESCE(EXCLUDED.cashout_agent_id, merchant_agent_referrals.cashout_agent_id),
          updated_at = now()
    RETURNING id INTO v_row_id;

    v_txn := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_bid,
          'amount', v_amount,
          'direction', 'cash_in',
          'category', 'referral_bonus',
          'ledger_scope', 'wallet',
          'recipient_type', 'user',
          'description', 'Merchant Agent Referral Bonus (' || v_tier || ')'
        ),
        jsonb_build_object(
          'user_id', v_bid,
          'amount', v_amount,
          'direction', 'cash_out',
          'category', 'marketing_expense',
          'ledger_scope', 'platform',
          'description', 'Merchant Agent Referral Bonus payout (' || v_tier || ')'
        )
      ),
      'merchant_agent_referral:' || p_invitee_id::text || ':' || v_bid::text
    );

    UPDATE public.merchant_agent_referrals
      SET status = 'paid', paid_at = now(), ledger_txn_id = v_txn, updated_at = now()
      WHERE id = v_row_id;

    BEGIN
      INSERT INTO public.notifications (user_id, type, title, message, data)
      VALUES (
        v_bid,
        'merchant_agent_referral_paid',
        'Referral bonus credited',
        CASE WHEN v_tier = 'upline'
          THEN 'A Merchant Agent recruited by your own recruit has processed their first payout. UGX '
               || to_char(v_amount, 'FM999,999,999') || ' has been credited to your wallet.'
          ELSE 'Your invited Merchant Agent has processed their first payout with proof. UGX '
               || to_char(v_amount, 'FM999,999,999') || ' has been credited to your wallet.'
        END,
        jsonb_build_object('invitee_id', p_invitee_id, 'amount', v_amount, 'tier', v_tier,
                           'ledger_txn_id', v_txn, 'proof_ref', p_proof_ref)
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    v_paid := v_paid || jsonb_build_object('beneficiary_id', v_bid, 'amount', v_amount,
                                          'tier', v_tier, 'ledger_txn_id', v_txn);
  END LOOP;

  RETURN jsonb_build_object('paid', v_paid);
END $function$;

-- 3. Activation trigger: no longer pays; records eligibility pending first proven payout
CREATE OR REPLACE FUNCTION public.pay_merchant_agent_referral_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_parent uuid;
  v_grandparent uuid;
BEGIN
  IF NEW.is_active IS NOT TRUE THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_active = true THEN RETURN NEW; END IF;

  -- Clear the pending flag on the newly-active merchant agent
  UPDATE public.profiles SET pending_merchant_agent = false WHERE id = NEW.agent_id;

  SELECT merchant_agent_referrer_id INTO v_parent
  FROM public.profiles WHERE id = NEW.agent_id;
  IF v_parent IS NULL OR v_parent = NEW.agent_id THEN RETURN NEW; END IF;

  SELECT merchant_agent_referrer_id INTO v_grandparent
  FROM public.profiles WHERE id = v_parent;
  IF v_grandparent = v_parent OR v_grandparent = NEW.agent_id THEN v_grandparent := NULL; END IF;

  -- Record pending-proof entitlements (no money moves until first proven payout)
  INSERT INTO public.merchant_agent_referrals
    (referrer_id, invitee_id, beneficiary_id, tier, cashout_agent_id, status, bonus_amount)
  VALUES (v_parent, NEW.agent_id, v_parent, 'direct', NEW.id, 'approved',
          CASE WHEN v_grandparent IS NULL THEN 10000 ELSE 4000 END)
  ON CONFLICT (invitee_id, beneficiary_id) DO UPDATE
    SET cashout_agent_id = COALESCE(EXCLUDED.cashout_agent_id, merchant_agent_referrals.cashout_agent_id),
        bonus_amount = CASE WHEN merchant_agent_referrals.status = 'paid'
                            THEN merchant_agent_referrals.bonus_amount ELSE EXCLUDED.bonus_amount END,
        updated_at = now();

  IF v_grandparent IS NOT NULL THEN
    INSERT INTO public.merchant_agent_referrals
      (referrer_id, invitee_id, beneficiary_id, tier, cashout_agent_id, status, bonus_amount)
    VALUES (v_parent, NEW.agent_id, v_grandparent, 'upline', NEW.id, 'approved', 6000)
    ON CONFLICT (invitee_id, beneficiary_id) DO UPDATE
      SET cashout_agent_id = COALESCE(EXCLUDED.cashout_agent_id, merchant_agent_referrals.cashout_agent_id),
          bonus_amount = CASE WHEN merchant_agent_referrals.status = 'paid'
                              THEN merchant_agent_referrals.bonus_amount ELSE EXCLUDED.bonus_amount END,
          updated_at = now();
  END IF;

  RETURN NEW;
END $function$;

-- 4. Release trigger: first completed payout WITH proof processed by the merchant agent
CREATE OR REPLACE FUNCTION public.release_merchant_agent_referral_on_first_payout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid;
  v_ca_id uuid;
  v_has_proof boolean;
BEGIN
  IF NEW.status IS DISTINCT FROM 'completed' THEN RETURN NEW; END IF;

  v_agent := COALESCE(NEW.assigned_cashout_agent_id, NEW.processed_by, NEW.dispatch_claimed_by);
  IF v_agent IS NULL THEN RETURN NEW; END IF;

  v_has_proof := (NEW.payout_proof_path IS NOT NULL AND NEW.payout_proof_path <> '')
                 OR (NEW.payout_proof IS NOT NULL AND NEW.payout_proof <> '')
                 OR EXISTS (SELECT 1 FROM public.withdrawal_payment_evidence e
                            WHERE e.withdrawal_id = NEW.id);
  IF NOT v_has_proof THEN RETURN NEW; END IF;

  SELECT id INTO v_ca_id FROM public.cashout_agents
  WHERE agent_id = v_agent AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_ca_id IS NULL THEN RETURN NEW; END IF;

  PERFORM public.pay_merchant_agent_referral_generations(v_agent, v_ca_id, NEW.id::text);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_release_merchant_agent_referral ON public.withdrawal_requests;
CREATE TRIGGER trg_release_merchant_agent_referral
AFTER INSERT OR UPDATE OF status, payout_proof_path, payout_proof ON public.withdrawal_requests
FOR EACH ROW EXECUTE FUNCTION public.release_merchant_agent_referral_on_first_payout();