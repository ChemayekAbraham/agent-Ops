
-- Attach NIWAGABA METHOD (proxy partner with a CFO-approved ROI payout today
-- but no proxy custody link) to the proxy agent Kabahuma Lillian, who already
-- handles the sibling partners. Non-managed: ROI stays in the partner's own
-- wallet and the agent withdraws on their behalf (custody v2 / branch B).
-- Idempotent: only inserts when no assignment exists for this beneficiary.
INSERT INTO public.proxy_agent_assignments (
  agent_id, beneficiary_id, beneficiary_role, assigned_by, reason,
  is_active, is_managed_account, approval_status, approved_by, approved_at
)
SELECT
  '5f277e34-a830-4ebb-8680-c0c074b279da'::uuid,  -- agent: Kabahuma Lillian
  'db54c0a2-9446-4958-adb3-80be7df36694'::uuid,  -- beneficiary: NIWAGABA METHOD
  'supporter',
  '5f277e34-a830-4ebb-8680-c0c074b279da'::uuid,
  'Proxy custody link so CFO-approved ROI appears in agent proxy list',
  true, false, 'approved',
  '5f277e34-a830-4ebb-8680-c0c074b279da'::uuid, now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.proxy_agent_assignments
  WHERE beneficiary_id = 'db54c0a2-9446-4958-adb3-80be7df36694'::uuid
);
