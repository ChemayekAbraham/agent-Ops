-- ============================================================================
-- Route landlord-float payouts into the merchant Cash/Mobile Money/Bank queue.
--
-- A landlord-float payout is funded from `agent_landlord_float` (a dedicated
-- CFO-funded float ledger), NOT from the agent's withdrawable wallet. When such
-- a payout is surfaced as a `withdrawal_requests` row so a merchant agent can
-- fulfil it "like any other withdrawal", the standard withdrawable-balance
-- guards must NOT apply (the agent has no withdrawable backing it) and the row
-- must NOT count as a pending hold against the agent's own withdrawable balance.
--
-- These rows are tagged by a reason that starts with 'Landlord float payout'.
-- ============================================================================

-- 0) Link a withdrawal_requests row back to its landlord_payouts record so the
--    merchant settlement can complete the payout cleanly.
ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS landlord_payout_id uuid;
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_landlord_payout_id
  ON public.withdrawal_requests (landlord_payout_id);

-- 1) Allow a dedicated landlord_payouts status so FinOps does NOT also pick it
--    up for disbursement (the merchant now fulfils it).
ALTER TABLE public.landlord_payouts
  DROP CONSTRAINT IF EXISTS landlord_payouts_status_check;
ALTER TABLE public.landlord_payouts
  ADD CONSTRAINT landlord_payouts_status_check
  CHECK (status = ANY (ARRAY[
    'otp_verified'::text,
    'pending_finops_disbursement'::text,
    'pending_merchant_payout'::text,
    'disbursing'::text,
    'awaiting_agent_receipt'::text,
    'completed'::text,
    'failed'::text,
    'escalated'::text
  ]));

-- 2) Minimum-balance guard: skip for landlord-float payout rows.
CREATE OR REPLACE FUNCTION public.enforce_minimum_withdrawal_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_managed_agent UUID;
  available_self NUMERIC := 0;
  available_proxy NUMERIC := 0;
  available NUMERIC := 0;
BEGIN
  -- Landlord-float payouts are funded from agent_landlord_float, not the
  -- agent's withdrawable wallet — the withdrawable minimum does not apply.
  IF NEW.reason IS NOT NULL AND NEW.reason LIKE 'Landlord float payout%' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'pending' THEN
    BEGIN
      available_self := COALESCE(public.get_user_available_balance(NEW.user_id), 0);
    EXCEPTION WHEN OTHERS THEN
      SELECT COALESCE(withdrawable_balance, 0) INTO available_self
      FROM public.wallets WHERE user_id = NEW.user_id;
      available_self := COALESCE(available_self, 0);
    END;

    SELECT paa.agent_id INTO v_managed_agent
    FROM public.proxy_agent_assignments paa
    WHERE paa.beneficiary_id = NEW.user_id
      AND paa.is_active = true
      AND paa.approval_status = 'approved'
      AND paa.is_managed_account = true
    ORDER BY paa.created_at DESC
    LIMIT 1;

    IF v_managed_agent IS NOT NULL THEN
      BEGIN
        available_proxy := COALESCE(public.get_user_available_balance(v_managed_agent), 0);
      EXCEPTION WHEN OTHERS THEN
        SELECT COALESCE(withdrawable_balance, 0) INTO available_proxy
        FROM public.wallets WHERE user_id = v_managed_agent;
        available_proxy := COALESCE(available_proxy, 0);
      END;
    END IF;

    available := GREATEST(available_self, available_proxy);

    IF available < 5000 THEN
      RAISE EXCEPTION
        'Withdrawal blocked: Your withdrawable balance must be at least UGX 5,000 to submit a withdrawal request. Available: %',
        available;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- 3) Ledger-match guard: skip the withdrawable-balance match for landlord-float
--    payout rows (still rejects invalid amounts).
CREATE OR REPLACE FUNCTION public.enforce_withdrawal_ledger_match()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_available numeric;
  v_check_user_id uuid;
  v_proxy_partner_id uuid;
  v_managed_agent_id uuid;
