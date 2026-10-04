CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    'access_fee_collected','registration_fee_collected',
    'wallet_deposit','tenant_repayment','agent_repayment','partner_funding','share_capital',
    'rent_disbursement','rent_receivable_created','rent_principal_collected',
    'rent_payment_for_tenant','rent_payment_received',
    'roi_expense','roi_wallet_credit','roi_reinvestment',
    'agent_commission_earned','agent_commission_withdrawal','agent_commission_used_for_rent',
    'agent_commission_payable',
    'wallet_withdrawal','wallet_transfer','wallet_deduction',
    'system_balance_correction','orphan_reassignment','orphan_reversal',
    'agent_float_deposit','agent_float_used_for_rent','agent_float_assignment','agent_float_settlement',
    'agent_float_topup','agent_float_funding','agent_float_used','rent_float_funding',
    'agent_advance_credit','agent_advance_repayment','salary_advance','salary_advance_repayment',
    'pending_portfolio_topup',
    'marketing_expense','payroll_expense','general_admin_expense','research_development_expense',
    'tax_expense','interest_expense','equipment_expense',
    'partner_commission','debt_recovery',
    'historical_balance_reseed','platform_loss_writeoff',
    'wallet_deduction_general_adjustment','wallet_deduction_cash_payout_retraction',
    'angel_pool_investment','pool_capital_received','wallet_to_investment',
    'deposit','cfo_direct_credit','agent_commission','agent_bonus','referral_bonus',
    'proxy_investment_commission','agent_investment_commission','salary_payout',
    'roi_payout','manager_credit','supporter_capital','supporter_rent_fund',
    'landlord_rent_payment','rent_repayment','credit_access_repayment',
    'balance_correction','reconciliation','correction_reversal','account_merge',
    'rent_obligation_reversal','rent_obligation_reversal_adjustment',
    'pool_rent_deployment_reversal','coo_proxy_investment_reversal',
    'debt_clearance','rent_obligation','tenant_default_charge','advance_repayment',
    'manager_debit','agent_proxy_investment','coo_proxy_investment',
    'proxy_partner_withdrawal','test_funds_cleanup','platform_expense',
    'agent_landlord_payout','🔧 Manual Adjustment',
    'listing_bonus','listing_bonus_expense',
    'listing_rejection_penalty','listing_rejection_recovery',
    'listing_rejection_offset',
    'merchant_float_correction_writedown'
  ];
$function$;

CREATE OR REPLACE FUNCTION public.wallet_route_for_category(p_category text, p_direction text)
 RETURNS TABLE(bucket text, sign integer)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sign int;
BEGIN
  IF p_direction IN ('credit','cash_in') THEN
    v_sign := 1;
  ELSIF p_direction IN ('debit','cash_out') THEN
    v_sign := -1;
  ELSE
    RAISE EXCEPTION 'UNSUPPORTED_LEDGER_DIRECTION: %', p_direction;
  END IF;

  IF NOT public.validate_ledger_category(p_category) THEN
    RAISE EXCEPTION 'UNSUPPORTED_LEDGER_CATEGORY: % (direction=%)', p_category, p_direction;
  END IF;

  IF p_category IN (
    'agent_float_deposit','agent_float_assignment','agent_float_topup',
    'agent_float_funding','agent_float_used_for_rent','agent_float_used',
    'agent_float_settlement','merchant_float_correction_writedown','agent_landlord_payout','rent_disbursement','rent_float_funding'
  ) THEN
    RETURN QUERY SELECT 'float'::text, v_sign;
    RETURN;
  END IF;

  IF p_category IN ('agent_advance_credit','salary_advance') AND v_sign = 1 THEN
    RETURN QUERY SELECT 'advance_credit'::text, 1;
    RETURN;
  END IF;

  IF p_category IN ('agent_advance_repayment','salary_advance_repayment','debt_recovery') AND v_sign = -1 THEN
    RETURN QUERY SELECT 'advance_repayment'::text, -1;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'withdrawable'::text, v_sign;
