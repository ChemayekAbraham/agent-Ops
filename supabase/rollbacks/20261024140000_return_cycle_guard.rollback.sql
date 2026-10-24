-- Rollback for 20261024140000_return_cycle_guard.sql. PREPARED FOR REVIEW. NOT APPLIED.
-- Restores the production bodies of enforce_roi_cycle_once() and post_portfolio_roi_ledger(6 args) exactly as read
-- from production on 2026-10-24, and removes the new triggers and functions. Moves no money and changes no ledger row.
-- The two tables portfolio_return_cycle_claims / _overrides are KEPT as the audit record of what was reserved and
-- authorised; drop them separately once reviewed (re-applying the migration requires them to be absent).
-- After rollback, deploy the previous approve-wallet-operation, or its Return approvals fail closed (the claim RPC
-- will be missing). TRANSACTION: run as ONE transaction (BEGIN; ... COMMIT;).

SET lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_enforce_return_cycle_ledger_key ON public.general_ledger;
DROP TRIGGER IF EXISTS trg_release_return_cycle_claim ON public.pending_wallet_operations;

CREATE OR REPLACE FUNCTION public.enforce_roi_cycle_once()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cycle_anchor text;
  v_cycle_key text;
  v_correction_key text;
  v_credited_exists boolean;
  v_open_pending_exists boolean;
