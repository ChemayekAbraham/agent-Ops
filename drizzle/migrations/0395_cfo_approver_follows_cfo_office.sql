-- is_cfo_approver now follows the Chief Finance Officer office and the two named super admins,
-- the same rule as can_act_pinned_finance_action. The cfo_approval_approvers table is no longer
-- consulted; it is kept only as a historical record. Signature unchanged, so every existing
-- caller (13 database functions and the edge functions using cfoApprovalGate.ts) follows automatically.

CREATE OR REPLACE FUNCTION public.is_cfo_approver(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.can_act_pinned_finance_action(_user_id)
$$;

COMMENT ON FUNCTION public.is_cfo_approver(uuid) IS
'Delegates to can_act_pinned_finance_action: true for whoever currently holds the Chief Finance Officer office, or a named super admin in pinned_finance_action_super_admins who still holds super_admin. cfo_approval_approvers is no longer consulted.';