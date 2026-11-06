-- Verbatim production copies (2026-11-03, read-only export via pg_get_functiondef, project byrzshwlentqvktcksem) for
-- src/test/a7PromissoryNoteDeletion.test.ts. md5(prosrc):
--   create_ledger_transaction(jsonb,text,boolean)      8e570ba579b151ac17788c0ee668a93b
--   ledger_category_allowlist_base()                   8270ad0ea82af904767ff6cba4c26f18
--   ledger_category_allowlist()                        d1b408552ac7f96bb3b84a286261c7fd
--   validate_ledger_category(text)                     6d598d2c09842ead58668b2d1c8ed251
--   validate_ledger_category()                         b0bdca0ca3a53a8993faa26d298c5c76
--   enforce_ledger_group_balance()                     31d2743f98f03490f0d848d1045f8d8e
--   enforce_ledger_group_mapped_balance()              6ed661eb7f186a854fc2e60d09e86b49
--   agent_product_category(text)                       3263efeb0d3de44af19b7891d1305bd0
--   recognise_partner_receivable(uuid)                 d02bb2e588ae54a425df29e548fcf666
--   trg_recognise_partner_receivable()                 af931f318f851cf8fa2a9a51a9a8d81c
--   derecognise_partner_receivable(uuid,text)          09ba9ff64c8eecb43a14c607aa7d5724
--   bulk_delete_promissory_notes(uuid[],text)          664c9f39c47ef78fc3b6d9d474765f4a
--   partner_ops_bulk_delete_proxy_agents(uuid[],text)  8f5cb003e4278182f6f1a4ec075905d9

