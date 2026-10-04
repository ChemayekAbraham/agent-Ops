
WITH updated AS (
  UPDATE public.rent_requests
  SET agent_id = NULL,
      assigned_agent_id = NULL
  WHERE id IN (
    '74205c05-523c-43dc-b799-e144bfcd942f',
    '2fe85f01-112f-4316-a774-635b88a605da'
  )
  AND agent_id = '1409e6e0-89e7-46a6-89c8-feb3207b1df9'
  RETURNING id, tenant_id
)
INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
SELECT
  '1409e6e0-89e7-46a6-89c8-feb3207b1df9',
  'detach_agent_attribution',
  'Detach rent_request from agent (NotHisTnts)',
  'rent_requests',
  u.id,
  jsonb_build_object(
    'reason', 'NotHisTnts',
    'previous_agent_id', '1409e6e0-89e7-46a6-89c8-feb3207b1df9',
    'previous_agent_name', 'Saka Melvin',
    'tenant_id', u.tenant_id,
    'note', 'Agent claims these tenants are not his; referral rows already removed. Clearing rent_requests.agent_id to remove from his dashboard.'
  )
FROM updated u;
