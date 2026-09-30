CREATE OR REPLACE FUNCTION public.agent_ops_shopping_advance_qualified_senders()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM public.user_roles r
    WHERE r.user_id = auth.uid()
      AND r.enabled = true
      AND r.role IN ('agent_ops', 'manager', 'super_admin', 'coo', 'ceo', 'operations')
  ) THEN (
    SELECT count(*)::bigint FROM (
      SELECT w.sender_id AS user_id
      FROM public.wallet_transactions w
      WHERE w.sender_id IS NOT NULL AND w.recipient_id IS NOT NULL
        AND w.sender_id <> w.recipient_id AND w.amount > 0
      UNION
      SELECT l.user_id
      FROM public.general_ledger l
      WHERE l.user_id IS NOT NULL AND l.amount > 0
        AND l.ledger_scope = 'wallet' AND l.category = 'wallet_transfer'
        AND l.direction = 'cash_out' AND l.source_table = 'wallet_transactions'
    ) senders
  ) ELSE NULL::bigint END;
$$;
REVOKE ALL ON FUNCTION public.agent_ops_shopping_advance_qualified_senders() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_ops_shopping_advance_qualified_senders() TO authenticated;
COMMENT ON FUNCTION public.agent_ops_shopping_advance_qualified_senders() IS 'Read-only count of distinct senders of positive peer wallet transfers, across historical wallet_transactions and current ledger entries; restricted to Agent Ops and executive operators. Does not grant or issue an advance.';