BEGIN
  IF NEW.amount IS NULL OR NEW.amount <= 0 THEN
    INSERT INTO public.withdrawal_attempt_failures (
      user_id, attempted_amount, ledger_available, reason, client_request_id
    ) VALUES (
      NEW.user_id, COALESCE(NEW.amount, 0), 0,
      'INVALID_AMOUNT', NEW.client_request_id
    );
    RAISE EXCEPTION 'Invalid withdrawal amount'
      USING ERRCODE = '22023';
  END IF;

  -- Landlord-float payouts are funded from agent_landlord_float (deducted at
  -- disburse time), not the agent's withdrawable wallet — skip the ledger match.
  IF NEW.reason IS NOT NULL AND NEW.reason LIKE 'Landlord float payout%' THEN
    RETURN NEW;
  END IF;

  v_proxy_partner_id := COALESCE(
    NEW.proxy_partner_id,
    NEW.beneficiary_id,
    CASE
      WHEN NEW.linked_party IS NOT NULL AND NEW.linked_party <> NEW.user_id THEN NEW.linked_party
      ELSE NULL
    END
  );

  IF v_proxy_partner_id IS NOT NULL THEN
    SELECT paa.agent_id
    INTO v_managed_agent_id
    FROM public.proxy_agent_assignments paa
    WHERE paa.beneficiary_id = v_proxy_partner_id
      AND paa.is_active = true
      AND paa.approval_status = 'approved'
      AND paa.is_managed_account = true
      AND (
        paa.agent_id = NEW.agent_id
        OR paa.agent_id = NEW.initiated_by
        OR (NEW.user_id <> v_proxy_partner_id AND paa.agent_id = NEW.user_id)
      )
    ORDER BY paa.created_at DESC
    LIMIT 1;
  END IF;

  v_check_user_id := COALESCE(v_managed_agent_id, NEW.user_id);

  SELECT public.get_user_available_balance(v_check_user_id) INTO v_available;
  v_available := COALESCE(v_available, 0);

  IF NEW.amount > v_available THEN
    INSERT INTO public.withdrawal_attempt_failures (
      user_id, attempted_amount, ledger_available, reason, client_request_id,
      metadata
    ) VALUES (
      NEW.user_id, NEW.amount, v_available,
      'LEDGER_MISMATCH', NEW.client_request_id,
      jsonb_build_object(
        'mobile_money_provider', NEW.mobile_money_provider,
        'mobile_money_number', NEW.mobile_money_number,
        'checked_user_id', v_check_user_id,
        'proxy_partner_id', v_proxy_partner_id,
        'managed_proxy_agent_id', v_managed_agent_id,
        'funding_wallet', CASE WHEN v_managed_agent_id IS NOT NULL THEN 'proxy_agent' ELSE 'request_owner' END
      )
    );
    RAISE EXCEPTION
      'Ledger mismatch detected. Available: %, requested: %. Transaction aborted.',
      v_available, NEW.amount
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;