END;
$function$;

CREATE OR REPLACE FUNCTION public.assert_routing_compatible(p_category text, p_recipient_type text)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Money OWNED by an individual — must never land in an operational/float wallet.
  IF p_recipient_type = 'operational_wallet' AND p_category IN (
    'payroll_expense','salary_payout',
    'roi_wallet_credit','roi_payout',
    'agent_commission_earned','agent_commission','agent_bonus',
    'partner_commission','referral_bonus',
    'proxy_investment_commission','agent_investment_commission',
    'system_balance_correction','wallet_transfer','manager_credit',
    'marketing_expense','general_admin_expense','research_development_expense',
    'tax_expense','interest_expense','equipment_expense',
    -- Advance recovery is debt repayment from a user's withdrawable bucket.
    -- It must NEVER come out of float (company custody money).
    'agent_repayment','agent_advance_repayment','salary_advance_repayment','debt_recovery'
  ) THEN
    RAISE EXCEPTION 'INVALID_ROUTING: category % cannot target an operational wallet (must go to a user)', p_category
      USING ERRCODE = 'check_violation';
  END IF;

  -- Operational/company funds — must never land in a user's withdrawable bucket.
  IF p_recipient_type = 'user' AND p_category IN (
    'agent_float_deposit','agent_float_assignment','agent_float_topup',
    'agent_float_funding','rent_float_funding','rent_disbursement',
    'merchant_float_correction_writedown'
  ) THEN
    RAISE EXCEPTION 'INVALID_ROUTING: category % cannot target a user wallet (must go to an operational wallet)', p_category
      USING ERRCODE = 'check_violation';
  END IF;
