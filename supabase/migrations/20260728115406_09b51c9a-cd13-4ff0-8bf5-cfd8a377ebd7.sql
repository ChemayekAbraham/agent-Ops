UPDATE public.withdrawal_requests
SET status = 'rejected',
    rejection_reason = 'Returned to wallet per agent request (Saka Melvin)',
    processed_at = now(),
    updated_at = now()
WHERE id = '9795249d-37d1-4cb7-8b72-09b19dc88b30'
  AND status = 'pending';