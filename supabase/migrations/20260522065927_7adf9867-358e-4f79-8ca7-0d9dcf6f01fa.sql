-- Detach 4 proxy portfolios from ATUHAIRE CAROLYNE (agent linkage) so the
-- portfolios belong solely to their respective partners. Going forward the
-- COOPartnersPage delete handler will also do this automatically instead of
-- hard-deleting proxy entries.
UPDATE public.investor_portfolios
SET agent_id = investor_id
WHERE id IN (
  'b636e5b2-7441-48c3-a178-28bb7638ecbd', -- KISAKYE RUTH LUNKUSE  WPF-7675
  'b2a025c5-c52c-453f-91c3-00bae225ac34', -- MAWANDA Gerald        WPF-6040
  'f03a5281-4158-4bcb-83ba-fe04ddfcc025', -- JULIAN BERTLIN        WIP2604144694 (JULIAN 2)
  '3132fdb2-705f-4856-88e0-f4cebe41ab4f'  -- JULIAN BERTLIN        WIP2604149167 (JULIAN 3)
)
  AND agent_id = 'ae194750-4827-47e8-839e-5e772565138b'
  AND investor_id IS NOT NULL
  AND investor_id <> agent_id;

-- Audit trail
INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
SELECT
  investor_id,
  'portfolio_proxy_unlinked',
  'investor_portfolios',
  id,
  jsonb_build_object(
    'portfolio_code', portfolio_code,
    'previous_agent_id', 'ae194750-4827-47e8-839e-5e772565138b',
    'previous_agent_name', 'ATUHAIRE CAROLYNE',
    'reason', 'Detach proxy linkage so partner-ops account cleanup cannot cascade-delete the partner''s portfolio',
    'migrated_by', 'system_migration_2026_05_22'
  )
FROM public.investor_portfolios
WHERE id IN (
  'b636e5b2-7441-48c3-a178-28bb7638ecbd',
  'b2a025c5-c52c-453f-91c3-00bae225ac34',
  'f03a5281-4158-4bcb-83ba-fe04ddfcc025',
  '3132fdb2-705f-4856-88e0-f4cebe41ab4f'
);
