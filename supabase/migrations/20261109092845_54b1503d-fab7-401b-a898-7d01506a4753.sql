-- One-time correction: Active signages without both CFO initial payments go back to Awaiting CFO.
DO $$
DECLARE r record;
BEGIN
  ALTER TABLE public.welile_signages DISABLE TRIGGER USER;
  FOR r IN
    SELECT s.id, s.agent_id FROM public.welile_signages s
    WHERE s.status = 'active'
      AND (NOT EXISTS (SELECT 1 FROM public.welile_signage_payments p WHERE p.signage_id = s.id AND p.payout_type = 'agent_reward' AND p.period_index = 0)
        OR NOT EXISTS (SELECT 1 FROM public.welile_signage_payments p WHERE p.signage_id = s.id AND p.payout_type = 'owner_rent' AND p.period_index = 0))
    FOR UPDATE
  LOOP
    UPDATE public.welile_signages
       SET status = 'awaiting_cfo', activated_at = NULL, owner_rent_due_at = NULL, updated_at = now()
     WHERE id = r.id;
    INSERT INTO public.welile_signage_status_events(signage_id, from_status, to_status, changed_by, note)
    VALUES (r.id, 'active', 'awaiting_cfo', NULL, 'Correction: activated before CFO paid the agent reward and first owner rent');
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, metadata, actor_id)
    VALUES ('welile_signage_status_changed', r.agent_id, 'welile_signages', r.id,
            jsonb_build_object('from_status','active','to_status','awaiting_cfo','correction','unpaid_initial_payments'), NULL);
    INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, reason, old_values, new_values, performed_by)
    VALUES (NULL, 'signage_status_changed', 'welile_signages', r.id,
            'Correction: signage was Active without CFO disbursement of both initial payments; returned to Awaiting CFO',
            jsonb_build_object('status','active'), jsonb_build_object('status','awaiting_cfo'), NULL);
  END LOOP;
  ALTER TABLE public.welile_signages ENABLE TRIGGER USER;
END $$;