END;
$function$;

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
            gl.wallet_bucket,
            gl.maturity_met,
            gl.maturity_expired,
            gl.withdrawable_after
           FROM general_ledger gl
             LEFT JOIN anchors a ON a.user_id = gl.user_id
          WHERE gl.ledger_scope = 'wallet'::text AND (gl.classification IS NULL OR gl.classification = 'production'::text OR gl.classification = 'admin_correction'::text AND gl.category = 'system_balance_correction'::text AND (gl.direction = ANY (ARRAY['debit'::text, 'cash_out'::text])) OR gl.classification = 'admin_correction'::text AND gl.category = 'merchant_float_correction_writedown'::text AND (gl.direction = ANY (ARRAY['debit'::text, 'cash_out'::text]))) AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at) AND NOT (gl.source_table = 'commission_engine'::text AND (EXISTS ( SELECT 1
                   FROM commission_accrual_ledger cal
                  WHERE cal.agent_id = gl.user_id AND cal.event_type = 'rent_funded_landlord_float'::text AND cal.status = 'reversed'::text AND cal.source_id = gl.source_id::text))) AND NOT (gl.source_table = 'commission_engine_reversal'::text AND gl.classification = 'admin_correction'::text AND gl.category = 'system_balance_correction'::text AND gl.amount = 10000::numeric AND (EXISTS ( SELECT 1
                   FROM commission_accrual_ledger cal
                  WHERE cal.agent_id = gl.user_id AND cal.event_type = 'rent_funded_landlord_float'::text AND cal.status = 'reversed'::text)))
        ), routed_explicit AS (
         SELECT ledger.user_id,
            ledger.amount,
            ledger.wallet_bucket AS bucket,
                CASE
                    WHEN ledger.direction = ANY (ARRAY['cash_in'::text, 'credit'::text]) THEN 1
                    WHEN ledger.direction = ANY (ARRAY['cash_out'::text, 'debit'::text]) THEN '-1'::integer
                    ELSE 0
                END AS sign,
            ledger.maturity_met,
            ledger.maturity_expired,
            ledger.withdrawable_after,
            ledger.direction,
            ledger.category
           FROM ledger
          WHERE ledger.wallet_bucket = ANY (ARRAY['withdrawable'::text, 'float'::text, 'advance_credit'::text, 'advance_repayment'::text])
        ), routed_category AS (
         SELECT l.user_id,
            l.amount,
            r.bucket,
            r.sign,
            l.maturity_met,
            l.maturity_expired,
            l.withdrawable_after,
            l.direction,
            l.category
           FROM ledger l
             CROSS JOIN LATERAL wallet_route_for_category(l.user_id, l.category, l.direction) r(bucket, sign)
          WHERE l.wallet_bucket IS NULL
        ), routed AS (
         SELECT routed_explicit.user_id,
            routed_explicit.amount,
            routed_explicit.bucket,
            routed_explicit.sign,
            routed_explicit.maturity_met,
            routed_explicit.maturity_expired,
            routed_explicit.withdrawable_after,
            routed_explicit.direction,
            routed_explicit.category
           FROM routed_explicit
        UNION ALL
         SELECT routed_category.user_id,
            routed_category.amount,
            routed_category.bucket,
            routed_category.sign,
            routed_category.maturity_met,
            routed_category.maturity_expired,
            routed_category.withdrawable_after,
            routed_category.direction,
            routed_category.category
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
                END) AS advance_raw,
            sum(
                CASE
                    WHEN routed.bucket = 'withdrawable'::text AND (routed.direction = ANY (ARRAY['cash_in'::text, 'credit'::text])) AND (routed.maturity_expired = true OR routed.maturity_met = false AND now() <= COALESCE(routed.withdrawable_after, now())) THEN routed.amount
                    ELSE 0::numeric
                END) AS restricted_held
           FROM routed
          GROUP BY routed.user_id
        ), holds AS (
         SELECT
                CASE
                    WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
                    ELSE wr.user_id
                END AS user_id,
            COALESCE(sum(wr.amount), 0::numeric) AS pending_holds
           FROM withdrawal_requests wr
          WHERE (wr.status = ANY (ARRAY['pending'::text, 'requested'::text, 'manager_approved'::text, 'processing'::text, 'approved'::text])) AND NOT (EXISTS ( SELECT 1
                   FROM general_ledger g
                  WHERE g.source_table = 'withdrawal_requests'::text AND g.source_id = wr.id AND g.ledger_scope = 'wallet'::text AND (g.direction = ANY (ARRAY['cash_out'::text, 'debit'::text])))) AND (wr.reason IS NULL OR wr.reason !~~ 'Landlord float payout%'::text)
          GROUP BY (
                CASE
                    WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
                    ELSE wr.user_id
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
    GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0::numeric) - COALESCE(b.restricted_held, 0::numeric) - COALESCE(h.pending_holds, 0::numeric)) AS withdrawable,
    GREATEST(0::numeric, COALESCE(b.float_raw, 0::numeric)) AS float_balance,
    GREATEST(0::numeric, COALESCE(b.advance_raw, 0::numeric)) AS advance_balance,
    COALESCE(h.pending_holds, 0::numeric) AS pending_holds,
    COALESCE(b.restricted_held, 0::numeric) AS restricted_held,
    GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0::numeric) - COALESCE(b.restricted_held, 0::numeric) - COALESCE(h.pending_holds, 0::numeric)) + GREATEST(0::numeric, COALESCE(b.float_raw, 0::numeric)) AS total_visible,
    COALESCE(b.float_raw, 0::numeric) AS float_balance_signed
   FROM universe u
     LEFT JOIN buckets b ON b.user_id = u.user_id
     LEFT JOIN holds h ON h.user_id = u.user_id;

ALTER TABLE public.merchant_float_reconciliations
  DROP CONSTRAINT IF EXISTS merchant_float_reconciliations_adjustment_type_check;
