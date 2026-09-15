-- Security: only the payout-approval backend (service role) may write OCR
-- verification records. Previously any authenticated user could insert
-- fabricated rows against arbitrary withdrawal_request_id values, polluting the
-- audit trail finance staff rely on. The only writer in the codebase is the
-- approve-withdrawal edge function, which uses the service role.
DROP POLICY IF EXISTS "Authenticated can write payout proof ocr log" ON public.payout_proof_ocr_log;

REVOKE INSERT, UPDATE, DELETE ON public.payout_proof_ocr_log FROM authenticated;
GRANT SELECT ON public.payout_proof_ocr_log TO authenticated;
GRANT ALL ON public.payout_proof_ocr_log TO service_role;