CREATE OR REPLACE FUNCTION public.create_ledger_transaction(entries jsonb, idempotency_key text DEFAULT NULL::text, skip_balance_check boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group_id uuid;
  v_entry jsonb;
  v_total_in numeric := 0;
  v_total_out numeric := 0;
  v_user_balance numeric;
  v_cached_withdrawable numeric;
  v_anchor_at timestamptz;
  v_lock_key bigint;
  v_wallet_id uuid;
  v_recipient_type text;
  v_category text;
  v_scope text;
  v_effective_bucket text;
  v_headers jsonb;
  v_req_ip text;
  v_req_ua text;
BEGIN
  IF entries IS NULL OR jsonb_typeof(entries) <> 'array' THEN
    RAISE EXCEPTION 'entries must be a JSON array, got: %', COALESCE(jsonb_typeof(entries), 'NULL');
  END IF;

  PERFORM set_config('ledger.authorized', 'true', true);

  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
    v_req_ua := v_headers ->> 'user-agent';
    IF v_req_ua IS NOT NULL AND v_req_ua ILIKE '%SupabaseEdgeRuntime%' THEN
      v_req_ip := NULL;
      v_req_ua := NULL;
    ELSE
      v_req_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
      IF v_req_ip IS NULL THEN
        v_req_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_req_ip := NULL;
    v_req_ua := NULL;
  END;

  IF idempotency_key IS NOT NULL AND idempotency_key <> '' THEN
    v_lock_key := abs(hashtext(idempotency_key));
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT transaction_group_id INTO v_group_id
    FROM public.general_ledger
    WHERE general_ledger.idempotency_key = create_ledger_transaction.idempotency_key
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_group_id IS NOT NULL THEN
      RETURN v_group_id;
    END IF;
  END IF;

  v_group_id := gen_random_uuid();

  FOR v_entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    IF (v_entry->>'amount')::numeric <= 0 THEN
      RAISE EXCEPTION 'All amounts must be positive, got: %', v_entry->>'amount';
    END IF;

    v_category       := v_entry->>'category';
    v_scope          := COALESCE(v_entry->>'ledger_scope', 'wallet');
    v_recipient_type := NULLIF(v_entry->>'recipient_type', '');

    IF v_scope = 'wallet' AND v_category IN (
      'agent_repayment','agent_advance_repayment','salary_advance_repayment','debt_recovery'
    ) THEN
      IF v_recipient_type IS NULL THEN
        BEGIN
          INSERT INTO public.wallet_routing_violations (
            user_id, category, direction, amount, recipient_type, reason, context
          ) VALUES (
            NULLIF(v_entry->>'user_id','')::uuid,
            v_category, v_entry->>'direction',
            (v_entry->>'amount')::numeric, NULL,
            'RECIPIENT_TYPE_REQUIRED',
            jsonb_build_object('source','create_ledger_transaction','rule','advance_recovery_isolation')
          );
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        RAISE EXCEPTION 'agent_repayment requires explicit recipient_type on the wallet leg' USING ERRCODE = 'check_violation';
      END IF;

      BEGIN
        PERFORM public.assert_routing_compatible(v_category, v_recipient_type);
      EXCEPTION WHEN check_violation THEN
        BEGIN
          INSERT INTO public.wallet_routing_violations (
            user_id, category, direction, amount, recipient_type, reason, context
          ) VALUES (
            NULLIF(v_entry->>'user_id','')::uuid,
            v_category, v_entry->>'direction',
            (v_entry->>'amount')::numeric, v_recipient_type,
            SQLERRM,
            jsonb_build_object('source','create_ledger_transaction','rule','advance_recovery_isolation')
          );
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        RAISE;
      END;
    END IF;

    IF v_entry->>'direction' = 'cash_in' THEN
      v_total_in := v_total_in + (v_entry->>'amount')::numeric;
    ELSIF v_entry->>'direction' = 'cash_out' THEN
      v_total_out := v_total_out + (v_entry->>'amount')::numeric;

      v_effective_bucket := COALESCE(
        NULLIF(v_entry->>'wallet_bucket', ''),
        CASE
          WHEN v_recipient_type = 'operational_wallet' THEN 'float'
          WHEN v_recipient_type = 'user' THEN 'withdrawable'
          ELSE 'withdrawable'
        END
      );

      IF NOT skip_balance_check
         AND v_scope = 'wallet'
         AND (v_entry->>'user_id') IS NOT NULL
         AND v_effective_bucket = 'withdrawable' THEN

        SELECT anchor_at INTO v_anchor_at
        FROM public.wallet_fresh_start_anchors
        WHERE user_id = (v_entry->>'user_id')::uuid;

        WITH category_routed AS (
          SELECT COALESCE(SUM(CASE WHEN r.bucket = 'withdrawable' THEN r.sign * gl.amount ELSE 0 END), 0) AS net
          FROM public.general_ledger gl
          CROSS JOIN LATERAL public.wallet_route_for_category(gl.user_id, gl.category, gl.direction) r
          WHERE gl.user_id = (v_entry->>'user_id')::uuid
            AND gl.ledger_scope = 'wallet'
            AND (gl.classification IS NULL OR gl.classification = 'production')
            AND (v_anchor_at IS NULL OR gl.created_at >= v_anchor_at)
            AND gl.wallet_bucket IS NULL
        ), explicit_routed AS (
          SELECT COALESCE(SUM(
            CASE
              WHEN wallet_bucket = 'withdrawable' AND direction IN ('cash_in','credit') THEN amount
              WHEN wallet_bucket = 'withdrawable' AND direction IN ('cash_out','debit') THEN -amount
              ELSE 0
            END
          ), 0) AS net
          FROM public.general_ledger
          WHERE user_id = (v_entry->>'user_id')::uuid
            AND ledger_scope = 'wallet'
            AND (classification IS NULL OR classification = 'production')
            AND (v_anchor_at IS NULL OR created_at >= v_anchor_at)
            AND wallet_bucket IS NOT NULL
        )
        SELECT category_routed.net + explicit_routed.net
        INTO v_user_balance
        FROM category_routed, explicit_routed;

        SELECT COALESCE(withdrawable_balance, 0)
        INTO v_cached_withdrawable
        FROM public.wallets
        WHERE user_id = (v_entry->>'user_id')::uuid;

        v_user_balance := GREATEST(0,
          LEAST(COALESCE(v_cached_withdrawable, 0), GREATEST(0, COALESCE(v_user_balance, 0)))
        );

        IF v_user_balance < (v_entry->>'amount')::numeric THEN
          RAISE EXCEPTION 'Insufficient ledger balance for user %. Available: %, Required: %',
            v_entry->>'user_id', v_user_balance, v_entry->>'amount';
        END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'Invalid direction: %. Must be cash_in or cash_out', v_entry->>'direction';
    END IF;
  END LOOP;

  IF v_total_in <> v_total_out THEN
    RAISE EXCEPTION 'Transaction not balanced. Total cash_in (%) <> total cash_out (%)', v_total_in, v_total_out;
  END IF;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    v_wallet_id := NULL;
    IF (v_entry->>'user_id') IS NOT NULL THEN
      SELECT id INTO v_wallet_id
      FROM public.wallets
      WHERE user_id = (v_entry->>'user_id')::uuid;
    END IF;

    INSERT INTO public.general_ledger (
      user_id, wallet_id, ledger_scope, direction, category, amount, currency,
      description, source_table, source_id, transaction_group_id,
      idempotency_key, transaction_date, linked_party, reference_id, account,
      classification, recipient_type, wallet_bucket, routing_source,
      solvency_bypass_reason, ip_address, user_agent
    ) VALUES (
      (v_entry->>'user_id')::uuid,
      v_wallet_id,
      COALESCE(v_entry->>'ledger_scope', 'wallet'),
      v_entry->>'direction',
      v_entry->>'category',
      (v_entry->>'amount')::numeric,
      COALESCE(v_entry->>'currency', 'UGX'),
      v_entry->>'description',
      COALESCE(v_entry->>'source_table', 'ledger_transaction'),
      (v_entry->>'source_id')::uuid,
      v_group_id,
      create_ledger_transaction.idempotency_key,
      COALESCE((v_entry->>'transaction_date')::timestamptz, now()),
      v_entry->>'linked_party',
      v_entry->>'reference_id',
      v_entry->>'account',
      COALESCE(v_entry->>'classification', 'production'),
      NULLIF(v_entry->>'recipient_type', ''),
      NULLIF(v_entry->>'wallet_bucket', ''),
      NULLIF(v_entry->>'routing_source', ''),
      NULLIF(v_entry->>'solvency_bypass_reason', '')::public.solvency_bypass_reason,
      v_req_ip,
      v_req_ua
    );
  END LOOP;

  RETURN v_group_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ledger_category_allowlist_base()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$ select array['🔧 Manual Adjustment', 'access_fee_collected', 'account_merge', 'advance_repayment', 'agent_advance_credit', 'agent_advance_repayment', 'agent_bonus', 'agent_commission', 'agent_commission_accrued', 'agent_commission_earned', 'agent_commission_payable', 'agent_commission_settled', 'agent_commission_used_for_rent', 'agent_commission_withdrawal', 'agent_facilitated_capital_receivable', 'agent_float_assignment', 'agent_float_cash_offset', 'agent_float_cycle_settled_to_bank', 'agent_float_deposit', 'agent_float_funding', 'agent_float_settlement', 'agent_float_topup', 'agent_float_used', 'agent_float_used_for_rent', 'agent_investment_commission', 'agent_landlord_payout', 'agent_proxy_investment', 'agent_repayment', 'angel_pool_investment', 'balance_correction', 'bucket_reclass_in', 'bucket_reclass_out', 'cash_at_bank_reclass', 'cash_custody_payable', 'cash_in_transit_banked', 'cash_receipt_in_transit', 'cfo_direct_credit', 'coo_proxy_investment', 'coo_proxy_investment_reversal', 'correction_reversal', 'credit_access_repayment', 'debt_clearance', 'debt_recovery', 'deposit', 'equipment_expense', 'facilitation_disbursement', 'fee_receivable_created', 'general_admin_expense', 'historical_balance_reseed', 'interest_expense', 'landlord_receivable_collected', 'landlord_receivable_created', 'landlord_receivable_obligation', 'landlord_rent_payment', 'listing_bonus', 'listing_bonus_expense', 'listing_rejection_offset', 'listing_rejection_penalty', 'listing_rejection_recovery', 'manager_credit', 'manager_debit', 'marketing_expense', 'merchant_float_correction_writedown', 'merchant_oop_reimbursement', 'orphan_reassignment', 'orphan_reversal', 'partner_capital_cash_received', 'partner_commission', 'partner_funding', 'partner_receivable_capital', 'partner_receivable_collected', 'partner_receivable_created', 'partner_reward_accrued', 'partner_returns_allocated', 'platform_fee_collected', 'payroll_expense', 'pending_portfolio_topup', 'platform_expense', 'platform_loss_writeoff', 'pool_capital_received', 'pool_rent_deployment_reversal', 'proxy_investment_commission', 'proxy_partner_withdrawal', 'reconciliation', 'referral_bonus', 'registration_fee_collected', 'rent_disbursement', 'rent_float_funding', 'rent_obligation', 'rent_obligation_reversal', 'rent_obligation_reversal_adjustment', 'rent_payment_for_tenant', 'rent_payment_received', 'rent_principal_collected', 'rent_receivable_created', 'rent_repayment', 'research_development_expense', 'roi_expense', 'roi_payout', 'roi_reinvestment', 'roi_wallet_credit', 'salary_advance', 'salary_advance_repayment', 'salary_payout', 'share_capital', 'staff_loan_disbursement', 'staff_loan_repayment', 'supporter_capital', 'supporter_rent_fund', 'system_balance_correction', 'tax_expense', 'tenant_default_charge', 'tenant_rent_settlement', 'tenant_repayment', 'tenant_repayment_collected', 'test_funds_cleanup', 'treasury_allocated', 'treasury_bank_deposit', 'treasury_fee_drawdown', 'treasury_fee_recognised', 'treasury_net_revenue', 'verified_bank_cash_recognised', 'wallet_deduction', 'wallet_deduction_cash_payout_retraction', 'wallet_deduction_general_adjustment', 'wallet_deposit', 'wallet_to_investment', 'wallet_transfer', 'wallet_withdrawal']::text[] $function$;

CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT ((public.ledger_category_allowlist_base() || ARRAY[
    'agent_advance_receivable_opening',
    'agent_access_fee_receivable_opening',
    'merchandise_recovery_receivable_opening',
    'bike_recovery_receivable_opening',
    'credit_draw_receivable_opening',
    'merchandise_credit_sale_receivable_opening',
    'service_centre_advance_receivable_opening',
    'service_centre_receivable_opening',
    'tenant_service_charge_receivable_opening',
    'business_advance_receivable_opening',
    'rent_plan_receivable_restatement',
    'receivable_restatement_equity',
    'merchandise_recovery_repayment',
    'bike_recovery_repayment',
    'credit_draw_repayment',
    'smartphone_advance_receivable',
    'agent_advance_disbursement',
    'agent_advance_access_fee_charged',
    'agent_advance_registration_fee_charged',
    'agent_advance_fee_revenue',
    'agent_advance_penalty_accrued',
    'agent_advance_penalty_unearned',
    'agent_advance_access_fee_collected',
    'agent_advance_registration_fee_collected',
    'agent_advance_written_off',
    'agent_advance_access_fee_written_off',
    'agent_advance_registration_fee_written_off',
    'agent_advance_reversed',
    'agent_advance_clawback',
    'agent_advance_late_fee_income',
    'agent_advance_access_fee_collected_external',
    'agent_advance_registration_fee_collected_external',
    'agent_advance_penalty_accrued_external',
    -- Landlord Float Pool (20260929160000, 20260929180000, 20260929240000)
    'landlord_pool_reserve_self_support',
    'landlord_pool_reserve_company_managed',
    'landlord_pool_reserve_source',
    'landlord_pool_topup_self_support',
    'landlord_pool_topup_company_managed',
    'landlord_pool_compound_self_support',
    'landlord_pool_compound_company_managed',
    'landlord_pool_deploy_self_support',
    'landlord_pool_deploy_company_managed',
    'landlord_pool_deploy_target',
    'landlord_pool_return_self_support',
    'landlord_pool_return_company_managed',
    'landlord_pool_return_source',
    'landlord_pool_release_self_support',
    'landlord_pool_release_company_managed',
    'landlord_pool_release_target'
  ]::text[]) || ARRAY['special_advance_credit', 'special_advance_receivable', 'special_advance_payout_cash',
                       'special_advance_fee_revenue', 'special_advance_repayment_received', 'special_advance_repayment']::text[]) || ARRAY['special_advance_impairment_charge', 'special_advance_impairment_allowance', 'special_advance_write_off',
                       'special_advance_write_off_loss', 'special_advance_recovery_received', 'special_advance_recovery_income']::text[];
$function$;

CREATE OR REPLACE FUNCTION public.validate_ledger_category(p_category text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(p_category = ANY(public.ledger_category_allowlist()), false);
$function$;

CREATE OR REPLACE FUNCTION public.validate_ledger_category()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  is_strict boolean;
BEGIN
  SELECT COALESCE((
    SELECT enabled
    FROM public.treasury_controls
    WHERE control_key = 'strict_mode'
    LIMIT 1
  ), false)
  INTO is_strict;

  IF is_strict AND NOT public.validate_ledger_category(NEW.category) THEN
    RAISE EXCEPTION 'Category "%" is not in the locked allowlist', NEW.category;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_ledger_group_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_net numeric;
  v_cutoff timestamptz;
  v_first_at timestamptz;
  v_is_correction boolean;
  v_has_production boolean;
  v_has_correction_class boolean;
BEGIN
  IF NEW.transaction_group_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT enforce_from INTO v_cutoff FROM public.ledger_integrity_config WHERE id = true;
  IF v_cutoff IS NULL THEN v_cutoff := now(); END IF;

  SELECT MIN(created_at) INTO v_first_at
    FROM public.general_ledger
   WHERE transaction_group_id = NEW.transaction_group_id;

  IF v_first_at IS NULL OR v_first_at < v_cutoff THEN
    RETURN NEW;
  END IF;

  -- Is this group a system balance correction group?
  SELECT EXISTS (
    SELECT 1 FROM public.general_ledger
     WHERE transaction_group_id = NEW.transaction_group_id
       AND category = 'system_balance_correction'
  ) INTO v_is_correction;

  IF v_is_correction THEN
    -- Correction groups may legitimately mix 'production' and 'admin_correction'
    -- (the correction leg is force-classified by enforce_correction_classification).
    -- Nothing else is allowed, and the group must still net to zero across both.
    IF EXISTS (
      SELECT 1 FROM public.general_ledger
       WHERE transaction_group_id = NEW.transaction_group_id
         AND classification NOT IN ('production','admin_correction')
    ) THEN
      RAISE EXCEPTION 'System balance correction group % contains disallowed classifications.',
        NEW.transaction_group_id
        USING HINT = 'Correction groups may only contain production or admin_correction legs.';
    END IF;

    SELECT SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END)
      INTO v_net
      FROM public.general_ledger
     WHERE transaction_group_id = NEW.transaction_group_id
       AND classification IN ('production','admin_correction');

    IF v_net IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Ledger group % is unbalanced (net=%). Every wallet activity must post balanced double-entry legs.',
        NEW.transaction_group_id, v_net
        USING HINT = 'Use create_ledger_transaction with matching credit/debit legs.';
    END IF;

    RETURN NEW;
  END IF;

  -- Non-correction groups: no mixing of production and admin_correction allowed.
  SELECT
    bool_or(classification = 'production'),
    bool_or(classification = 'admin_correction')
    INTO v_has_production, v_has_correction_class
    FROM public.general_ledger
   WHERE transaction_group_id = NEW.transaction_group_id;

  IF COALESCE(v_has_production, false) AND COALESCE(v_has_correction_class, false) THEN
    RAISE EXCEPTION 'Ledger group % mixes production and admin_correction classifications.',
      NEW.transaction_group_id
      USING HINT = 'Mixed classifications are only permitted for system_balance_correction groups.';
  END IF;

  IF NEW.classification IS DISTINCT FROM 'production' THEN
    RETURN NEW;
  END IF;

  SELECT SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END)
    INTO v_net
    FROM public.general_ledger
   WHERE transaction_group_id = NEW.transaction_group_id
     AND classification = 'production';

  IF v_net IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Ledger group % is unbalanced (net=%). Every wallet activity must post balanced double-entry legs.',
      NEW.transaction_group_id, v_net
      USING HINT = 'Use create_ledger_transaction with matching credit/debit legs.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_ledger_group_mapped_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cutoff timestamptz; v_first timestamptz; v_mode text;
  v_dr numeric := 0; v_cr numeric := 0; v_resid numeric;
  v_has_treasury boolean := false; v_shape text; v_src text;