ALTER TABLE public.merchant_float_reconciliations
  ADD CONSTRAINT merchant_float_reconciliations_adjustment_type_check
  CHECK (adjustment_type = ANY (ARRAY[
    'opening_balance','reimbursement_recorded','payout_correction','write_off','evidenced_writedown'
  ]));

CREATE OR REPLACE FUNCTION public.guard_merchant_float_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_desk_agent uuid;
BEGIN
  SELECT agent_id INTO v_desk_agent FROM public.cashout_agents WHERE id = NEW.desk_id;

  IF v_actor IS NOT NULL THEN
    IF NOT (
      public.has_role(v_actor, 'cfo')
      OR public.has_role(v_actor, 'financial_ops')
      OR public.has_role(v_actor, 'super_admin')
    ) THEN
      RAISE EXCEPTION 'MERCHANT_CORRECTION_NOT_AUTHORIZED: only the CFO, Financial Ops or a super admin can record a merchant float correction'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.created_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'MERCHANT_CORRECTION_AUTHOR_MISMATCH: the correction must be recorded under the signed-in author'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_desk_agent IS NOT NULL AND v_desk_agent = v_actor THEN
      RAISE EXCEPTION 'MERCHANT_CORRECTION_SELF_DESK_BLOCKED: you cannot correct your own merchant desk'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF v_desk_agent IS NOT NULL AND NEW.created_by IS NOT NULL AND NEW.created_by = v_desk_agent THEN
    RAISE EXCEPTION 'MERCHANT_CORRECTION_SELF_DESK_BLOCKED: the author of a correction can never be the desk holder'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_merchant_float_reconciliation ON public.merchant_float_reconciliations;
CREATE TRIGGER trg_guard_merchant_float_reconciliation
BEFORE INSERT ON public.merchant_float_reconciliations
FOR EACH ROW EXECUTE FUNCTION public.guard_merchant_float_reconciliation();

CREATE OR REPLACE FUNCTION public.block_merchant_float_reconciliation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  RAISE EXCEPTION 'MERCHANT_CORRECTION_IMMUTABLE: merchant float corrections are permanent. Post a further evidenced, authorized correcting entry instead.'
    USING ERRCODE = 'check_violation';
END;
$function$;

DROP TRIGGER IF EXISTS trg_block_merchant_float_reconciliation_update ON public.merchant_float_reconciliations;
CREATE TRIGGER trg_block_merchant_float_reconciliation_update
BEFORE UPDATE ON public.merchant_float_reconciliations
FOR EACH ROW EXECUTE FUNCTION public.block_merchant_float_reconciliation_mutation();

DROP TRIGGER IF EXISTS trg_block_merchant_float_reconciliation_delete ON public.merchant_float_reconciliations;
CREATE TRIGGER trg_block_merchant_float_reconciliation_delete
BEFORE DELETE ON public.merchant_float_reconciliations
FOR EACH ROW EXECUTE FUNCTION public.block_merchant_float_reconciliation_mutation();

REVOKE UPDATE, DELETE ON public.merchant_float_reconciliations FROM authenticated;
GRANT SELECT, INSERT ON public.merchant_float_reconciliations TO authenticated;
GRANT ALL ON public.merchant_float_reconciliations TO service_role;

