-- Refuse permanent deletion of any account with financial history.
-- account_financial_history counts every money record linked to a user; any count above zero
-- means the account may only be soft deleted or archived, never purged.

CREATE OR REPLACE FUNCTION public.account_financial_history(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $body$
DECLARE
  v jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;
  SELECT jsonb_build_object(
    'ledger_rows',            (SELECT count(*) FROM public.general_ledger g WHERE g.user_id = p_user_id),
    'wallet_nonzero',         (SELECT count(*) FROM public.wallets w WHERE w.user_id = p_user_id AND coalesce(w.balance, 0) <> 0),
    'agent_advances',         (SELECT count(*) FROM public.agent_advances a WHERE a.agent_id = p_user_id OR a.issued_by = p_user_id),
    'agent_advance_requests', (SELECT count(*) FROM public.agent_advance_requests r WHERE r.agent_id = p_user_id),
    'portfolios',             (SELECT count(*) FROM public.investor_portfolios ip WHERE ip.investor_id = p_user_id OR ip.agent_id = p_user_id),
    'rent_requests',          (SELECT count(*) FROM public.rent_requests rr WHERE rr.tenant_id = p_user_id OR rr.agent_id = p_user_id OR rr.landlord_id = p_user_id OR rr.supporter_id = p_user_id),
    'withdrawals',            (SELECT count(*) FROM public.withdrawal_requests wr WHERE wr.user_id = p_user_id),
    'deposits',               (SELECT count(*) FROM public.deposit_requests dr WHERE dr.user_id = p_user_id),
    'credit_draws',           (SELECT count(*) FROM public.credit_access_draws cd WHERE cd.user_id = p_user_id OR cd.agent_id = p_user_id),
    'wallet_transfers',       (SELECT count(*) FROM public.wallet_transactions wt WHERE wt.sender_id = p_user_id OR wt.recipient_id = p_user_id)
  ) INTO v;
  RETURN v || jsonb_build_object('has_history',
    EXISTS (SELECT 1 FROM jsonb_each_text(v) e WHERE e.value::bigint > 0));
END;
$body$;

REVOKE ALL ON FUNCTION public.account_financial_history(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.account_financial_history(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.account_financial_history(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.account_financial_history(uuid) TO service_role;

DO $mig$
DECLARE
  v_src text;
  v_def text;
  v_pre text;
  v_new text;
  c_guard constant text :=
$g$  IF (public.account_financial_history(p_user_id) ->> 'has_history')::boolean THEN
    RAISE EXCEPTION 'Account % has financial history and cannot be permanently deleted. Use soft delete instead.', p_user_id
      USING ERRCODE = 'P0001';
  END IF;

$g$;
BEGIN
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'admin_purge_user_dependencies') <> 1 THEN
    RAISE EXCEPTION 'admin_purge_user_dependencies not found exactly once - stopping';
  END IF;
  SELECT p.prosrc, pg_get_functiondef(p.oid) INTO v_src, v_def
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'admin_purge_user_dependencies';
  IF md5(v_src) <> 'a0daf05af88044041eacd51235b152f7' THEN
    RAISE EXCEPTION 'admin_purge_user_dependencies has changed since it was reviewed (current md5 %) - stopping', md5(v_src);
  END IF;
  v_pre := (regexp_match(v_src, '^(.*?\n[ \t]*BEGIN[ \t]*\n)', 'is'))[1];
  IF v_pre IS NULL THEN
    RAISE EXCEPTION 'admin_purge_user_dependencies has no main BEGIN line - stopping';
  END IF;
  v_new := v_pre || c_guard || substr(v_src, length(v_pre) + 1);
  IF (length(v_def) - length(replace(v_def, v_src, ''))) / length(v_src) <> 1 THEN
    RAISE EXCEPTION 'admin_purge_user_dependencies body not found exactly once - stopping';
  END IF;
  EXECUTE replace(v_def, v_src, v_new);
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'admin_purge_user_dependencies';
  IF md5(v_src) <> md5(v_new) THEN
    RAISE EXCEPTION 'admin_purge_user_dependencies did not take the new guard - stopping';
  END IF;
END
$mig$;