BEGIN
  IF NEW.category IS DISTINCT FROM 'roi_payout'
     OR NEW.source_table IS DISTINCT FROM 'investor_portfolios'
     OR NEW.source_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_correction_key := nullif(btrim(COALESCE(NEW.metadata->>'correction_key', '')), '');

  SELECT COALESCE(
           nullif(btrim(COALESCE(NEW.metadata->>'cycle_anchor', '')), ''),
           next_roi_date::text,
           to_char(now(), 'YYYY-MM-DD')
         )
    INTO v_cycle_anchor
    FROM public.investor_portfolios
   WHERE id = NEW.source_id;

  IF v_cycle_anchor IS NULL THEN
    v_cycle_anchor := to_char(now(), 'YYYY-MM-DD');
  END IF;

  v_cycle_key := CASE
    WHEN v_correction_key IS NOT NULL
      THEN 'roi-cycle-correction-' || v_correction_key
    ELSE 'roi-cycle-' || NEW.source_id::text || '-' || v_cycle_anchor
  END;

  SELECT EXISTS (
    SELECT 1 FROM public.general_ledger
     WHERE idempotency_key = v_cycle_key
  ) INTO v_credited_exists;

  IF v_credited_exists THEN
    RAISE EXCEPTION 'Duplicate ROI payout blocked: portfolio % already received its ROI for the % cycle.', NEW.source_id, v_cycle_anchor
      USING ERRCODE = 'unique_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.pending_wallet_operations pwo
     WHERE pwo.source_id = NEW.source_id
       AND pwo.source_table = 'investor_portfolios'
       AND pwo.category = 'roi_payout'
       AND pwo.status IN ('pending', 'pending_coo_approval', 'coo_approved', 'awaiting_verification')
       AND (TG_OP <> 'INSERT' OR pwo.id IS DISTINCT FROM NEW.id)
       AND (
         v_correction_key IS NULL
         OR pwo.metadata->>'correction_key' = v_correction_key
       )
  ) INTO v_open_pending_exists;

  IF v_open_pending_exists THEN
    RAISE EXCEPTION 'Duplicate ROI payout blocked: portfolio % already has an ROI payout awaiting approval for the % cycle.', NEW.source_id, v_cycle_anchor
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.post_portfolio_roi_ledger(p_operation text, p_portfolio_id uuid, p_amount numeric, p_reference text, p_description_out text, p_description_in text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_investor uuid; v_principal numeric; v_pct numeric; v_cycle_returns numeric;
  v_recipient uuid; v_keep boolean;
BEGIN
  IF v_actor IS NULL OR NOT public._ledger_can_post_partner_returns(v_actor) THEN
    RAISE EXCEPTION 'Not authorised to post partner Returns' USING ERRCODE = '42501'; END IF;
  IF p_operation IS NULL OR p_operation NOT IN ('compound', 'split_reinvest', 'split_keep_returns') THEN
    RAISE EXCEPTION 'Unknown Returns operation' USING ERRCODE = '22023'; END IF;
  IF p_reference IS NULL OR p_reference !~ '^(CMP|SPL)-[A-Z0-9]{4,20}-[A-Z0-9]{2,8}$' THEN
    RAISE EXCEPTION 'Invalid Returns reference' USING ERRCODE = '22023'; END IF;
  IF length(coalesce(p_description_out, '')) > 2000 OR length(coalesce(p_description_in, '')) > 2000 THEN
    RAISE EXCEPTION 'Description too long' USING ERRCODE = '22023'; END IF;
  IF p_amount IS NULL OR p_amount < 1 OR p_amount <> round(p_amount) THEN
    RAISE EXCEPTION 'Amount must be a whole number of at least 1' USING ERRCODE = '22023'; END IF;

  SELECT ip.investor_id, ip.investment_amount, ip.roi_percentage
    INTO v_investor, v_principal, v_pct
    FROM public.investor_portfolios ip WHERE ip.id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND OR v_investor IS NULL THEN
    RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = 'P0002'; END IF;
  v_cycle_returns := round(coalesce(v_principal, 0) * coalesce(v_pct, 0) / 100);
  IF p_amount > v_cycle_returns THEN
    RAISE EXCEPTION 'Amount exceeds one cycle of Returns for this portfolio' USING ERRCODE = '22023'; END IF;

  v_keep := p_operation = 'split_keep_returns';
  v_recipient := v_investor;
  IF v_keep THEN
    SELECT CASE WHEN pa.is_managed_account THEN pa.agent_id ELSE v_investor END
      INTO v_recipient
      FROM public.proxy_agent_assignments pa
     WHERE pa.beneficiary_id = v_investor AND pa.is_active AND pa.approval_status = 'approved'
     ORDER BY pa.is_managed_account DESC, pa.created_at DESC
     LIMIT 1;
    v_recipient := coalesce(v_recipient, v_investor);
  END IF;

  RETURN public.create_ledger_transaction(
    entries => jsonb_build_array(
      jsonb_build_object(
        'user_id', v_investor, 'ledger_scope', 'platform', 'direction', 'cash_out',
        'amount', p_amount, 'category', 'roi_expense',
        'description', p_description_out, 'reference_id', p_reference,
        'source_table', 'investor_portfolios', 'source_id', p_portfolio_id,
        'linked_party', v_actor, 'currency', 'UGX'),
      CASE WHEN v_keep THEN jsonb_build_object(
        'user_id', v_recipient, 'ledger_scope', 'wallet', 'direction', 'cash_in',
        'amount', p_amount, 'category', 'roi_wallet_credit',
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'description', p_description_in, 'reference_id', p_reference,
        'source_table', 'investor_portfolios', 'source_id', p_portfolio_id,
        'linked_party', v_investor, 'currency', 'UGX')
      ELSE jsonb_build_object(
        'user_id', v_investor, 'ledger_scope', 'platform', 'direction', 'cash_in',
        'amount', p_amount, 'category', 'roi_reinvestment',
        'description', p_description_in, 'reference_id', p_reference,
        'source_table', 'investor_portfolios', 'source_id', p_portfolio_id,
        'linked_party', CASE WHEN p_operation = 'compound' THEN v_actor ELSE v_investor END,
        'currency', 'UGX')
      END),
    idempotency_key => 'portfolio-roi-ledger:' || p_reference);
END $function$
;

DROP FUNCTION IF EXISTS public.post_portfolio_roi_ledger(text, uuid, numeric, text, text, text, date, uuid);
DROP FUNCTION IF EXISTS public.claim_return_cycle_for_operation(uuid);
DROP FUNCTION IF EXISTS public.authorise_return_cycle_override(uuid, date, uuid, text);
DROP FUNCTION IF EXISTS public._post_portfolio_roi_ledger_core(text, uuid, numeric, text, text, text, date, uuid, boolean);
DROP FUNCTION IF EXISTS public.revoke_return_cycle_override(uuid, text);
DROP FUNCTION IF EXISTS public.release_return_cycle_claim_on_status();
DROP FUNCTION IF EXISTS public.enforce_return_cycle_ledger_key();
DROP FUNCTION IF EXISTS public._return_cycle_claim_for_operation_row(public.pending_wallet_operations, boolean);
DROP FUNCTION IF EXISTS public._claim_return_cycle(uuid, date, text, text, text, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public._return_cycle_can_request(uuid);