BEGIN
  IF NEW.transaction_group_id IS NULL THEN RETURN NEW; END IF;

  SELECT enforce_from, COALESCE(mapped_balance_mode,'log')
    INTO v_cutoff, v_mode FROM public.ledger_integrity_config WHERE id = true;
  IF v_cutoff IS NULL THEN v_cutoff := now(); END IF;

  SELECT MIN(created_at) INTO v_first FROM public.general_ledger
   WHERE transaction_group_id = NEW.transaction_group_id;
  -- Legacy gate: identical to the existing raw-direction control. Historical
  -- groups are never re-judged and are never silently repaired.
  IF v_first IS NULL OR v_first < v_cutoff THEN RETURN NEW; END IF;

  WITH legs AS (
    SELECT gl.direction dir, gl.amount amt, gl.source_table st,
           gl.ledger_scope||'.'||gl.category AS posting,
           COALESCE(mb.account_code, mw.account_code,
             CASE WHEN gl.ledger_scope='wallet' AND gl.wallet_bucket='float'   THEN 'A2'
                  WHEN gl.ledger_scope='wallet' AND gl.wallet_bucket='advance' THEN 'A4'
                  WHEN gl.ledger_scope='wallet'                                THEN 'L1'
                  ELSE 'A9' END) AS acct,
           COALESCE(mb.debit_when, mw.debit_when,
             CASE WHEN gl.ledger_scope='wallet' AND gl.wallet_bucket IN ('float','advance') THEN 'cash_in'
                  WHEN gl.ledger_scope='wallet'                                             THEN 'cash_out'
                  ELSE 'cash_in' END) AS dw,
           gl.category
    FROM public.general_ledger gl
    LEFT JOIN public.ledger_account_map mb ON mb.ledger_scope=gl.ledger_scope AND mb.category=gl.category
          AND mb.wallet_bucket IS NOT NULL AND mb.wallet_bucket=gl.wallet_bucket
    LEFT JOIN public.ledger_account_map mw ON mw.ledger_scope=gl.ledger_scope AND mw.category=gl.category
          AND mw.wallet_bucket IS NULL
    WHERE gl.transaction_group_id = NEW.transaction_group_id
  )
  SELECT COALESCE(SUM(CASE WHEN dir=dw THEN amt ELSE 0 END),0),
         COALESCE(SUM(CASE WHEN dir=dw THEN 0 ELSE amt END),0),
         bool_or(category IN ('treasury_fee_recognised','treasury_allocated','fee_receivable_created',
                              'partner_reward_accrued','agent_commission_accrued','treasury_net_revenue')),
         string_agg(DISTINCT posting||'->'||acct||'/'||CASE WHEN dir=dw THEN 'DR' ELSE 'CR' END, ' + '),
         MIN(st)
    INTO v_dr, v_cr, v_has_treasury, v_shape, v_src
  FROM legs;

  v_resid := v_dr - v_cr;
  IF abs(v_resid) <= 0.5 THEN RETURN NEW; END IF;

  -- New Landlord Flow -> Treasury postings have no legacy population, so they
  -- are ALWAYS enforced regardless of mode.
  IF v_has_treasury OR v_mode = 'enforce' THEN
    RAISE EXCEPTION 'Ledger group % fails mapped double-entry: debits % <> credits % (residual %). Shape: %',
      NEW.transaction_group_id, v_dr, v_cr, v_resid, v_shape
      USING HINT = 'Every group must balance on MAPPED accounting treatment, not just raw cash_in/cash_out.';
  END IF;

  INSERT INTO public.ledger_mapped_balance_violations
    (transaction_group_id, mapped_debits, mapped_credits, residual, source_table, leg_shape)
  VALUES (NEW.transaction_group_id, v_dr, v_cr, v_resid, v_src, v_shape)
  ON CONFLICT (transaction_group_id) DO UPDATE
    SET mapped_debits=EXCLUDED.mapped_debits, mapped_credits=EXCLUDED.mapped_credits,
        residual=EXCLUDED.residual, leg_shape=EXCLUDED.leg_shape, detected_at=now();
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.agent_product_category(p_item_name text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_name text := coalesce(trim(p_item_name), '');
BEGIN
  IF v_name = '' THEN RETURN 'boutique'; END IF;
  -- Any Motorola model is a smart phone, never a bike or boutique item.
  IF v_name ~* 'motorola' THEN RETURN 'smart_phone'; END IF;
  IF v_name ~* '(bike|boda|motor|spiro|cycle)'
     AND v_name !~* '(jacket|helmet|motorola|evidence|chair|\mids?\M)' THEN RETURN 'motor_bike'; END IF;
  IF v_name ~* '(phone|smartphone|tablet|handset)' THEN RETURN 'smart_phone'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.smartphone_catalog c
    WHERE v_name ILIKE '%' || c.brand || '%' || c.model_name || '%'
       OR v_name ILIKE '%' || c.brand || ' ' || c.model_name || '%'
       OR v_name ILIKE c.brand || '%'
  ) THEN
    RETURN 'smart_phone';
  END IF;
  IF v_name ~* '(signage|sign board|shop board|board|banner|poster|sticker|billboard|branding)' THEN RETURN 'signage'; END IF;
  RETURN 'boutique';
