DO $mig$
DECLARE
  r record;
BEGIN
  PERFORM set_config('statement_timeout', '300s', true);
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  FOR r IN
    SELECT ca.agent_id,
           COALESCE(SUM(CASE WHEN g.direction IN ('cash_in','credit') THEN g.amount ELSE -g.amount END), 0) AS books
    FROM public.cashout_agents ca
    LEFT JOIN public.general_ledger g
      ON g.user_id = ca.agent_id
     AND g.ledger_scope = 'wallet'
     AND g.wallet_bucket = 'float'
     AND (
       g.classification IS NULL
       OR g.classification = 'production'
       OR (
         g.classification = 'admin_correction'
         AND g.category = 'system_balance_correction'
         AND g.direction = ANY (ARRAY['debit','cash_out'])
       )
     )
    WHERE ca.agent_id IS NOT NULL
    GROUP BY ca.agent_id
  LOOP
    UPDATE public.wallet_balances_projection p
       SET float_balance = GREATEST(0, r.books),
           total_visible = GREATEST(0, p.withdrawable) + GREATEST(0, r.books),
           ledger_version = p.ledger_version + 1,
           updated_at = now()
     WHERE p.user_id = r.agent_id
       AND p.float_balance IS DISTINCT FROM GREATEST(0, r.books);
  END LOOP;
END
$mig$;