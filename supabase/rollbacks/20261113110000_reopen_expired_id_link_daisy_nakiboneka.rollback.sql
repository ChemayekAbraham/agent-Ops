-- Rolls back 20261113110000_reopen_expired_id_link_daisy_nakiboneka.sql
-- Puts the request back to 'expired' ONLY if it is still awaiting staff (owner_approved,
-- never staff-decided). If FinOps already confirmed it (status 'active'), this does nothing.
UPDATE public.national_id_link_requests
   SET status = 'expired', expires_at = '2026-11-05 07:29:05.792971+00', updated_at = now()
 WHERE id = 'ce43daa8-ad61-42d2-b0f6-e05f2ca9afae'
   AND status = 'owner_approved'
   AND staff_decided_at IS NULL;
