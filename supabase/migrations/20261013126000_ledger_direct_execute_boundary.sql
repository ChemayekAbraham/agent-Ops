-- Ledger posting boundary: no signed-in user may call create_ledger_transaction*
-- directly.
--
-- NOT APPLIED TO PRODUCTION. Deploy only together with the COOPartnersPage
-- change that switches its three postings to post_portfolio_roi_ledger();
-- applied alone, that page's Returns compounding stops working.
--
-- PROBLEM (Issue A). create_ledger_transaction(entries, idempotency_key,
-- skip_balance_check) is SECURITY DEFINER, sets ledger.authorized itself and
-- has no caller check. The repo never revokes it, so Supabase's default
-- privileges leave it executable by `authenticated`. That is confirmed by
-- COOPartnersPage.tsx, which calls it with the user's own session. Any
-- signed-in user could therefore post arbitrary balanced entries and pass
-- skip_balance_check = true. create_ledger_transaction_accrual_only(jsonb)
-- is explicitly granted to `authenticated` and forwards arbitrary
-- platform-scope entries the same way.
--
-- FIX.
--  1. post_portfolio_roi_ledger(): a SECURITY DEFINER boundary for the ONLY
--     ledger postings the browser makes (COO / Partners Ops Returns
--     compounding and split payouts). The caller supplies an operation name,
--     not ledger entries. The function:
--       * checks the caller (COO-dashboard role or an active coo /
--         partner-ops staff grant);
--       * requires the portfolio to exist, with a partner;
--       * bounds the amount by the portfolio's own Returns for one cycle;
--       * decides the recipient itself (the partner, or for Keep-as-Returns
--         the partner's active managed proxy agent);
--       * builds exactly the legs the page used to send;
--       * posts with an idempotency key derived from the reference;
--       * never passes skip_balance_check.
--  2. EXECUTE on every create_ledger_transaction* overload is revoked from
--     PUBLIC, anon and authenticated and granted to service_role explicitly.
--     No function DEFINITION is changed. Edge functions use the service role,
--     and SQL functions that post run as their owner, so neither is affected.
--
-- ROLLBACK: DROP FUNCTION post_portfolio_roi_ledger(text,uuid,numeric,text,text,text)
-- and _ledger_can_post_partner_returns(uuid); re-grant EXECUTE on the
-- create_ledger_transaction* overloads only if the old exposure is wanted
-- back (it should not be).

-- ═══════════════ who may post partner Returns ═══════════════
-- Mirrors the app's own gating:
--  * /coo/dashboard admits roles coo, super_admin and cto;
--  * the Executive Hub "Partners Ops" tab needs the staff grant 'partner-ops';
--  * COO screens can also be unlocked by the grant 'coo'.
-- Internal: not granted to anyone.
CREATE FUNCTION public._ledger_can_post_partner_returns(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT _user_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.user_roles ur
             WHERE ur.user_id = _user_id
               AND ur.role::text IN ('coo', 'super_admin', 'cto')
               AND COALESCE(ur.enabled, true))
    OR EXISTS (SELECT 1 FROM public.staff_permissions sp
                WHERE sp.user_id = _user_id
                  AND sp.permitted_dashboard IN ('coo', 'partner-ops')
                  AND sp.revoked_at IS NULL));
$$;
REVOKE ALL ON FUNCTION public._ledger_can_post_partner_returns(uuid) FROM PUBLIC, anon, authenticated;

-- ═══════════════ the boundary ═══════════════
-- p_operation:
--   'compound'           Returns reinvested into principal
--                        (roi_expense out, roi_reinvestment in; both platform scope)
--   'split_reinvest'     the reinvested part of a split payout (same legs)
--   'split_keep_returns' the kept part of a split payout: roi_expense out
--                        (platform) + roi_wallet_credit in (wallet, withdrawable)
--                        to the partner, or to the active managed proxy agent
--                        for a managed partner
-- The descriptions are display text only (<= 2000 characters each).
CREATE FUNCTION public.post_portfolio_roi_ledger(
  p_operation text, p_portfolio_id uuid, p_amount numeric, p_reference text,
  p_description_out text, p_description_in text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
  -- One cycle's Returns on the CURRENT principal. The page updates the
  -- principal before posting, so this is an upper bound, never an exact match.
  v_cycle_returns := round(coalesce(v_principal, 0) * coalesce(v_pct, 0) / 100);
  IF p_amount > v_cycle_returns THEN
    RAISE EXCEPTION 'Amount exceeds one cycle of Returns for this portfolio' USING ERRCODE = '22023'; END IF;

  v_keep := p_operation = 'split_keep_returns';
  v_recipient := v_investor;
  IF v_keep THEN
    -- Same rule as the page (resolveManagedProxy): approved and active, managed
    -- rows first, newest first. Only a MANAGED link redirects the credit.
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
END $$;
REVOKE ALL ON FUNCTION public.post_portfolio_roi_ledger(text,uuid,numeric,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_portfolio_roi_ledger(text,uuid,numeric,text,text,text) TO authenticated;

-- ═══════════════ close the direct path ═══════════════
-- Every overload, whatever its signature (the legacy 4-argument one is
-- reported to exist live). Fails closed if the canonical function is missing.
DO $rev$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
            WHERE ns.nspname = 'public' AND p.proname LIKE 'create\_ledger\_transaction%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    n := n + 1;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = 'create_ledger_transaction') THEN
    RAISE EXCEPTION 'create_ledger_transaction not found; refusing to continue';
  END IF;
  RAISE NOTICE 'ledger boundary: EXECUTE revoked from PUBLIC/anon/authenticated on % overload(s)', n;
END
$rev$;
