ALTER TABLE public.special_advances DROP CONSTRAINT special_advances_payout_method_check;
ALTER TABLE public.special_advances ADD CONSTRAINT special_advances_payout_method_check CHECK (payout_method IS NULL OR payout_method IN ('wallet','mobile_money','bank_transfer') OR (payout_method='cash' AND decision_reason='Recorded already-issued outside-Welile advance; no new payment'));
ALTER TABLE public.special_advances DROP CONSTRAINT special_advances_payout_record;
ALTER TABLE public.special_advances ADD CONSTRAINT special_advances_payout_record CHECK (
 status NOT IN ('disbursed','settled','reversed','written_off') OR (
 payout_method IS NOT NULL AND payout_ledger_group_id IS NOT NULL AND (
 ((payout_method='wallet')=(borrower_kind='welile_user') AND (payout_method='wallet' OR (payout_reference IS NOT NULL AND payout_proof_path IS NOT NULL)) AND (payout_method<>'wallet' OR payout_proof_path IS NULL))
 OR (decision_reason='Recorded already-issued outside-Welile advance; no new payment' AND payout_method IN ('mobile_money','bank_transfer','cash') AND payout_reference IS NOT NULL AND payout_proof_path IS NOT NULL)
 )));