CREATE OR REPLACE FUNCTION public.post_merchant_evidenced_writedown(
  p_desk_id uuid,
  p_agent_id uuid,
  p_amount numeric,
  p_reason text,
  p_evidence_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_desk_agent uuid;
  v_recon_id uuid;
  v_group_id uuid;
  v_amount numeric;
  v_float_before numeric;
  v_float_after numeric;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_evidence text := btrim(coalesce(p_evidence_note, ''));
  v_description text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'cfo')
    OR public.has_role(v_actor, 'financial_ops')
    OR public.has_role(v_actor, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Only the CFO, Financial Ops or a super admin can post an evidenced write-down';
  END IF;

  v_amount := round(coalesce(p_amount, 0));
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Enter a positive amount. The write-down is applied as a reduction of the desk float.';
  END IF;

  IF char_length(v_reason) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  IF char_length(v_evidence) < 20 THEN
    RAISE EXCEPTION 'Evidence is required: which agent, what was actually seen on their phone (balance, screenshot reference or provider TID) and the date and time it was checked';
  END IF;

  SELECT agent_id INTO v_desk_agent FROM public.cashout_agents WHERE id = p_desk_id;
  IF v_desk_agent IS NULL THEN
    RAISE EXCEPTION 'Merchant desk not found or has no linked agent';
  END IF;
  IF p_agent_id IS NOT NULL AND p_agent_id <> v_desk_agent THEN
    RAISE EXCEPTION 'Agent does not match this merchant desk';
  END IF;
  IF v_desk_agent = v_actor THEN
    RAISE EXCEPTION 'You cannot write down your own merchant desk. Another authorized finance officer must post this entry.';
  END IF;

  SELECT COALESCE(float_balance, 0) INTO v_float_before FROM public.wallets WHERE user_id = v_desk_agent;
  v_float_before := COALESCE(v_float_before, 0);
  IF v_amount > v_float_before THEN
    RAISE EXCEPTION 'Write-down of % exceeds the float on the books for this desk (%). Float can never go negative.', v_amount, v_float_before;
  END IF;

  INSERT INTO public.merchant_float_reconciliations
    (desk_id, agent_id, adjustment_type, amount, reason, evidence_note, created_by, ledger_effect)
  VALUES
    (p_desk_id, v_desk_agent, 'evidenced_writedown', v_amount, v_reason, v_evidence, v_actor, 'ledger_posted')
  RETURNING id INTO v_recon_id;

  v_description := format(
    'Merchant float evidenced write-down to the amount actually seen with the agent. Reason: %s | Evidence: %s',
    v_reason, v_evidence
  );

  v_group_id := public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_desk_agent,
        'amount', v_amount,
        'direction', 'cash_out',
        'category', 'merchant_float_correction_writedown',
        'ledger_scope', 'wallet',
        'wallet_bucket', 'float',
        'recipient_type', 'operational_wallet',
        'classification', 'admin_correction',
        'solvency_bypass_reason', 'other_with_note',
        'source_table', 'merchant_float_reconciliations',
        'source_id', v_recon_id,
        'description', v_description,
        'currency', 'UGX',
        'transaction_date', now()
      ),
      jsonb_build_object(
        'amount', v_amount,
        'direction', 'cash_in',
        'category', 'merchant_float_correction_writedown',
        'ledger_scope', 'platform',
        'classification', 'admin_correction',
        'source_table', 'merchant_float_reconciliations',
        'source_id', v_recon_id,
        'description', 'Platform: merchant float evidenced write-down recognised',
        'currency', 'UGX',
        'transaction_date', now()
      )
    ),
    idempotency_key := 'merchant_evidenced_writedown:' || v_recon_id::text,
    skip_balance_check := true
  );

  SELECT COALESCE(float_balance, 0) INTO v_float_after FROM public.wallets WHERE user_id = v_desk_agent;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'merchant_evidenced_writedown_posted', 'merchant_float_reconciliations',
          v_recon_id,
          jsonb_build_object('desk_id', p_desk_id, 'agent_id', v_desk_agent,
                             'amount', v_amount, 'ledger_group_id', v_group_id,
                             'float_before', v_float_before, 'float_after', v_float_after,
                             'reason', v_reason, 'evidence', v_evidence));

  RETURN jsonb_build_object(
    'ok', true,
    'reconciliation_id', v_recon_id,
    'ledger_group_id', v_group_id,
    'amount', v_amount,
    'float_before', v_float_before,
    'float_after', COALESCE(v_float_after, 0)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.post_merchant_evidenced_writedown(uuid, uuid, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_merchant_evidenced_writedown(uuid, uuid, numeric, text, text) TO authenticated, service_role;