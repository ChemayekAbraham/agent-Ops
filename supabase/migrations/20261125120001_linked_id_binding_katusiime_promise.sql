-- Let Katusiime Promise's active National ID link count at the withdrawal ID gate (doc 273).
-- Requester: Katusiime Promise (1eaa4087-a367-463a-8bb0-aba1ed59524f), no National ID of her own
-- Holder:    PROMISE KATUSIIME (ffadf3bf-8ec7-46b0-b347-a8da55a443a7), National ID CF0001010FQEAA
-- Link:      c554ec95-c650-411d-9132-0576574d1643 (staff-created, active since 2026-11-15 12:25 UTC)
--
-- withdrawal_user_id_verified__impl accepts a linked account only when its identity
-- binding has capture_source = 'linked_id_owner'. Her binding (6f94a83a-...) was written
-- on 2026-10-29 as 'user_capture', so the active link was ignored and the gate stayed false.
-- This retags that one row. capture_source is not an immutable field
-- (identity_binding_immutable_guard), and no ID number, photo or payout number changes.
-- No money moves. Guarded and idempotent: only runs while the link is still active.

DO $m$
DECLARE v_n integer;
BEGIN
  UPDATE public.user_identity_bindings b
     SET capture_source = 'linked_id_owner'
   WHERE b.id = '6f94a83a-4d1f-4c69-98dc-81c67080da59'
     AND b.user_id = '1eaa4087-a367-463a-8bb0-aba1ed59524f'
     AND b.capture_source = 'user_capture'
     AND b.status <> 'revoked'
     AND btrim(coalesce(b.linked_national_id, '')) = 'CF0001010FQEAA'
     AND EXISTS (
       SELECT 1 FROM public.national_id_link_requests l
        WHERE l.id = 'c554ec95-c650-411d-9132-0576574d1643'
          AND l.requester_id = '1eaa4087-a367-463a-8bb0-aba1ed59524f'
          AND l.holder_id = 'ffadf3bf-8ec7-46b0-b347-a8da55a443a7'
          AND l.status = 'active');
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n = 1 THEN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (NULL, 'identity_binding_retagged_linked_id_owner', 'user_identity_bindings',
            '6f94a83a-4d1f-4c69-98dc-81c67080da59',
            'Active National ID link c554ec95 was ignored by the withdrawal ID gate because the binding was tagged user_capture. Retagged on CTO request (doc 273).',
            jsonb_build_object('user_id','1eaa4087-a367-463a-8bb0-aba1ed59524f',
                               'link_id','c554ec95-c650-411d-9132-0576574d1643',
                               'previous_capture_source','user_capture',
                               'new_capture_source','linked_id_owner'));
  END IF;
END
$m$;
