-- Full-payment merchandise purchases: allow + map the platform leg category and make the post idempotent.
-- agent_purchase_merchandise (p_payment_mode = 'full') posts a wallet leg (agent_repayment, cash_out,
-- withdrawable) and a platform leg (merchandise_revenue, cash_in). Under treasury_controls.strict_mode the
-- platform leg is rejected because merchandise_revenue is not in ledger_category_allowlist(), so the whole
-- order rolls back and the buyer's wallet is never debited. No ledger, wallet or order rows are modified here.

-- 1. Accounting policy: the platform cash_in leg credits R1 Platform Revenue (debit_when = cash_out).
INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
VALUES ('platform', 'merchandise_revenue', NULL, 'R1', 'cash_out',
        'Revenue from merchandise paid in full from the agent wallet. Post cash_in to CREDIT R1.')
ON CONFLICT (ledger_scope, category, COALESCE(wallet_bucket, '*')) DO UPDATE
  SET account_code = EXCLUDED.account_code,
      debit_when   = EXCLUDED.debit_when,
      notes        = EXCLUDED.notes;

-- 2. Strict-mode allowlist: read the LIVE list and add one category. Nothing is retyped, so no
--    existing category can be dropped. Aborts if the allowlist is built from a base function, because
--    replacing the outer function would then be overwritten or bypassed.
DO $do$
DECLARE v_cur text[]; v_all text[];
BEGIN
  IF to_regprocedure('public.ledger_category_allowlist_base()') IS NOT NULL THEN
    RAISE EXCEPTION 'ledger_category_allowlist_base() exists live: add merchandise_revenue there instead';
  END IF;
  SELECT public.ledger_category_allowlist() INTO v_cur;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_all FROM unnest(v_cur || ARRAY['merchandise_revenue']) AS x;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.ledger_category_allowlist() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path TO ''public'' AS $f$ SELECT %L::text[] $f$',
    v_all);
END
$do$;

-- 3. Idempotency: patch the LIVE agent_purchase_merchandise (which 0500 already patched) instead of
--    replacing it from an old file. Aborts unless the anchor matches exactly once.
DO $p$
DECLARE d text; n text; v_pat constant text := 'PERFORM\s+public\.create_ledger_transaction\(\s*entries\s*=>';
BEGIN
  d := pg_get_functiondef('public.agent_purchase_merchandise(uuid,integer,text,text)'::regprocedure);
  IF position('merch_purchase_' in d) > 0 THEN RETURN; END IF;
  IF (SELECT count(*) FROM regexp_matches(d, v_pat, 'g')) <> 1 THEN
    RAISE EXCEPTION 'agent_purchase_merchandise: create_ledger_transaction anchor mismatch';
  END IF;
  n := regexp_replace(d, v_pat,
    'PERFORM public.create_ledger_transaction(idempotency_key => ''merch_purchase_'' || v_sale_id::text, entries =>');
  EXECUTE n;
END
$p$;

-- 4. Built-in checks: abort the whole migration on any failure.
DO $chk$
BEGIN
  IF NOT ('merchandise_revenue' = ANY (public.ledger_category_allowlist())) THEN
    RAISE EXCEPTION 'merchandise_revenue missing from allowlist';
  END IF;
  IF (SELECT count(*) FROM public.ledger_account_map WHERE category = 'merchandise_revenue') <> 1
     OR NOT EXISTS (SELECT 1 FROM public.ledger_account_map
                    WHERE category = 'merchandise_revenue' AND ledger_scope = 'platform'
                      AND account_code = 'R1' AND debit_when = 'cash_out') THEN
    RAISE EXCEPTION 'merchandise_revenue mapping missing or duplicated';
  END IF;
  IF position('merch_purchase_' in pg_get_functiondef('public.agent_purchase_merchandise(uuid,integer,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'agent_purchase_merchandise idempotency key missing';
  END IF;
END
$chk$;
