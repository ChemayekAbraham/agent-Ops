-- Bank-transfer payouts file merchant out-of-pocket claims again (doc 226).
--
-- 20260925140500 (doc 134) made classify_merchant_payout_funding treat every
-- completed bank_transfer payout that float did not cover as treasury-funded:
-- no receivable, and it DELETES open pending_reimbursement / needs_review rows
-- for that withdrawal. Josh (2026-10-14): bank payouts must file claims like
-- MoMo. approve-withdrawal stopped skipping them in the same change; without
-- this migration the classifier would delete the rows it files.
--
-- Change: v_treasury_bank can never be true, so bank payouts take the same
-- branch as MoMo. Applied as a string replace on the LIVE definition instead
-- of a copied body, because the repo migrations do not faithfully match
-- production. Fails loudly if the marker is not found exactly once.
-- Forward effect only; closed/rejected rows are not reopened.
-- Verified live 2026-10-14: not in critical_function_baselines, marker present once.

DO $mig$
DECLARE
  v_def text;
  v_new text;
  v_marker constant text := E'AND COALESCE(w.payout_method, '''') = ''bank_transfer''';
BEGIN
  v_def := pg_get_functiondef('public.classify_merchant_payout_funding(uuid,text)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_marker, ''))) / length(v_marker) <> 1 THEN
    RAISE EXCEPTION 'classify_merchant_payout_funding: bank_transfer marker not found exactly once';
  END IF;
  v_new := replace(v_def, v_marker, 'AND false /* doc 226: bank payouts file claims */');
  EXECUTE v_new;
END
$mig$;
