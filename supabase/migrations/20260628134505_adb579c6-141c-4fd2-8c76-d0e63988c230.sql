-- Drill-down: return every general_ledger row tied to a single cash-out
-- withdrawal (customer debit, platform credit, merchant principal
-- reimbursement legs, and 0.5% commission legs) for the Financial Ops
-- Cash-Out Settlement Timeline click-through panel. SECURITY DEFINER so Fin
-- Ops can audit rows belonging to other users despite strict ledger RLS.
CREATE OR REPLACE FUNCTION public.get_cashout_settlement_ledger_rows(
  p_withdrawal_id uuid
)
RETURNS TABLE (
  id uuid,
  transaction_date timestamptz,
  direction text,
  category text,
  ledger_scope text,
  wallet_bucket text,
  amount numeric,
  user_id uuid,
  party_name text,
  reference_id text,
  description text,
  leg text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    gl.id,
    gl.transaction_date,
    gl.direction,
    gl.category,
    gl.ledger_scope,
    gl.wallet_bucket,
    gl.amount,
    gl.user_id,
    p.full_name AS party_name,
    gl.reference_id,
    gl.description,
    CASE
      WHEN gl.reference_id LIKE '%-merchant-reimbursement' THEN 'reimbursement'
      WHEN gl.reference_id LIKE '%-cashout-commission' THEN 'commission'
      ELSE 'withdrawal'
    END AS leg
  FROM public.general_ledger gl
  LEFT JOIN public.profiles p ON p.id = gl.user_id
  WHERE gl.source_table = 'withdrawal_requests'
    AND gl.source_id = p_withdrawal_id
  ORDER BY gl.transaction_date ASC, gl.ledger_scope ASC, gl.direction ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_cashout_settlement_ledger_rows(uuid) TO authenticated, service_role;