END
$function$;

CREATE OR REPLACE FUNCTION public.recognise_partner_receivable(p_note_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  n record;
  v_amt numeric;
  v_recognised numeric;
  v_gap numeric;
  v_legs jsonb;
  v_ref text;
BEGIN
  SELECT id, agent_id, partner_name, status, amount, total_collected INTO n
    FROM promissory_notes WHERE id = p_note_id;
  IF n.id IS NULL THEN RETURN jsonb_build_object('posted', false, 'reason','note not found'); END IF;
  IF n.status <> 'activated' THEN
    RETURN jsonb_build_object('posted', false, 'reason','not activated'); END IF;

  v_amt := GREATEST(COALESCE(n.amount,0) - COALESCE(n.total_collected,0), 0);
  IF v_amt <= 0 THEN RETURN jsonb_build_object('posted', false, 'reason','nothing outstanding'); END IF;

  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END), 0)
    INTO v_recognised
    FROM general_ledger
   WHERE category = 'partner_receivable_created'
     AND ledger_scope = 'bridge'
     AND source_id = n.id;

  v_gap := v_amt - GREATEST(v_recognised, 0);
  IF v_gap <= 0 THEN
    RETURN jsonb_build_object('posted', false, 'reason','already recognised',
                              'recognised', v_recognised, 'outstanding', v_amt);
  END IF;

  v_ref := 'partner_recv:' || n.id::text ||
           CASE WHEN EXISTS (
                  SELECT 1 FROM general_ledger
                   WHERE category = 'partner_receivable_created' AND source_id = n.id)
                THEN ':re' || to_char(now(), 'YYYYMMDDHH24MISS')
                ELSE '' END;

  v_legs := jsonb_build_array(
    jsonb_build_object('amount', v_gap, 'direction','cash_in',
      'category','partner_receivable_created','ledger_scope','bridge','classification','production',
      'description','Partner receivable recognised for ' || COALESCE(n.partner_name,'partner'),
      'source_table','promissory_notes','source_id', n.id),
    jsonb_build_object('amount', v_gap, 'direction','cash_out',
      'category','partner_receivable_capital','ledger_scope','platform','classification','production',
      'description','Partner capital obligation for ' || COALESCE(n.partner_name,'partner'),
      'source_table','promissory_notes','source_id', n.id));
  PERFORM public.create_ledger_transaction(v_legs, v_ref, false);
  RETURN jsonb_build_object('posted', true, 'amount', v_gap, 'note_id', n.id,
                            'previously_recognised', v_recognised);
