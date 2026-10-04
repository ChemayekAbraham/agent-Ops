UPDATE public.investor_portfolios ip
SET agent_id = ip.investor_id
WHERE ip.agent_id IS NOT NULL
  AND ip.investor_id IS NOT NULL
  AND ip.agent_id <> ip.investor_id
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = ip.agent_id
      AND ur.role IN ('coo','manager','operations','super_admin')
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur2
    WHERE ur2.user_id = ip.agent_id AND ur2.role = 'agent'
  );