ALTER TABLE public.withdrawal_requests
ADD COLUMN IF NOT EXISTS client_request_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_requests_user_client_req_uq
ON public.withdrawal_requests (user_id, client_request_id)
WHERE client_request_id IS NOT NULL;