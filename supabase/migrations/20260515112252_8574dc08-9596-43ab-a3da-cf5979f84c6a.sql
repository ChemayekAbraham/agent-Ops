ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS processing_started_by uuid NULL;

COMMENT ON COLUMN public.withdrawal_requests.processing_started_at IS
  'Set when approve-withdrawal compare-and-set claims the row (status -> processing). Cleared on rollback.';
COMMENT ON COLUMN public.withdrawal_requests.processing_started_by IS
  'Operator (auth.uid) that claimed the row. Used to attribute concurrent-approval blocks.';