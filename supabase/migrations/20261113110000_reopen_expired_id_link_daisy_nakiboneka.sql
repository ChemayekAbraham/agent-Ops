-- Re-open ONE expired National ID link request so FinOps can confirm it.
-- Requester: Daisy Liz Nakiboneka (7610e3ea-4d0c-4389-abff-ccc94a06dc7e)
-- Holder:    NSUBUGA Lawrence George (5631cfe1-14b0-4ce2-9b9a-f7a808d3b12d)
-- Request:   ce43daa8-ad61-42d2-b0f6-e05f2ca9afae
--
-- The holder approved by SMS code on 2026-10-29; staff never confirmed; the 7-day
-- window closed on 2026-11-05 and national_id_link_expire_stale() set it to 'expired'.
-- This puts it back to 'owner_approved' with a fresh 7-day window. It does NOT make the
-- link active and does NOT touch the withdrawal: a FinOps person must still confirm it
-- (national_id_link_staff_confirm) in Verify Payout Numbers.
-- Guarded: only moves the row if it is still exactly the expired, holder-approved,
-- never-staff-decided request described above. Idempotent.

DO $m$
DECLARE v_n integer;
BEGIN
  UPDATE public.national_id_link_requests
     SET status = 'owner_approved',
         expires_at = now() + interval '7 days',
         updated_at = now()
   WHERE id = 'ce43daa8-ad61-42d2-b0f6-e05f2ca9afae'
     AND requester_id = '7610e3ea-4d0c-4389-abff-ccc94a06dc7e'
     AND holder_id = '5631cfe1-14b0-4ce2-9b9a-f7a808d3b12d'
     AND status = 'expired'
     AND owner_decision = 'approved'
     AND staff_decided_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n = 1 THEN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (NULL, 'national_id_link_reopened_for_staff_review', 'national_id_link_requests',
            'ce43daa8-ad61-42d2-b0f6-e05f2ca9afae',
            'Holder approved 2026-10-29; request expired 2026-11-05 before staff reviewed it. Re-opened for FinOps confirmation (doc 269).',
            jsonb_build_object('requester_id','7610e3ea-4d0c-4389-abff-ccc94a06dc7e',
                               'previous_status','expired','new_status','owner_approved'));
  END IF;
END
$m$;
