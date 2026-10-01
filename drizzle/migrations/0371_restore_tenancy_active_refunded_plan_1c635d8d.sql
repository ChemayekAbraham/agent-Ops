-- Plan 1c635d8d was reverted (tenant_cancelled_float_returned) and re-funded on 28 Sep.
-- The revert set tenancy_status='terminated'; re-funding did not reset it, so the live,
-- repaying plan was excluded from the daily schedule and the agent's target became 0.
UPDATE public.rent_requests
   SET tenancy_status = 'active'
 WHERE id = '1c635d8d-7ecf-45a9-bdc0-c64dd946a1a0'
   AND status = 'repaying'
   AND tenancy_status = 'terminated'
   AND tenancy_ended_at IS NULL;

INSERT INTO public.system_events (event_type, related_entity_type, related_entity_id, metadata)
SELECT 'rent_request.tenancy_status_restored', 'rent_request', '1c635d8d-7ecf-45a9-bdc0-c64dd946a1a0'::uuid,
       jsonb_build_object('from','terminated','to','active',
         'reason','Stale terminated flag left by 28 Sep revert; plan was re-funded and is repaying')
WHERE NOT EXISTS (SELECT 1 FROM public.system_events WHERE event_type='rent_request.tenancy_status_restored'
                  AND related_entity_id='1c635d8d-7ecf-45a9-bdc0-c64dd946a1a0'::uuid);

SELECT public.pin_agent_expected_day((now() AT TIME ZONE 'Africa/Kampala')::date);