END; $function$;

CREATE OR REPLACE FUNCTION public.trg_recognise_partner_receivable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ BEGIN
  PERFORM public.recognise_partner_receivable(NEW.id);
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.derecognise_partner_receivable(p_note_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  n record;
  v_net numeric;
  v_legs jsonb;
  v_group uuid;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'a written reason of at least 10 characters is required';
  END IF;

  SELECT id, partner_name, status INTO n FROM promissory_notes WHERE id = p_note_id;
  IF n.id IS NULL THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'note not found');
  END IF;

  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END), 0)
    INTO v_net
    FROM general_ledger
   WHERE category = 'partner_receivable_created'
     AND source_id = p_note_id;

  IF v_net <= 0 THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'nothing recognised to reverse');
  END IF;

  v_legs := jsonb_build_array(
    jsonb_build_object('amount', v_net, 'direction', 'cash_out',
      'category', 'partner_receivable_created', 'ledger_scope', 'bridge',
      'classification', 'production',
      'description', 'A7 correction (reversal): removes the partner receivable recognised for '
        || COALESCE(n.partner_name, 'partner') || ' on promissory note ' || p_note_id::text
        || ', which is not activated (status ' || COALESCE(n.status, 'unknown') || '). Reason: ' || btrim(p_reason),
      'source_table', 'promissory_notes', 'source_id', p_note_id),
    jsonb_build_object('amount', v_net, 'direction', 'cash_in',
      'category', 'partner_receivable_capital', 'ledger_scope', 'platform',
      'classification', 'production',
      'description', 'A7 correction (reversal): removes the partner capital obligation recognised for '
        || COALESCE(n.partner_name, 'partner') || ' on non-activated promissory note ' || p_note_id::text
        || '. Reason: ' || btrim(p_reason),
      'source_table', 'promissory_notes', 'source_id', p_note_id));

  v_group := public.create_ledger_transaction(v_legs, 'partner_recv_rev:' || p_note_id::text, false);

  RETURN jsonb_build_object('posted', true, 'amount', v_net, 'note_id', p_note_id, 'group_id', v_group);