-- 4) Wallet view: exclude landlord-float payout rows from the agent's pending
--    holds so they never lock the agent's own withdrawable balance.
CREATE OR REPLACE VIEW public.v_user_wallet_strict AS
 WITH anchors AS (
         SELECT wallet_fresh_start_anchors.user_id,
            wallet_fresh_start_anchors.anchor_at
           FROM wallet_fresh_start_anchors
        ), ledger AS (
         SELECT gl.user_id,
            gl.category,
            gl.direction,
            gl.amount,
            gl.wallet_bucket
           FROM general_ledger gl
             LEFT JOIN anchors a ON a.user_id = gl.user_id
          WHERE gl.ledger_scope = 'wallet'::text AND (gl.classification IS NULL OR gl.classification = 'production'::text OR gl.classification = 'admin_correction'::text AND gl.category = 'system_balance_correction'::text AND (gl.direction = ANY (ARRAY['debit'::text, 'cash_out'::text]))) AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
        ), routed_explicit AS (
         SELECT ledger.user_id,
            ledger.amount,
            ledger.wallet_bucket AS bucket,
                CASE
                    WHEN ledger.direction = ANY (ARRAY['cash_in'::text, 'credit'::text]) THEN 1
                    WHEN ledger.direction = ANY (ARRAY['cash_out'::text, 'debit'::text]) THEN '-1'::integer
                    ELSE 0
                END AS sign
           FROM ledger
          WHERE ledger.wallet_bucket = ANY (ARRAY['withdrawable'::text, 'float'::text, 'advance_credit'::text, 'advance_repayment'::text])
        ), routed_category AS (
         SELECT l.user_id,
            l.amount,
            r.bucket,
            r.sign
           FROM ledger l
             CROSS JOIN LATERAL wallet_route_for_category(l.user_id, l.category, l.direction) r(bucket, sign)
          WHERE l.wallet_bucket IS NULL
        ), routed AS (
         SELECT routed_explicit.user_id,
            routed_explicit.amount,
            routed_explicit.bucket,
            routed_explicit.sign
           FROM routed_explicit
        UNION ALL
         SELECT routed_category.user_id,
            routed_category.amount,
            routed_category.bucket,
            routed_category.sign
           FROM routed_category
        ), buckets AS (
         SELECT routed.user_id,
            sum(
                CASE
                    WHEN routed.bucket = 'withdrawable'::text THEN routed.sign::numeric * routed.amount
                    ELSE 0::numeric
                END) AS withdrawable_raw,
            sum(
                CASE
                    WHEN routed.bucket = 'float'::text THEN routed.sign::numeric * routed.amount
                    ELSE 0::numeric
                END) AS float_raw,
            sum(
                CASE
                    WHEN routed.bucket = ANY (ARRAY['advance_credit'::text, 'advance_repayment'::text]) THEN routed.sign::numeric * routed.amount
                    ELSE 0::numeric
                END) AS advance_raw
           FROM routed
          GROUP BY routed.user_id
        ), holds AS (
         SELECT
                CASE
                    WHEN withdrawal_requests.proxy_partner_id IS NOT NULL AND withdrawal_requests.agent_id IS NOT NULL THEN withdrawal_requests.agent_id
                    ELSE withdrawal_requests.user_id
                END AS user_id,
            COALESCE(sum(withdrawal_requests.amount), 0::numeric) AS pending_holds
           FROM withdrawal_requests
          WHERE withdrawal_requests.status = ANY (ARRAY['pending'::text, 'requested'::text, 'manager_approved'::text, 'processing'::text])
            AND (withdrawal_requests.reason IS NULL OR withdrawal_requests.reason NOT LIKE 'Landlord float payout%')
          GROUP BY (
                CASE
                    WHEN withdrawal_requests.proxy_partner_id IS NOT NULL AND withdrawal_requests.agent_id IS NOT NULL THEN withdrawal_requests.agent_id
                    ELSE withdrawal_requests.user_id
                END)
        ), universe AS (
         SELECT wallets_physical.user_id
           FROM wallets_physical
        UNION
         SELECT buckets.user_id
           FROM buckets
        UNION
         SELECT holds.user_id
           FROM holds
        )
 SELECT u.user_id,
    GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0::numeric) - COALESCE(h.pending_holds, 0::numeric)) AS withdrawable,
    GREATEST(0::numeric, COALESCE(b.float_raw, 0::numeric)) AS float_balance,
    GREATEST(0::numeric, COALESCE(b.advance_raw, 0::numeric)) AS advance_balance,
    COALESCE(h.pending_holds, 0::numeric) AS pending_holds,
    GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0::numeric) - COALESCE(h.pending_holds, 0::numeric)) + GREATEST(0::numeric, COALESCE(b.float_raw, 0::numeric)) AS total_visible
   FROM universe u
     LEFT JOIN buckets b ON b.user_id = u.user_id
     LEFT JOIN holds h ON h.user_id = u.user_id;