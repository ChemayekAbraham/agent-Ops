-- CFO: reconcile an agent advance's statement (agent_advance_ledger) against
-- the agent's wallet statement (general_ledger wallet debits), row for row.
--
-- Why: the 09-26/27 reinstatements (doc 139) and the fake manual clearances
-- before them left advance statements with rows that never touched the wallet
-- (a 500,000 "deduction" with no debit, +0/-0 rows that move the balance) and
-- balance jumps with no row at all. Doc 150 cleaned Ian Muhwezi's by hand; this
-- lets the CFO see, for any advance, whether every statement row is backed by
-- a wallet debit and where it is not.
--
-- Matching: a statement row with amount_deducted > 0 is backed when an unused
-- wallet cash_out (agent_repayment / agent_advance_repayment) for the same
-- agent has the same amount within 3 seconds. Matching is greedy and
-- one-to-one, so a burst of identical deductions in the same second (Okwakol,
-- 07-28: twenty 10,000 debits at 06:39:03) pairs correctly instead of all
-- statement rows claiming the first debit.
--
-- Read-only. Nothing here writes to the ledger or wallets.

CREATE OR REPLACE FUNCTION public.get_advance_wallet_reconciliation(p_advance_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_adv record;
  v_row record;
  v_prev_close numeric;
  v_used uuid[] := '{}';
  v_match uuid;
  v_issue text;
  v_rows jsonb := '[]'::jsonb;
  v_issues jsonb := '[]'::jsonb;
  v_total_repayable numeric;
  v_statement_deducted numeric := 0;
  v_wallet_backed numeric := 0;
  v_penalty numeric := 0;
  v_last_close numeric;
  v_first_at timestamptz;
  v_orphans jsonb;
  v_days jsonb;
BEGIN
  IF v_caller IS NOT NULL AND NOT (
       public.has_role(v_caller, 'cfo'::app_role)
    OR public.has_role(v_caller, 'ceo'::app_role)
    OR public.has_role(v_caller, 'coo'::app_role)
    OR public.has_role(v_caller, 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO, CEO, COO or Manager can view advance reconciliation';
  END IF;

  SELECT a.*, p.full_name, p.phone INTO v_adv
  FROM public.agent_advances a
  LEFT JOIN public.profiles p ON p.id = a.agent_id
  WHERE a.id = p_advance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Advance not found';
  END IF;

  SELECT min(created_at) INTO v_first_at FROM public.agent_advance_ledger WHERE advance_id = p_advance_id;

  FOR v_row IN
    SELECT l.* FROM public.agent_advance_ledger l
    WHERE l.advance_id = p_advance_id
    -- Rows written in one burst share a timestamp; within it the chain runs
    -- downward, so order by opening balance descending to follow it.
    ORDER BY l.created_at, l.opening_balance DESC, l.id
  LOOP
    IF v_total_repayable IS NULL THEN
      v_total_repayable := v_row.opening_balance;
    END IF;

    v_match := NULL;
    IF v_row.amount_deducted > 0 THEN
      SELECT g.id INTO v_match
      FROM public.general_ledger g
      WHERE g.user_id = v_adv.agent_id
        AND g.ledger_scope = 'wallet'
        AND g.direction = 'cash_out'
        AND g.category IN ('agent_repayment', 'agent_advance_repayment')
        AND g.amount = v_row.amount_deducted
        AND g.created_at BETWEEN v_row.created_at - interval '3 seconds' AND v_row.created_at + interval '3 seconds'
        AND NOT (g.id = ANY (v_used))
      ORDER BY abs(extract(epoch FROM g.created_at - v_row.created_at)), g.id
      LIMIT 1;
      IF v_match IS NOT NULL THEN
        v_used := v_used || v_match;
        v_wallet_backed := v_wallet_backed + v_row.amount_deducted;
      END IF;
    END IF;

    v_issue := NULL;
    IF v_prev_close IS NOT NULL AND abs(v_row.opening_balance - v_prev_close) >= 0.01 THEN
      v_issues := v_issues || jsonb_build_object(
        'kind', 'balance_jump', 'row_id', v_row.id, 'at', v_row.created_at,
        'amount', v_row.opening_balance - v_prev_close,
        'detail', 'Balance moved from ' || v_prev_close || ' to ' || v_row.opening_balance || ' with no statement row');
    END IF;
    IF v_row.amount_deducted > 0 AND v_match IS NULL THEN
      v_issue := 'deduction_without_wallet_debit';
      v_issues := v_issues || jsonb_build_object(
        'kind', v_issue, 'row_id', v_row.id, 'at', v_row.created_at,
        'amount', v_row.amount_deducted,
        'detail', 'Statement shows a deduction but nothing left the wallet');
    ELSIF v_row.amount_deducted = 0 AND v_row.interest_accrued = 0
          AND abs(v_row.closing_balance - v_row.opening_balance) >= 0.01 THEN
      v_issue := 'balance_change_without_amount';
      v_issues := v_issues || jsonb_build_object(
        'kind', v_issue, 'row_id', v_row.id, 'at', v_row.created_at,
        'amount', v_row.closing_balance - v_row.opening_balance,
        'detail', 'Row shows +0 / -0 but the balance changed (' || coalesce(v_row.recovery_source, '') || ')');
    ELSIF abs(v_row.closing_balance - (v_row.opening_balance + v_row.interest_accrued - v_row.amount_deducted)) >= 0.01 THEN
      v_issue := 'row_arithmetic';
      v_issues := v_issues || jsonb_build_object(
        'kind', v_issue, 'row_id', v_row.id, 'at', v_row.created_at,
        'amount', v_row.closing_balance - (v_row.opening_balance + v_row.interest_accrued - v_row.amount_deducted),
        'detail', 'Opening + penalty - deducted does not equal closing');
    END IF;

    v_statement_deducted := v_statement_deducted + v_row.amount_deducted;
    v_penalty := v_penalty + v_row.interest_accrued;
    v_prev_close := v_row.closing_balance;
    v_last_close := v_row.closing_balance;

    v_rows := v_rows || jsonb_build_object(
      'id', v_row.id,
      'at', v_row.created_at,
      'day', (v_row.created_at AT TIME ZONE 'Africa/Kampala')::date,
      'opening_balance', v_row.opening_balance,
      'penalty', v_row.interest_accrued,
      'deducted', v_row.amount_deducted,
      'closing_balance', v_row.closing_balance,
      'status', v_row.deduction_status,
      'source', v_row.recovery_source,
      'wallet_entry_id', v_match,
      'issue', v_issue);
  END LOOP;

  v_total_repayable := coalesce(v_total_repayable, v_adv.principal + coalesce(v_adv.access_fee, 0));

  -- Wallet debits booked to this advance that no statement row (on any of the
  -- agent's advances) accounts for.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'kind', 'wallet_debit_without_statement_row', 'wallet_entry_id', g.id,
           'at', g.created_at, 'amount', g.amount,
           'detail', 'Wallet was debited for this advance but the statement has no matching row')
         ORDER BY g.created_at), '[]'::jsonb)
  INTO v_orphans
  FROM public.general_ledger g
  WHERE g.user_id = v_adv.agent_id
    AND g.ledger_scope = 'wallet'
    AND g.direction = 'cash_out'
    AND g.category IN ('agent_repayment', 'agent_advance_repayment')
    AND g.source_id = p_advance_id
    AND NOT (g.id = ANY (v_used))
    AND NOT EXISTS (
      SELECT 1 FROM public.agent_advance_ledger l
      JOIN public.agent_advances a2 ON a2.id = l.advance_id
      WHERE a2.agent_id = v_adv.agent_id
        AND l.advance_id <> p_advance_id
        AND l.amount_deducted = g.amount
        AND l.created_at BETWEEN g.created_at - interval '3 seconds' AND g.created_at + interval '3 seconds');
  v_issues := v_issues || v_orphans;

  IF v_last_close IS NOT NULL AND abs(v_last_close - v_adv.outstanding_balance) >= 0.01
     AND v_adv.status <> 'cancelled' THEN
    v_issues := v_issues || jsonb_build_object(
      'kind', 'statement_vs_outstanding', 'at', now(),
      'amount', v_adv.outstanding_balance - v_last_close,
      'detail', 'Statement ends at ' || v_last_close || ' but the advance shows ' || v_adv.outstanding_balance);
  END IF;

  SELECT coalesce(jsonb_agg(d ORDER BY d->>'day'), '[]'::jsonb) INTO v_days
  FROM (
    SELECT jsonb_build_object(
      'day', r->>'day',
      'deductions', count(*) FILTER (WHERE (r->>'deducted')::numeric > 0),
      'wallet_deducted', sum(CASE WHEN r->>'wallet_entry_id' IS NOT NULL THEN (r->>'deducted')::numeric ELSE 0 END),
      'statement_deducted', sum((r->>'deducted')::numeric),
      'penalty', sum((r->>'penalty')::numeric),
      'closing_balance', (array_agg((r->>'closing_balance')::numeric ORDER BY (r->>'at')::timestamptz DESC))[1]
    ) AS d
    FROM jsonb_array_elements(v_rows) r
    GROUP BY r->>'day'
  ) x;

  RETURN jsonb_build_object(
    'advance', jsonb_build_object(
      'id', v_adv.id,
      'agent_id', v_adv.agent_id,
      'agent_name', v_adv.full_name,
      'agent_phone', v_adv.phone,
      'status', v_adv.status,
      'issued_at', coalesce(v_adv.issued_at, v_adv.created_at),
      'expires_at', v_adv.expires_at,
      'principal', v_adv.principal,
      'access_fee', v_adv.access_fee,
      'total_repayable', v_total_repayable,
      'daily_installment', v_adv.daily_installment,
      'outstanding_balance', v_adv.outstanding_balance,
      'arrears_balance', v_adv.arrears_balance),
    'totals', jsonb_build_object(
      'statement_deducted', v_statement_deducted,
      'wallet_deducted', v_wallet_backed,
      'wallet_deduction_count', coalesce(array_length(v_used, 1), 0),
      'penalty', v_penalty,
      'statement_closing', v_last_close,
      'issue_count', jsonb_array_length(v_issues),
      'reconciled', jsonb_array_length(v_issues) = 0),
    'days', v_days,
    'issues', v_issues,
    'rows', v_rows);
END;
$function$;

-- Badge data for the CFO Advances table: one call for the visible page.
CREATE OR REPLACE FUNCTION public.get_advance_reconciliation_summary(p_advance_ids uuid[])
RETURNS TABLE (advance_id uuid, issue_count integer, wallet_deducted numeric, statement_deducted numeric, reconciled boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_r jsonb;
BEGIN
  IF coalesce(array_length(p_advance_ids, 1), 0) > 100 THEN
    RAISE EXCEPTION 'At most 100 advances per call';
  END IF;
  FOREACH v_id IN ARRAY coalesce(p_advance_ids, '{}') LOOP
    v_r := public.get_advance_wallet_reconciliation(v_id);
    advance_id := v_id;
    issue_count := (v_r->'totals'->>'issue_count')::int;
    wallet_deducted := (v_r->'totals'->>'wallet_deducted')::numeric;
    statement_deducted := (v_r->'totals'->>'statement_deducted')::numeric;
    reconciled := (v_r->'totals'->>'reconciled')::boolean;
    RETURN NEXT;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_advance_wallet_reconciliation(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_advance_reconciliation_summary(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_advance_wallet_reconciliation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_advance_reconciliation_summary(uuid[]) TO authenticated;