END;
$function$;

CREATE OR REPLACE FUNCTION public.bulk_delete_promissory_notes(p_note_ids uuid[], p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_ids uuid[];
  v_blocked jsonb := '[]'::jsonb;
  v_deletable uuid[];
  v_deleted int := 0;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Not authenticated');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_actor
      AND ur.role = ANY (ARRAY['operations','partner_ops','cfo','coo','manager','ceo','super_admin']::app_role[])
  ) THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Not authorized to delete promissory notes');
  END IF;

  IF char_length(v_reason) < 10 THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'A reason of at least 10 characters is required');
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_ids
  FROM unnest(coalesce(p_note_ids, ARRAY[]::uuid[])) AS t(x)
  WHERE x IS NOT NULL;

  IF v_ids IS NULL OR array_length(v_ids, 1) = 0 THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'No notes selected');
  END IF;

  IF array_length(v_ids, 1) > 200 THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Select at most 200 notes per batch');
  END IF;

  -- Financially linked notes are never deleted; they are reported back.
  WITH candidates AS (
    SELECT n.id, n.partner_name
    FROM public.promissory_notes n
    WHERE n.id = ANY (v_ids)
  ), blocked AS (
    SELECT c.id, c.partner_name,
      CASE
        WHEN EXISTS (SELECT 1 FROM public.partner_self_commitments s WHERE s.promissory_note_id = c.id)
          THEN 'Linked to a partner self-support commitment'
        ELSE 'Linked to a pending partner portfolio'
      END AS reason
    FROM candidates c
    WHERE EXISTS (SELECT 1 FROM public.partner_self_commitments s WHERE s.promissory_note_id = c.id)
       OR EXISTS (SELECT 1 FROM public.funder_pending_portfolios f WHERE f.promissory_note_id = c.id)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'partner_name', b.partner_name, 'reason', b.reason)), '[]'::jsonb)
  INTO v_blocked
  FROM blocked b;

  SELECT array_agg(n.id) INTO v_deletable
  FROM public.promissory_notes n
  WHERE n.id = ANY (v_ids)
    AND NOT EXISTS (SELECT 1 FROM public.partner_self_commitments s WHERE s.promissory_note_id = n.id)
    AND NOT EXISTS (SELECT 1 FROM public.funder_pending_portfolios f WHERE f.promissory_note_id = n.id);

  IF v_deletable IS NULL OR array_length(v_deletable, 1) = 0 THEN
    RETURN jsonb_build_object('status', 'ok', 'deleted', 0, 'blocked', v_blocked);
  END IF;

  -- Audit trail BEFORE removal (one set-based insert, no N+1)
  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  SELECT v_actor, 'delete', 'bulk_delete_promissory_note', 'promissory_notes', n.id::text,
    jsonb_build_object(
      'reason', v_reason,
      'partner_name', n.partner_name,
      'whatsapp_number', n.whatsapp_number,
      'amount', n.amount,
      'total_collected', n.total_collected,
      'status', n.status,
      'approval_bonus_paid', n.approval_bonus_paid,
      'agent_id', n.agent_id,
      'batch_size', array_length(v_deletable, 1),
      'deleted_at', now()
    )
  FROM public.promissory_notes n
  WHERE n.id = ANY (v_deletable);

  -- Cascade cleanup of dependent rows so the agent side keeps no orphans
  DELETE FROM public.promissory_note_release_notices WHERE note_id = ANY (v_deletable);
  DELETE FROM public.promissory_note_pledge_notices WHERE note_id = ANY (v_deletable);
  DELETE FROM public.promissory_note_plan_intents WHERE note_id = ANY (v_deletable);
  DELETE FROM public.partner_note_overrides WHERE note_id = ANY (v_deletable);
  DELETE FROM public.partner_note_reversals WHERE note_id = ANY (v_deletable);

  -- Commission history is retained but unlinked (nullable reference)
  UPDATE public.promissory_commission_events SET note_id = NULL WHERE note_id = ANY (v_deletable);

  DELETE FROM public.promissory_notes WHERE id = ANY (v_deletable);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object('status', 'ok', 'deleted', v_deleted, 'blocked', v_blocked);
