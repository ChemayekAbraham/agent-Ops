ALTER TABLE public.deposit_requests
ADD COLUMN IF NOT EXISTS purpose_audit jsonb;

COMMENT ON COLUMN public.deposit_requests.purpose_audit IS
'Audit trail for the deposit purpose choice. Shape: { chosen_purpose, chosen_at (ISO), chosen_by (user_id), entry_point ("gate"|"default"|"in_form"), required_choice (bool) }. Captured at submission time.';

CREATE INDEX IF NOT EXISTS idx_deposit_requests_purpose_audit_chosen_at
ON public.deposit_requests ((purpose_audit->>'chosen_at'))
WHERE purpose_audit IS NOT NULL;