END;
$function$;

CREATE OR REPLACE FUNCTION public.partner_ops_bulk_delete_proxy_agents(p_agent_ids uuid[], p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := NULLIF(btrim(COALESCE(p_reason,'')),'');
  v_ids uuid[];
  v_identities int := 0;
  v_notes int := 0;
  v_assignments int := 0;
  v_invites int := 0;
  v_id uuid;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'partner_ops'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_reason IS NULL OR length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Provide a reason of at least 10 characters';
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_ids
    FROM unnest(COALESCE(p_agent_ids, '{}'::uuid[])) AS x
   WHERE x IS NOT NULL;

  IF v_ids IS NULL OR array_length(v_ids, 1) = 0 THEN
    RAISE EXCEPTION 'Select at least one proxy agent';
  END IF;

  DELETE FROM public.promissory_notes WHERE agent_id = ANY(v_ids);
  GET DIAGNOSTICS v_notes = ROW_COUNT;

  UPDATE public.proxy_agent_assignments
     SET is_active = false, updated_at = now()
   WHERE agent_id = ANY(v_ids) AND is_active;
  GET DIAGNOSTICS v_assignments = ROW_COUNT;

  DELETE FROM public.proxy_partner_invites WHERE proxy_agent_id = ANY(v_ids);
  GET DIAGNOSTICS v_invites = ROW_COUNT;

  DELETE FROM public.proxy_agent_identity WHERE agent_user_id = ANY(v_ids);
  GET DIAGNOSTICS v_identities = ROW_COUNT;

  FOREACH v_id IN ARRAY v_ids LOOP
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (auth.uid(), 'proxy_agent_deleted', 'proxy_agent_identity', v_id::text, v_reason,
            jsonb_build_object('bulk', true, 'batch_size', array_length(v_ids,1)));
  END LOOP;

  RETURN jsonb_build_object(
    'agents_deleted', v_identities,
    'notes_deleted', v_notes,
    'assignments_deactivated', v_assignments,
    'invites_deleted', v_invites
  );
END;
$function$;
